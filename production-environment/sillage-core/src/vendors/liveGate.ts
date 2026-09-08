/**
 * Interval gates on live vendor API usage (call-based, not a daily download cap).
 *
 * wholesale-perfumes catalogue is gated by `live_feed_min_minutes` since last catalog fetch.
 * The hourly store XML uses a separate gate so fast syncs are not blocked by the catalog cap.
 */
import { sil } from "../config/env.ts";
import { query, type RowDataPacket } from "../db/pool.ts";
import { loadSettings, loadVendor, setSetting } from "../db/settings.ts";
import { logger } from "../lib/log.ts";
import type { CacheVendor } from "./feedCache.ts";
import {
  legacyLiveMaxSettingKey,
  resolveLiveMaxPerDay,
  resolveWholesalePerfumesStoreLimits,
} from "./liveLimits.ts";

const log = logger("live-gate");

export interface LiveGateResult {
  allow: boolean;
  reason: string;
  /** Minutes until the next live fetch is permitted (0 if allowed). */
  retryInMinutes: number;
}

function lastKey(vendor: CacheVendor): string {
  return `last_live_fetch_${vendor}`;
}

async function readSettingNum(key: string): Promise<number | null> {
  const [row] = await query<RowDataPacket & { setting_value: string }>(
    `SELECT setting_value FROM ${sil("sil_settings")} WHERE setting_key = ?`,
    [key],
  );
  if (!row) return null;
  const n = Number(row.setting_value);
  return Number.isFinite(n) ? n : null;
}

async function catalogueMaxPerDay(vendor: CacheVendor): Promise<number> {
  let vendorRow: Awaited<ReturnType<typeof loadVendor>> | null = null;
  try {
    vendorRow = await loadVendor(vendor);
  } catch {
    vendorRow = null;
  }
  const legacy = await readSettingNum(legacyLiveMaxSettingKey(vendor));
  return resolveLiveMaxPerDay(vendor, vendorRow, legacy);
}

/** Exported for the live-status dashboard endpoint. */
export async function resolveVendorLiveMaxPerDay(vendor: CacheVendor): Promise<number> {
  return catalogueMaxPerDay(vendor);
}

export async function checkLiveGate(vendor: CacheVendor): Promise<LiveGateResult> {
  const settings = await loadSettings();
  const minMinutes = settings.liveFeedMinMinutes;

  const [lastRow] = await query<RowDataPacket & { setting_value: string }>(
    `SELECT setting_value FROM ${sil("sil_settings")} WHERE setting_key = ?`,
    [lastKey(vendor)],
  );
  const lastIso = lastRow?.setting_value ?? null;
  if (lastIso) {
    const elapsed = Math.floor((Date.now() - new Date(lastIso).getTime()) / 60_000);
    if (elapsed < minMinutes) {
      return {
        allow: false,
        reason: `${vendor} live fetch blocked: only ${elapsed} min since last download (min ${minMinutes})`,
        retryInMinutes: minMinutes - elapsed,
      };
    }
  }

  return { allow: true, reason: "live allowed", retryInMinutes: 0 };
}

/** Record a successful live download so the gate and daily counter advance. */
export async function recordLiveFetch(vendor: CacheVendor): Promise<void> {
  const now = new Date().toISOString();
  await setSetting(lastKey(vendor), now);
  const dayKey = `live_fetch_count_${vendor}_${now.slice(0, 10)}`;
  const [row] = await query<RowDataPacket & { setting_value: string }>(
    `SELECT setting_value FROM ${sil("sil_settings")} WHERE setting_key = ?`,
    [dayKey],
  );
  const next = String(Number(row?.setting_value ?? 0) + 1);
  await setSetting(dayKey, next);
  log.info(`${vendor}: recorded live fetch (#${next} today)`);
}

/**
 * Resolve what a connector should actually hit.
 * `forceLive` bypasses the gate (CLI escape hatch only — still records the fetch).
 *
 * When live is gated we return `blocked` — callers must not silently fall back to disk.
 * Explicit `source=cache` / rewrite-only paths read the feed file without this helper.
 */
export async function resolveLiveOrCache(
  vendor: CacheVendor,
  requested: "live" | "local",
  forceLive = false,
): Promise<{ mode: "live" | "blocked" | "local"; gate: LiveGateResult | null }> {
  if (requested === "local") {
    return { mode: "local", gate: null };
  }
  if (forceLive) {
    return { mode: "live", gate: { allow: true, reason: "forceLive", retryInMinutes: 0 } };
  }
  const gate = await checkLiveGate(vendor);
  if (gate.allow) return { mode: "live", gate };
  log.warn(gate.reason);
  return { mode: "blocked", gate };
}

async function liveFetchesUsedToday(vendor: CacheVendor): Promise<number> {
  const day = new Date().toISOString().slice(0, 10);
  const n = await readSettingNum(`live_fetch_count_${vendor}_${day}`);
  return n ?? 0;
}

export type StorefrontLiveCooldown = {
  allow: boolean;
  anyAllow: boolean;
  retryInMinutes: number;
  reason: string;
  cooldownMinutes: number;
  nextAllowedAt: string | null;
  wholesalePerfumes: LiveGateResult & { maxPerDay: number; usedToday: number };
};

/**
 * Call-interval for this shop: wholesale-perfumes hourly store feed (price/stock).
 */
export async function getStorefrontLiveCooldown(): Promise<StorefrontLiveCooldown> {
  const settings = await loadSettings();
  const cooldownMinutes = settings.liveFeedMinMinutes;
  const [storeGate, catalogMax, catalogUsed] = await Promise.all([
    checkWholesalePerfumesStoreGate(),
    catalogueMaxPerDay("wholesale-perfumes"),
    liveFetchesUsedToday("wholesale-perfumes"),
  ]);
  const nextAllowedAt =
    storeGate.allow || storeGate.retryInMinutes <= 0
      ? null
      : new Date(Date.now() + storeGate.retryInMinutes * 60_000).toISOString();
  return {
    allow: storeGate.allow,
    anyAllow: storeGate.allow,
    retryInMinutes: storeGate.allow ? 0 : storeGate.retryInMinutes,
    reason: storeGate.reason,
    cooldownMinutes,
    nextAllowedAt,
    wholesalePerfumes: { ...storeGate, maxPerDay: catalogMax, usedToday: catalogUsed },
  };
}

/**
 * Separate gate for wholesale-perfumes hourly store (price/stock) feed. Must not share the
 * catalog's once-per-day cap, or fast syncs would stall after the first catalog pull.
 */
export async function checkWholesalePerfumesStoreGate(): Promise<LiveGateResult> {
  let vendorRow: Awaited<ReturnType<typeof loadVendor>> | null = null;
  try {
    vendorRow = await loadVendor("wholesale-perfumes");
  } catch {
    vendorRow = null;
  }
  const { minMinutes } = resolveWholesalePerfumesStoreLimits(vendorRow);

  const [lastRow] = await query<RowDataPacket & { setting_value: string }>(
    `SELECT setting_value FROM ${sil("sil_settings")} WHERE setting_key = ?`,
    ["last_live_fetch_wholesale-perfumes_store"],
  );
  const lastIso = lastRow?.setting_value ?? null;
  if (lastIso) {
    const elapsed = Math.floor((Date.now() - new Date(lastIso).getTime()) / 60_000);
    if (elapsed < minMinutes) {
      return {
        allow: false,
        reason: `wholesale-perfumes store live fetch blocked: only ${elapsed} min since last download (min ${minMinutes})`,
        retryInMinutes: minMinutes - elapsed,
      };
    }
  }

  return { allow: true, reason: "live allowed", retryInMinutes: 0 };
}

export async function recordWholesalePerfumesStoreFetch(): Promise<void> {
  const now = new Date().toISOString();
  await setSetting("last_live_fetch_wholesale-perfumes_store", now);
  const dayKey = `live_fetch_count_wholesale-perfumes_store_${now.slice(0, 10)}`;
  const [row] = await query<RowDataPacket & { setting_value: string }>(
    `SELECT setting_value FROM ${sil("sil_settings")} WHERE setting_key = ?`,
    [dayKey],
  );
  const next = String(Number(row?.setting_value ?? 0) + 1);
  await setSetting(dayKey, next);
  log.info(`wholesale-perfumes_store: recorded live fetch (#${next} today)`);
}

/** Wall-clock half-hour slots (:00–:04 and :30–:34). Cron ticks every 5 min; only these open sync. */
export function inHalfHourSlot(minuteOfHour: number): boolean {
  const m = Math.trunc(minuteOfHour);
  return (m >= 0 && m < 5) || (m >= 30 && m < 35);
}
