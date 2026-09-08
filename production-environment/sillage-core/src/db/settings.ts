import { sil } from "../config/env.ts";
import { logger } from "../lib/log.ts";
import { resolveTimeZone } from "../lib/timezone.ts";
import { parsePriceTiers, type PriceTier } from "../sync/pricing.ts";
import { execute, query, type RowDataPacket } from "./pool.ts";

const log = logger("settings");

interface SettingRow extends RowDataPacket {
  setting_key: string;
  setting_value: string;
}

export interface VendorRow extends RowDataPacket {
  id: number;
  slug: string;
  name: string;
  storefront_label: string | null;
  sku_prefix: string;
  currency: string;
  fx_rate: string;
  vat_rate: string | number | null;
  price_multiplier: string | null;
  min_visible_stock: number | null;
  serviceable_countries: string | string[];
  order_config: string | Record<string, unknown> | null;
  active: number;
  live_max_per_day: number | null;
  store_live_max_per_day: number | null;
  store_live_min_minutes: number | null;
}

export interface Vendor {
  id: number;
  slug: string;
  name: string;
  /** Customer-facing label (LPS01 / LPS02 / LPS03). Falls back to name when unset. */
  storefrontLabel: string;
  skuPrefix: string;
  currency: string;
  fxRate: number;
  /** Fraction uplift before markup. 0 for BF/BTS; wholesale-perfumes may need a confirmed rate. */
  vatRate: number;
  priceMultiplier: number | null;
  minVisibleStock: number | null;
  serviceableCountries: string[];
  orderConfig: Record<string, unknown>;
  active: boolean;
  /** Max live catalogue downloads per day; null = legacy setting / default. */
  liveMaxPerDay: number | null;
  /** Secondary feed (wholesale-perfumes store XML) daily cap. */
  storeLiveMaxPerDay: number | null;
  /** Secondary feed min interval minutes. */
  storeLiveMinMinutes: number | null;
}

export interface GlobalSettings {
  priceMultiplier: number;
  /** Cost bands; empty = use priceMultiplier only. */
  priceTiers: PriceTier[];
  stockThreshold: number;
  maxRrpRatio: number;
  dedupeByEan: boolean;
  primaryOfferStrategy: "cheapest" | "most_stock";
  descriptionMode: "none" | "template";
  /** exact = every ml term; ranges = buckets; off = hide volume facet. */
  volumeFilterMode: "exact" | "ranges" | "off";
  /** Minimum minutes between live vendor catalogue downloads. Cache is used otherwise. */
  liveFeedMinMinutes: number;
  writeBatchSize: number;
  maxStatementBytes: number;
  syncEnabled: boolean;
  fastSyncMinutes: number;
  fullSyncEnabled: boolean;
  /**
   * Hour of day, 0–23, in `scheduleTimezone` (not raw MariaDB UTC).
   * Scheduler converts “today at H:00” in that zone to a UTC instant.
   */
  fullSyncHour: number;
  /** IANA zone for full-sync hour + dashboard clocks. Default UTC. */
  scheduleTimezone: string;
  syncSource: "live" | "local";
  /** Exclude products whose resolved image is still a placeholder. */
  hideProductsWithoutImage: boolean;
  /**
   * Public origin for self-hosted product images (no trailing slash).
   * Tools that write image_overrides.json should emit `{base}/{file}`; product rows
   * still store absolute URLs. Changing this alone does not rewrite WooCommerce.
   */
  imageCdnBaseUrl: string;
  /**
   * Public shop origin (no trailing slash). Used for WooCommerce admin links and
   * customer tracking pushes. Env `WP_BASE_URL` is the bootstrap default; Settings
   * overrides at runtime. In-Docker finalize uses `WORDPRESS_INTERNAL_URL`.
   */
  wpBaseUrl: string;
  /** Foodpanda-style small-order fee on the storefront (bridge reads these). */
  cartMinEnabled: boolean;
  cartMinSubtotalEur: number;
  cartMinFeeEur: number;
  /** Must contain `{remaining}`; bridge substitutes a WooCommerce-formatted amount. */
  cartMinMessage: string;
  /** Line-item label for the cart fee (bridge falls back to "Small order fee" if blank). */
  cartMinFeeLabel: string;
  ordersDryRun: boolean;
  ordersAutoDispatch: boolean;
  ordersMaxValueEur: number;
  ordersDailyCapEur: number;
  ordersPollMinutes: number;
  ordersNotifyCustomer: boolean;
}

/** MariaDB returns JSON columns as either a string or a parsed value depending on driver mode. */
function parseJson<T>(value: unknown, fallback: T): T {
  if (value === null || value === undefined) return fallback;
  if (typeof value === "string") {
    try {
      return JSON.parse(value) as T;
    } catch {
      return fallback;
    }
  }
  return value as T;
}

export async function loadSettings(): Promise<GlobalSettings> {
  const rows = await query<SettingRow>(`SELECT setting_key, setting_value FROM ${sil("sil_settings")}`);
  const map = new Map(rows.map((r) => [r.setting_key, r.setting_value]));

  const num = (key: string, fallback: number): number => {
    const v = map.get(key);
    if (v === undefined) return fallback;
    const n = Number(v);
    return Number.isFinite(n) ? n : fallback;
  };
  const flag = (key: string, fallback: boolean): boolean => {
    const v = map.get(key);
    return v === undefined ? fallback : v === "1" || v === "true";
  };

  const tiersParsed = parsePriceTiers(map.get("price_tiers") ?? "[]");
  for (const w of tiersParsed.warnings) log.warn(w);

  return {
    priceMultiplier: num("global_price_multiplier", 1),
    priceTiers: tiersParsed.tiers,
    stockThreshold: num("global_stock_threshold", 0),
    maxRrpRatio: num("max_rrp_ratio", 10),
    dedupeByEan: flag("dedupe_by_ean", true),
    primaryOfferStrategy: (map.get("primary_offer_strategy") as GlobalSettings["primaryOfferStrategy"]) ?? "cheapest",
    descriptionMode: (map.get("description_mode") as GlobalSettings["descriptionMode"]) ?? "none",
    volumeFilterMode: (map.get("volume_filter_mode") as GlobalSettings["volumeFilterMode"]) ?? "ranges",
    liveFeedMinMinutes: num("live_feed_min_minutes", 60),
    writeBatchSize: num("write_batch_size", 500),
    maxStatementBytes: num("max_statement_bytes", 4_194_304),
    syncEnabled: flag("sync_enabled", true),
    fastSyncMinutes: num("fast_sync_minutes", 30),
    fullSyncEnabled: flag("full_sync_enabled", true),
    fullSyncHour: num("full_sync_hour", 3),
    scheduleTimezone: (() => {
      const raw = (map.get("schedule_timezone") ?? "").trim();
      const resolved = resolveTimeZone(raw || "UTC");
      if (raw && resolved !== raw) log.warn(`invalid schedule_timezone "${raw}", using ${resolved}`);
      return resolved;
    })(),
    syncSource: (map.get("sync_source") as GlobalSettings["syncSource"]) ?? "live",
    hideProductsWithoutImage: flag("hide_products_without_image", true),
    imageCdnBaseUrl: (() => {
      const fromDb = (map.get("image_cdn_base_url") ?? "").trim().replace(/\/$/, "");
      if (fromDb) return fromDb;
      const fromEnv = (
        process.env.LPS_MEDIA_BASE_URL ??
        process.env.IMAGE_HOST_BASE_URL ??
        process.env.PUBLIC_URL_BASE ??
        ""
      )
        .trim()
        .replace(/\/$/, "");
      return fromEnv || "https://images.prinscosmetic.eu";
    })(),
    wpBaseUrl: (() => {
      const fromDb = (map.get("wp_base_url") ?? "").trim().replace(/\/$/, "");
      if (fromDb) return fromDb;
      return (process.env.WP_BASE_URL ?? "http://localhost").trim().replace(/\/$/, "");
    })(),
    cartMinEnabled: flag("cart_min_enabled", false),
    cartMinSubtotalEur: num("cart_min_subtotal_eur", 50),
    cartMinFeeEur: num("cart_min_fee_eur", 5),
    cartMinMessage:
      map.get("cart_min_message") ??
      "Add {remaining} more to your order to remove the small-order fee.",
    cartMinFeeLabel: (() => {
      const label = (map.get("cart_min_fee_label") ?? "").trim();
      return label || "Small order fee";
    })(),
    ordersDryRun: flag("orders_dry_run", true),
    ordersAutoDispatch: flag("orders_auto_dispatch", false),
    ordersMaxValueEur: num("orders_max_value_eur", 500),
    ordersDailyCapEur: num("orders_daily_cap_eur", 2000),
    ordersPollMinutes: num("orders_poll_minutes", 15),
    ordersNotifyCustomer: flag("orders_notify_customer", true),
  };
}

export async function setSetting(key: string, value: string): Promise<void> {
  await execute(
    `INSERT INTO ${sil("sil_settings")} (setting_key, setting_value) VALUES (?, ?)
     ON DUPLICATE KEY UPDATE setting_value = VALUES(setting_value)`,
    [key, value],
  );
}

function toVendor(row: VendorRow): Vendor {
  const label = (row.storefront_label ?? "").trim();
  const intOrNull = (v: number | null | undefined): number | null => {
    if (v === null || v === undefined) return null;
    const n = Number(v);
    return Number.isFinite(n) ? Math.trunc(n) : null;
  };
  return {
    id: row.id,
    slug: row.slug,
    name: row.name,
    storefrontLabel: label || row.name,
    skuPrefix: row.sku_prefix,
    currency: row.currency,
    fxRate: Number(row.fx_rate),
    vatRate: Number(row.vat_rate ?? 0) || 0,
    priceMultiplier: row.price_multiplier === null ? null : Number(row.price_multiplier),
    minVisibleStock: row.min_visible_stock,
    serviceableCountries: parseJson<string[]>(row.serviceable_countries, []),
    orderConfig: parseJson<Record<string, unknown>>(row.order_config, {}),
    active: row.active === 1,
    // Pre-014 rows (or SELECT * before migrate) may omit these columns.
    liveMaxPerDay: intOrNull(row.live_max_per_day),
    storeLiveMaxPerDay: intOrNull(row.store_live_max_per_day),
    storeLiveMinMinutes: intOrNull(row.store_live_min_minutes),
  };
}

export async function loadVendors(): Promise<Vendor[]> {
  const rows = await query<VendorRow>(`SELECT * FROM ${sil("sil_vendors")} ORDER BY id`);
  return rows.map(toVendor);
}

export async function loadVendor(slug: string): Promise<Vendor> {
  const rows = await query<VendorRow>(`SELECT * FROM ${sil("sil_vendors")} WHERE slug = ?`, [slug]);
  const row = rows[0];
  if (!row) throw new Error(`Vendor "${slug}" is not registered in sil_vendors`);
  return toVendor(row);
}

export async function updateVendor(
  slug: string,
  patch: Partial<
    Pick<
      Vendor,
      | "storefrontLabel"
      | "priceMultiplier"
      | "minVisibleStock"
      | "active"
      | "fxRate"
      | "vatRate"
      | "liveMaxPerDay"
      | "storeLiveMaxPerDay"
      | "storeLiveMinMinutes"
    >
  > & {
    serviceableCountries?: string[];
    orderConfig?: Record<string, unknown>;
  },
): Promise<void> {
  const sets: string[] = [];
  const params: unknown[] = [];

  if (patch.storefrontLabel !== undefined) {
    sets.push("storefront_label = ?");
    params.push(patch.storefrontLabel);
  }
  if (patch.priceMultiplier !== undefined) {
    sets.push("price_multiplier = ?");
    params.push(patch.priceMultiplier);
  }
  if (patch.minVisibleStock !== undefined) {
    sets.push("min_visible_stock = ?");
    params.push(patch.minVisibleStock);
  }
  if (patch.active !== undefined) {
    sets.push("active = ?");
    params.push(patch.active ? 1 : 0);
  }
  if (patch.fxRate !== undefined) {
    sets.push("fx_rate = ?");
    params.push(patch.fxRate);
  }
  if (patch.vatRate !== undefined) {
    sets.push("vat_rate = ?");
    params.push(patch.vatRate);
  }
  if (patch.serviceableCountries !== undefined) {
    sets.push("serviceable_countries = ?");
    params.push(JSON.stringify(patch.serviceableCountries));
  }
  if (patch.orderConfig !== undefined) {
    sets.push("order_config = ?");
    params.push(JSON.stringify(patch.orderConfig));
  }
  if (patch.liveMaxPerDay !== undefined) {
    sets.push("live_max_per_day = ?");
    params.push(patch.liveMaxPerDay);
  }
  if (patch.storeLiveMaxPerDay !== undefined) {
    sets.push("store_live_max_per_day = ?");
    params.push(patch.storeLiveMaxPerDay);
  }
  if (patch.storeLiveMinMinutes !== undefined) {
    sets.push("store_live_min_minutes = ?");
    params.push(patch.storeLiveMinMinutes);
  }
  if (sets.length === 0) return;

  params.push(slug);
  await execute(`UPDATE ${sil("sil_vendors")} SET ${sets.join(", ")} WHERE slug = ?`, params);
}

export async function recordEvent(
  level: "debug" | "info" | "warn" | "error",
  scope: string,
  message: string,
  context?: unknown,
  runId?: number,
): Promise<void> {
  await execute(
    `INSERT INTO ${sil("sil_events")} (level, scope, message, context, run_id) VALUES (?, ?, ?, ?, ?)`,
    [level, scope, message.slice(0, 1000), context === undefined ? null : JSON.stringify(context), runId ?? null],
  );
}
