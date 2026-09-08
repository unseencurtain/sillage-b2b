/**
 * Authenticated dashboard API. The single source of truth for configuration and ops actions.
 */
import { Hono } from "hono";
import { env, sil, wp } from "../../config/env.ts";
import { applyRuntimeUrls } from "../../config/env.ts";
import { clearSecret, listSecretStatus, loadSecretsOverlay, setSecret } from "../../config/secrets.ts";
import { execute, query, type RowDataPacket } from "../../db/pool.ts";
import { loadSettings, loadVendor, loadVendors, recordEvent, setSetting, updateVendor } from "../../db/settings.ts";
import { logger } from "../../lib/log.ts";
import { resolveTimeZone } from "../../lib/timezone.ts";
import { displayedShopImage, isUnusableImage, shopVisibility } from "../../sync/imageRules.ts";
import { loadImageOverrides, normalizeEan, resolveImageUrl } from "../../sync/images.ts";
import {
  loadCompanyBilling,
  parseCompanyBilling,
  parseOrderAddress,
  resolveBillingAddress,
  resolveDeliveryAddress,
  saveCompanyBilling,
} from "../../orders/addresses.ts";
import { destinationAddress, readWooOrder } from "../../orders/ingest.ts";
import { approveVendorOrder, dispatchVendorOrder } from "../../orders/dispatch.ts";
import { maybeCompleteWooOrder } from "../../orders/tracking.ts";
import { clearSyncAbort, requestSyncAbort } from "../../sync/abort.ts";
import { parsePriceTiers } from "../../sync/pricing.ts";
import { markAllPricesDirty, markAllProductsDirty, runSync } from "../../sync/run.ts";
import {
  isCatalogueRebuildPending,
  isSyncLockHeld,
  kickContentRewrite,
  kickPriceRewrite,
  queueCatalogueRebuild,
} from "../../sync/pendingRewrite.ts";
import type { OrderAddress } from "../../orders/types.ts";
import { getStorefrontLiveCooldown } from "../../vendors/liveGate.ts";
import { parseVendorPatch } from "../../vendors/validateVendorPatch.ts";
import { isParkedVendor, storefrontVendorSlugs } from "../../vendors/registry.ts";
import { isWholesaleProfile } from "../../storefront/profile.ts";
import { requireSession, type AuthEnv } from "../auth.ts";

const log = logger("api");

function parseRunStats(raw: unknown): {
  fetchedByVendor?: Record<string, number>;
  skippedVendors?: string[];
} {
  if (!raw) return {};
  try {
    const parsed = typeof raw === "string" ? JSON.parse(raw) : raw;
    if (!parsed || typeof parsed !== "object") return {};
    const obj = parsed as {
      fetchedByVendor?: Record<string, number>;
      skippedVendors?: string[];
    };
    return {
      fetchedByVendor: obj.fetchedByVendor,
      skippedVendors: obj.skippedVendors,
    };
  } catch {
    return {};
  }
}

function decorateSyncRun(row: RowDataPacket) {
  const extra = parseRunStats(row.stats);
  const { stats: _stats, ...rest } = row;
  void _stats;
  return {
    ...rest,
    fetched_by_vendor: extra.fetchedByVendor ?? null,
    skipped_vendors: extra.skippedVendors ?? [],
  };
}

function offerEans(row: RowDataPacket): string[] {
  const collected: string[] = [];
  const raw = row.eans;
  if (Array.isArray(raw)) {
    for (const v of raw) if (typeof v === "string" && v) collected.push(v);
  } else if (typeof raw === "string" && raw.trim()) {
    try {
      const parsed = JSON.parse(raw) as unknown;
      if (Array.isArray(parsed)) {
        for (const v of parsed) if (typeof v === "string" && v) collected.push(v);
      }
    } catch {
      /* ignore malformed JSON */
    }
  }
  if (typeof row.primary_ean === "string" && row.primary_ean) collected.push(row.primary_ean);
  return collected;
}

async function loadUsableImagesForEans(eans: string[]): Promise<Map<string, string>> {
  const unique = [
    ...new Set(
      eans.flatMap((raw) => {
        const trimmed = raw.trim();
        const norm = normalizeEan(trimmed);
        return [trimmed, norm].filter((v): v is string => Boolean(v));
      }),
    ),
  ];
  const map = new Map<string, string>();
  if (unique.length === 0) return map;
  const rows = await query<RowDataPacket & { primary_ean: string | null; image_url: string | null }>(
    `SELECT primary_ean, image_url FROM ${sil("sil_offers")}
      WHERE vanished_at IS NULL
        AND primary_ean IN (${unique.map(() => "?").join(",")})
        AND image_url IS NOT NULL AND image_url != ''`,
    unique,
  );
  for (const row of rows) {
    const ean = normalizeEan(row.primary_ean);
    if (!ean || isUnusableImage(row.image_url) || map.has(ean)) continue;
    map.set(ean, row.image_url!);
  }
  return map;
}

async function hasSuccessfulCatalogue(): Promise<boolean> {
  const rows = await query<RowDataPacket & { n: number }>(
    `SELECT COUNT(*) AS n FROM ${sil("sil_sync_runs")}
      WHERE mode = 'full' AND status IN ('success','partial')`,
  );
  return Number(rows[0]?.n ?? 0) > 0;
}

export const api = new Hono<AuthEnv>();
api.use("*", requireSession);

api.get("/overview", async (c) => {
  const settings = await loadSettings();
  // Shop loop ≈ publish AND NOT exclude-from-catalog (same rule as recountTerms).
  // "Published" alone overstates what customers see when hide-without-image / stock
  // threshold attach those visibility terms.
  //
  // The hide reasons are counted from `_external_thumbnail_url` — the photo the shop prints — and
  // not from sil_offers.image_url. A non-empty vendor URL is not a photo: `isUnusableImage` still
  // rejects placeholders and non-http junk, and the writer resolves overrides and other offers
  // before deciding. Restating that rule as one SQL predicate is an approximation, and on the retail
  // shop the same code reported 675 products hidden for a missing photo against a real 12,003,
  // leaving 9,129 hidden products attributed to no reason at all.
  //
  // The thumbnail meta cannot drift like that, because the writer has already applied the rule when
  // it set the value: a usable URL, or empty. So this is the writer's own verdict read back, and it
  // agrees exactly with the `hiddenNoImage` a sync run reports.
  const [offerRows, productRows, catalogRows, lastSync, orderRows] = await Promise.all([
    query<RowDataPacket & { offers: number }>(`SELECT COUNT(*) AS offers FROM ${sil("sil_offers")} WHERE vanished_at IS NULL`),
    query<RowDataPacket & { products: number }>(`SELECT COUNT(*) AS products FROM ${sil("sil_products")}`),
    query<
      RowDataPacket & {
        published: number;
        catalog_visible: number;
        hidden_from_catalog: number;
        out_of_stock: number;
        hidden_no_image: number;
        hidden_stock: number;
        hidden_operator: number;
      }
    >(
      `SELECT
         COUNT(*) AS published,
         SUM(CASE WHEN cat.object_id IS NULL THEN 1 ELSE 0 END) AS catalog_visible,
         SUM(CASE WHEN cat.object_id IS NOT NULL THEN 1 ELSE 0 END) AS hidden_from_catalog,
         SUM(CASE WHEN oos.object_id IS NOT NULL THEN 1 ELSE 0 END) AS out_of_stock,
         SUM(CASE
               WHEN cat.object_id IS NOT NULL
                AND IFNULL(sp.operator_hidden, 0) = 1 THEN 1
               ELSE 0
             END) AS hidden_operator,
         SUM(CASE
               WHEN cat.object_id IS NOT NULL
                AND IFNULL(sp.operator_hidden, 0) = 0
                AND (thumb.meta_value IS NULL OR TRIM(thumb.meta_value) = '') THEN 1
               ELSE 0
             END) AS hidden_no_image,
         SUM(CASE
               WHEN cat.object_id IS NOT NULL
                AND IFNULL(sp.operator_hidden, 0) = 0
                AND thumb.meta_value IS NOT NULL AND TRIM(thumb.meta_value) != ''
                AND oos.object_id IS NOT NULL THEN 1
               ELSE 0
             END) AS hidden_stock
       FROM ${wp("posts")} p
       LEFT JOIN ${sil("sil_products")} sp ON sp.wp_post_id = p.ID
       LEFT JOIN ${wp("postmeta")} thumb
              ON thumb.post_id = p.ID AND thumb.meta_key = '_external_thumbnail_url'
       LEFT JOIN (
         SELECT tr.object_id
           FROM ${wp("term_relationships")} tr
           JOIN ${wp("term_taxonomy")} tt ON tt.term_taxonomy_id = tr.term_taxonomy_id
           JOIN ${wp("terms")} t ON t.term_id = tt.term_id
          WHERE tt.taxonomy = 'product_visibility' AND t.slug = 'exclude-from-catalog'
       ) cat ON cat.object_id = p.ID
       LEFT JOIN (
         SELECT tr.object_id
           FROM ${wp("term_relationships")} tr
           JOIN ${wp("term_taxonomy")} tt ON tt.term_taxonomy_id = tr.term_taxonomy_id
           JOIN ${wp("terms")} t ON t.term_id = tt.term_id
          WHERE tt.taxonomy = 'product_visibility' AND t.slug = 'outofstock'
       ) oos ON oos.object_id = p.ID
      WHERE p.post_type = 'product' AND p.post_status = 'publish'`,
    ),
    query<RowDataPacket>(
      `SELECT id, mode, source, status, duration_ms, products_fetched, posts_created, posts_updated,
              prices_updated, products_vanished, errors, started_at, finished_at, stats
         FROM ${sil("sil_sync_runs")} ORDER BY id DESC LIMIT 1`,
    ),
    query<RowDataPacket & { status: string; n: number }>(
      `SELECT status, COUNT(*) AS n FROM ${sil("sil_vendor_orders")} GROUP BY status`,
    ),
  ]);

  const syncs = await query<RowDataPacket & { day: string; n: number }>(
    `SELECT DATE(started_at) AS day, COUNT(*) AS n
       FROM ${sil("sil_sync_runs")}
      WHERE started_at >= CURDATE() - INTERVAL 7 DAY
      GROUP BY DATE(started_at) ORDER BY day`,
  );

  const ordersByStatus: Record<string, number> = {};
  for (const r of orderRows) ordersByStatus[r.status] = Number(r.n);

  const cat = catalogRows[0];
  const published = Number(cat?.published ?? 0);
  const catalogVisible = Number(cat?.catalog_visible ?? 0);
  const hiddenFromCatalog = Number(cat?.hidden_from_catalog ?? 0);

  return c.json({
    offers: Number(offerRows[0]?.offers ?? 0),
    products: Number(productRows[0]?.products ?? 0),
    /** @deprecated Prefer catalogVisible — publish status alone includes catalog-excluded posts. */
    published,
    catalogVisible,
    hiddenFromCatalog,
    outOfStock: Number(cat?.out_of_stock ?? 0),
    /** Exclusive hide reason (writer order): no/weak image, including those also OOS. */
    hiddenNoImage: Number(cat?.hidden_no_image ?? 0),
    /** Exclusive hide reason: usable image, out of stock / below threshold. */
    hiddenStock: Number(cat?.hidden_stock ?? 0),
    /** Exclusive hide reason: operator Keep hidden. */
    hiddenOperator: Number(cat?.hidden_operator ?? 0),
    lastSync: lastSync[0] ? decorateSyncRun(lastSync[0]) : null,
    ordersByStatus,
    syncsLast7Days: syncs.map((s) => ({ day: String(s.day), n: Number(s.n) })),
    settings: {
      dryRun: settings.ordersDryRun,
      autoDispatch: settings.ordersAutoDispatch,
      syncEnabled: settings.syncEnabled,
      hideProductsWithoutImage: settings.hideProductsWithoutImage,
      stockThreshold: settings.stockThreshold,
      scheduleTimezone: settings.scheduleTimezone,
    },
    // Whether this is the development box. It is restored from a production pack, so the two
    // wholesale shops are identical down to the catalogue; the dashboard has to say which one you
    // are looking at before you change anything.
    devBox: env.devBox,
    secrets: (() => {
      loadSecretsOverlay();
      const { secrets } = listSecretStatus();
      const missing = secrets.filter((s) => !s.set).map((s) => s.key);
      return { ready: missing.length === 0, missing };
    })(),
  });
});

api.get("/sync/runs", async (c) => {
  const page = Math.max(1, Number(c.req.query("page") ?? 1));
  const limit = Math.min(100, Math.max(1, Number(c.req.query("limit") ?? 50)));
  const offset = (page - 1) * limit;
  const [totalRows, runs] = await Promise.all([
    query<RowDataPacket & { total: number }>(
      `SELECT COUNT(*) AS total FROM ${sil("sil_sync_runs")}`,
    ),
    query<RowDataPacket>(
      `SELECT id, mode, source, status, duration_ms, products_fetched, posts_created, posts_updated,
              prices_updated, products_vanished, errors, started_at, finished_at, stats
         FROM ${sil("sil_sync_runs")} ORDER BY id DESC LIMIT ? OFFSET ?`,
      [limit, offset],
    ),
  ]);
  return c.json({
    runs: runs.map(decorateSyncRun),
    total: Number(totalRows[0]?.total ?? 0),
    page,
    limit,
  });
});

api.post("/sync/run", async (c) => {
  const body = (await c.req.json().catch(() => ({}))) as {
    mode?: string;
    source?: string;
    vendors?: string[];
  };
  const mode = body.mode === "full" ? "full" : "fast";
  const settings = await loadSettings();
  const source =
    body.source === "local" || body.source === "live" || body.source === "cache"
      ? body.source
      : settings.syncSource;
  const allowed = new Set(storefrontVendorSlugs());
  const vendors = Array.isArray(body.vendors)
    ? body.vendors.filter((v): v is string => allowed.has(v))
    : undefined;
  const vendorList = vendors?.length ? vendors : storefrontVendorSlugs();
  const vendorNames = "wholesale-perfumes";

  await clearSyncAbort();

  if (await isSyncLockHeld()) {
    return c.json({
      ok: true,
      started: false,
      alreadyRunning: true,
      queued: false,
      cooldown: false,
      mode,
      source,
      vendors: vendorList,
      detail:
        "Sync already running — your new request was not started. Watch the active run; pricing Save queues a rewrite-only follow-up automatically.",
    });
  }

  const catalogueReady = await hasSuccessfulCatalogue();
  const pendingRebuild = await isCatalogueRebuildPending();

  // Scheduled cadence owns price/stock. A one-off Update is only for when Sync enabled is off.
  if (mode === "fast" && settings.syncEnabled) {
    return c.json({
      ok: true,
      started: false,
      alreadyRunning: false,
      queued: false,
      cooldown: false,
      scheduleOwnsSync: true,
      mode,
      source,
      vendors: vendorList,
      detail:
        "Automatic price & stock sync is on. The next scheduled call will run it. Turn Sync enabled off for a one-off update.",
    });
  }

  // Rebuild while the schedule is on (and a catalogue already exists) waits for the next call.
  if (mode === "full" && settings.syncEnabled && catalogueReady) {
    if (!pendingRebuild) await queueCatalogueRebuild();
    return c.json({
      ok: true,
      started: false,
      alreadyRunning: false,
      queued: true,
      cooldown: false,
      pendingRebuild: true,
      mode,
      source,
      vendors: vendorList,
      detail: pendingRebuild
        ? `Catalogue rebuild is already queued. The next scheduled sync (every ${settings.fastSyncMinutes} min) will rebuild instead of prices-only.`
        : `Catalogue rebuild queued. The next scheduled sync (every ${settings.fastSyncMinutes} min) will rebuild ${vendorNames} instead of a prices-only call.`,
    });
  }

  // Live catalogue syncs must wait out the vendor cooldown — never start a run that would
  // silently reuse a stale on-disk feed.
  if (source === "live") {
    const cooldown = await getStorefrontLiveCooldown();
    if (!cooldown.anyAllow) {
      return c.json({
        ok: true,
        started: false,
        alreadyRunning: false,
        queued: false,
        cooldown: true,
        retryInMinutes: cooldown.retryInMinutes,
        nextAllowedAt: cooldown.nextAllowedAt,
        mode,
        source,
        vendors: vendorList,
        detail: `Next sync available in ${cooldown.retryInMinutes} min — ${cooldown.reason}`,
      });
    }
  }

  void runSync({
    mode,
    source,
    vendors: vendorList,
  }).catch((err) => log.error(`manual ${mode} sync failed`, String(err)));
  return c.json({
    ok: true,
    started: true,
    alreadyRunning: false,
    queued: false,
    cooldown: false,
    mode,
    source,
    vendors: vendorList,
  });
});

/** Vendor API credentials — status only (never echo values). */
api.get("/secrets", (c) => {
  loadSecretsOverlay();
  const { path, secrets } = listSecretStatus();
  return c.json({
    path,
    hotReload: true,
    note: "Changes apply immediately. This wholesale shop only uses wholesale-perfumes credentials. Dispatch is sandbox-locked (dry-run).",
    secrets,
  });
});

api.put("/secrets", async (c) => {
  const body = (await c.req.json().catch(() => ({}))) as { key?: string; value?: string };
  const key = typeof body.key === "string" ? body.key.trim() : "";
  const value = typeof body.value === "string" ? body.value : "";
  if (!key) return c.json({ ok: false, error: "key is required" }, 400);
  try {
    const secret = setSecret(key, value);
    await recordEvent("info", "secrets", `Set ${key} via dashboard`, { key, source: secret.source });
    return c.json({ ok: true, secret });
  } catch (err) {
    return c.json({ ok: false, error: String(err instanceof Error ? err.message : err) }, 400);
  }
});

api.delete("/secrets/:key", async (c) => {
  const key = c.req.param("key");
  try {
    const secret = clearSecret(key);
    await recordEvent("info", "secrets", `Cleared ${key} via dashboard`, { key });
    return c.json({ ok: true, secret });
  } catch (err) {
    return c.json({ ok: false, error: String(err instanceof Error ? err.message : err) }, 400);
  }
});

/** Hard stop: abort the running sync and disable scheduled sync until re-enabled. */
api.post("/sync/stop", async (c) => {
  await requestSyncAbort();
  return c.json({
    ok: true,
    stopped: true,
    detail: "Running sync will abort between batches. sync_enabled is now off — turn it on or press Run to start fresh.",
  });
});

api.get("/sync/live-status", async (c) => {
  const [cooldown, settings, pendingRebuild, catalogueReady] = await Promise.all([
    getStorefrontLiveCooldown(),
    loadSettings(),
    isCatalogueRebuildPending(),
    hasSuccessfulCatalogue(),
  ]);
  const wpf = cooldown.wholesalePerfumes;
  return c.json({
    profile: env.sillageProfile,
    vendors: storefrontVendorSlugs(),
    cooldownMinutes: cooldown.cooldownMinutes,
    /** @deprecated use cooldownMinutes — same value as live_feed_min_minutes */
    liveFeedMinMinutes: cooldown.cooldownMinutes,
    allow: cooldown.allow,
    anyAllow: cooldown.anyAllow,
    retryInMinutes: cooldown.retryInMinutes,
    nextAllowedAt: cooldown.nextAllowedAt,
    reason: cooldown.reason,
    syncEnabled: settings.syncEnabled,
    pendingRebuild,
    catalogueReady,
    scheduleOwnsFastSync: settings.syncEnabled,
    dailyCapEnabled: false,
    wholesalePerfumes: wpf
      ? {
          allow: wpf.allow,
          reason: wpf.reason,
          retryInMinutes: wpf.retryInMinutes,
          maxPerDay: wpf.maxPerDay,
          usedToday: wpf.usedToday,
          dailyRemaining: null,
        }
      : null,
  });
});

api.get("/products", async (c) => {
  const q = (c.req.query("q") ?? "").trim();
  const page = Math.max(1, Number(c.req.query("page") ?? 1));
  const limit = Math.min(100, Math.max(1, Number(c.req.query("limit") ?? 50)));
  const offset = (page - 1) * limit;

  const where = q
    ? `WHERE p.sku LIKE ? OR o.name LIKE ? OR o.primary_ean LIKE ?`
    : "";
  const params: unknown[] = q ? [`%${q}%`, `%${q}%`, `%${q}%`] : [];

  const [totalRows, items, settings] = await Promise.all([
    query<RowDataPacket & { total: number }>(
      `SELECT COUNT(*) AS total
         FROM ${sil("sil_products")} p
         JOIN ${sil("sil_offers")} o ON o.id = p.primary_offer_id
         ${where}`,
      params,
    ),
    query<RowDataPacket>(
      `SELECT p.id, p.sku, p.wp_post_id, p.slug, o.name, o.stock, o.vendor_price, o.primary_ean,
              o.eans, COALESCE(NULLIF(v.storefront_label, ''), v.name) AS vendor, o.image_url,
              v.min_visible_stock, thumb.meta_value AS wp_thumb_url, p.operator_hidden
         FROM ${sil("sil_products")} p
         JOIN ${sil("sil_offers")} o ON o.id = p.primary_offer_id
         JOIN ${sil("sil_vendors")} v ON v.id = o.vendor_id
         LEFT JOIN ${wp("postmeta")} thumb
           ON thumb.post_id = p.wp_post_id AND thumb.meta_key = '_external_thumbnail_url'
         ${where}
        ORDER BY p.id DESC LIMIT ? OFFSET ?`,
      [...params, limit, offset],
    ),
    loadSettings(),
  ]);

  const offerImages = await loadUsableImagesForEans(items.map((row) => offerEans(row)).flat());
  const overrides = loadImageOverrides();

  const decorated = items.map((row) => {
    const threshold =
      row.min_visible_stock === null || row.min_visible_stock === undefined
        ? settings.stockThreshold
        : Number(row.min_visible_stock);
    const {
      min_visible_stock: _min,
      eans: _eans,
      wp_thumb_url: wooThumb,
      operator_hidden: opHidden,
      ...rest
    } = row;
    void _min;
    void _eans;
    const resolved = resolveImageUrl(
      offerEans(row),
      (row.image_url as string | null) ?? null,
      overrides,
      offerImages,
    );
    const photo = displayedShopImage((wooThumb as string | null) ?? null, resolved);
    const operatorHidden = Number(opHidden) === 1;
    const slug = typeof row.slug === "string" ? row.slug : "";
    return {
      ...rest,
      operator_hidden: operatorHidden,
      photo_url: photo,
      shop_url: slug ? `${env.wordpress.baseUrl}/product/${slug}/` : null,
      shop_visibility: shopVisibility({
        stock: Number(row.stock),
        imageUrl: photo,
        hideWithoutImage: settings.hideProductsWithoutImage,
        stockThreshold: threshold,
        operatorHidden,
      }),
    };
  });

  return c.json({ items: decorated, total: Number(totalRows[0]?.total ?? 0), page, limit });
});

api.put("/products/:id/visibility", async (c) => {
  const id = Number(c.req.param("id"));
  const body = await c.req.json<{ hidden?: boolean }>();
  if (!Number.isFinite(id) || id <= 0 || typeof body.hidden !== "boolean") {
    return c.json({ error: "hidden must be true or false" }, 400);
  }

  const rows = await query<RowDataPacket & { id: number; sku: string | null; wp_post_id: number | null }>(
    `SELECT id, sku, wp_post_id FROM ${sil("sil_products")} WHERE id = ? LIMIT 1`,
    [id],
  );
  const row = rows[0];
  if (!row) return c.json({ error: "product not found" }, 404);

  await execute(
    `UPDATE ${sil("sil_products")}
        SET operator_hidden = ?, needs_price_write = 1
      WHERE id = ?`,
    [body.hidden ? 1 : 0, id],
  );

  // Hide immediately so a bad photo is off the catalogue before the rewrite lands.
  if (body.hidden && row.wp_post_id) {
    await execute(
      `INSERT IGNORE INTO ${wp("term_relationships")} (object_id, term_taxonomy_id, term_order)
       SELECT ?, tt.term_taxonomy_id, 0
         FROM ${wp("term_taxonomy")} tt
         JOIN ${wp("terms")} t ON t.term_id = tt.term_id
        WHERE tt.taxonomy = 'product_visibility'
          AND t.slug IN ('exclude-from-catalog', 'exclude-from-search')`,
      [row.wp_post_id],
    );
  }

  const syncStatus = await kickPriceRewrite();
  await recordEvent(
    "info",
    "products",
    body.hidden
      ? `Keep hidden: ${row.sku ?? id}`
      : `Follow shop rules: ${row.sku ?? id}`,
    { productId: id, sku: row.sku, hidden: body.hidden },
  );

  return c.json({
    ok: true,
    operator_hidden: body.hidden,
    syncStarted: syncStatus === "started",
    syncQueued: syncStatus === "queued",
  });
});

api.get("/vendors", async (c) => {
  const vendors = await loadVendors();
  const settings = await loadSettings();
  const lastFetchRows = await query<RowDataPacket & { setting_key: string; setting_value: string }>(
    `SELECT setting_key, setting_value FROM ${sil("sil_settings")}
      WHERE setting_key IN (
        'last_live_fetch_wholesale-perfumes',
        'last_live_fetch_wholesale-perfumes_store'
      )`,
  );
  const lastLiveFetch: Record<string, string | null> = {
    "wholesale-perfumes": null,
  };
  for (const row of lastFetchRows) {
    if (row.setting_key === "last_live_fetch_wholesale-perfumes") {
      lastLiveFetch["wholesale-perfumes"] = row.setting_value;
    }
  }
  return c.json({
    profile: env.sillageProfile,
    parkedVendors: vendors.filter((v) => isParkedVendor(v.slug)).map((v) => v.slug),
    globalPriceMultiplier: settings.priceMultiplier,
    globalStockThreshold: settings.stockThreshold,
    callIntervalMinutes: settings.liveFeedMinMinutes,
    lastLiveFetch,
    vendors: vendors.map((v) => {
      const minOrder = v.orderConfig.min_order_value_eur;
      const minOrderValueEur =
        typeof minOrder === "number" && Number.isFinite(minOrder)
          ? minOrder
          : typeof minOrder === "string" && Number.isFinite(Number(minOrder))
            ? Number(minOrder)
            : null;
      return {
        id: v.id,
        slug: v.slug,
        name: v.name,
        storefrontLabel: v.storefrontLabel,
        skuPrefix: v.skuPrefix,
        currency: v.currency,
        fxRate: v.fxRate,
        vatRate: v.vatRate,
        // Raw nulls so the editor can show "fall back to global" — do not coalesce.
        priceMultiplier: v.priceMultiplier,
        minVisibleStock: v.minVisibleStock,
        minOrderValueEur,
        serviceableCountries: v.serviceableCountries,
        active: v.active,
        liveMaxPerDay: v.liveMaxPerDay,
        storeLiveMaxPerDay: v.storeLiveMaxPerDay,
        storeLiveMinMinutes: v.storeLiveMinMinutes,
        orderConfig: v.orderConfig,
        parked: isParkedVendor(v.slug),
      };
    }),
  });
});

api.put("/vendors/:slug", async (c) => {
  const slug = c.req.param("slug");
  let body: unknown;
  try {
    body = await c.req.json();
  } catch {
    await recordEvent("warn", "vendors", `reject patch for ${slug}: unparseable JSON`);
    return c.json({ error: "Request body must be valid JSON" }, 400);
  }

  const parsed = parseVendorPatch(body);
  if (!parsed.ok) {
    await recordEvent("warn", "vendors", `reject patch for ${slug}: ${parsed.error}`);
    return c.json({ error: parsed.error }, 400);
  }

  let existing: Awaited<ReturnType<typeof loadVendor>>;
  try {
    existing = await loadVendor(slug);
  } catch {
    return c.json({ error: `Unknown vendor "${slug}"` }, 404);
  }

  const patch = parsed.patch;
  if (isParkedVendor(slug) && patch.active === true) {
    await recordEvent("warn", "vendors", `reject activate for parked vendor ${slug}`);
    return c.json(
      { error: `${slug} is parked on this storefront and cannot be activated` },
      400,
    );
  }
  const orderConfig = { ...existing.orderConfig };
  if (patch.minOrderValueEur !== undefined) {
    if (patch.minOrderValueEur === null) {
      delete orderConfig.min_order_value_eur;
    } else {
      orderConfig.min_order_value_eur = patch.minOrderValueEur;
    }
  }

  await updateVendor(slug, {
    storefrontLabel: patch.storefrontLabel,
    priceMultiplier: patch.priceMultiplier,
    minVisibleStock: patch.minVisibleStock,
    fxRate: patch.fxRate,
    vatRate: patch.vatRate,
    active: patch.active,
    serviceableCountries: patch.serviceableCountries,
    liveMaxPerDay: patch.liveMaxPerDay,
    storeLiveMaxPerDay: patch.storeLiveMaxPerDay,
    storeLiveMinMinutes: patch.storeLiveMinMinutes,
    orderConfig: patch.minOrderValueEur !== undefined ? orderConfig : undefined,
  });

  // Multiplier / FX / VAT / stock floor change storefront prices; hashes cover vendor feed only.
  const touchPrice =
    patch.priceMultiplier !== undefined ||
    patch.vatRate !== undefined ||
    patch.fxRate !== undefined ||
    patch.minVisibleStock !== undefined;
  let marked = 0;
  let syncStatus: "started" | "queued" | null = null;
  if (touchPrice) {
    marked = await markAllPricesDirty();
    if (marked > 0) {
      // Same path as Settings pricing Save: rewrite from sil_offers, no live vendor API.
      syncStatus = await kickPriceRewrite();
    }
  }

  await recordEvent("info", "vendors", `updated ${slug}`, {
    fields: Object.keys(patch),
    marked,
    syncStatus,
  });

  return c.json({
    ok: true,
    marked,
    syncStarted: syncStatus === "started",
    syncQueued: syncStatus === "queued",
    syncKind: syncStatus ? "fast/rewrite-only" : null,
    detail:
      syncStatus === "queued"
        ? "Sync already running — new prices will apply when it finishes (rewrite-only follow-up queued)."
        : syncStatus === "started"
          ? "Recalculating prices from stored offers (no live vendor download)."
          : undefined,
  });
});

api.get("/orders", async (c) => {
  const status = c.req.query("status");
  const page = Math.max(1, Number(c.req.query("page") ?? 1));
  const limit = Math.min(100, Math.max(1, Number(c.req.query("limit") ?? 50)));
  const offset = (page - 1) * limit;
  const where = status ? "WHERE v.status = ?" : "";
  const filterParams: unknown[] = status ? [status] : [];

  const [totalRows, orders] = await Promise.all([
    query<RowDataPacket & { total: number }>(
      `SELECT COUNT(*) AS total
         FROM ${sil("sil_vendor_orders")} v
         ${where}`,
      filterParams,
    ),
    query<RowDataPacket>(
      `SELECT v.id, v.wc_order_id, v.our_reference, v.status, v.items_cost, v.shipping_cost,
              v.total_cost, v.revenue, v.destination_country, v.dry_run, v.vendor_order_number,
              v.created_at, v.updated_at, ven.slug AS vendor
         FROM ${sil("sil_vendor_orders")} v
         JOIN ${sil("sil_vendors")} ven ON ven.id = v.vendor_id
         ${where}
        ORDER BY v.id DESC LIMIT ? OFFSET ?`,
      [...filterParams, limit, offset],
    ),
  ]);

  return c.json({
    orders,
    total: Number(totalRows[0]?.total ?? 0),
    page,
    limit,
  });
});

api.get("/orders/:id", async (c) => {
  const id = Number(c.req.param("id"));
  const [order] = await query<RowDataPacket>(
    `SELECT v.*, ven.slug AS vendor
       FROM ${sil("sil_vendor_orders")} v
       JOIN ${sil("sil_vendors")} ven ON ven.id = v.vendor_id
      WHERE v.id = ?`,
    [id],
  );
  if (!order) return c.json({ ok: false, error: "not found" }, 404);
  const [items, events, tracking] = await Promise.all([
    query<RowDataPacket>(`SELECT * FROM ${sil("sil_vendor_order_items")} WHERE vendor_order_id = ?`, [id]),
    query<RowDataPacket>(
      `SELECT * FROM ${sil("sil_order_events")} WHERE vendor_order_id = ? ORDER BY id DESC LIMIT 50`,
      [id],
    ),
    query<RowDataPacket>(`SELECT * FROM ${sil("sil_vendor_order_tracking")} WHERE vendor_order_id = ?`, [id]),
  ]);
  const woo = await readWooOrder(Number(order.wc_order_id));
  const wooAddress = woo ? destinationAddress(woo) : null;
  const deliveryAddress = resolveDeliveryAddress(
    order.delivery_address_json,
    wooAddress,
    String(order.destination_country ?? ""),
  );
  const billingAddress = await resolveBillingAddress(
    order.billing_address_json,
    String(order.vendor),
  );
  const companyBilling = await loadCompanyBilling(String(order.vendor));
  const wpAdminUrl = `${env.wordpress.baseUrl}/wp-admin/admin.php?page=wc-orders&action=edit&id=${order.wc_order_id}`;
  return c.json({
    order,
    // Backward-compatible alias for the editable delivery address.
    address: deliveryAddress,
    wooAddress,
    deliveryAddress,
    billingAddress,
    companyBilling,
    wpAdminUrl,
    items,
    events,
    tracking,
  });
});

api.put("/orders/:id/address", async (c) => {
  const id = Number(c.req.param("id"));
  const [order] = await query<
    RowDataPacket & { status: string; wc_order_id: number; dry_run: number; vendor: string }
  >(
    `SELECT v.id, v.status, v.wc_order_id, v.dry_run, ven.slug AS vendor
       FROM ${sil("sil_vendor_orders")} v
       JOIN ${sil("sil_vendors")} ven ON ven.id = v.vendor_id
      WHERE v.id = ?`,
    [id],
  );
  if (!order) return c.json({ ok: false, error: "not found" }, 404);

  const editable = new Set(["received", "approved", "needs_attention", "submitted"]);
  if (!editable.has(order.status)) {
    return c.json({ ok: false, error: `cannot edit address in status ${order.status}` }, 409);
  }
  if (order.status === "submitted" && Number(order.dry_run) === 0) {
    return c.json({ ok: false, error: "cannot edit address after a live submit" }, 409);
  }

  const body = (await c.req.json().catch(() => ({}))) as {
    address?: OrderAddress;
    delivery?: OrderAddress;
    billing?: OrderAddress & { vat?: string };
    resetDeliveryFromWoo?: boolean;
    useCompanyBilling?: boolean;
  };

  const sets: string[] = [];
  const params: unknown[] = [];

  if (body.resetDeliveryFromWoo) {
    const woo = await readWooOrder(Number(order.wc_order_id));
    if (!woo) return c.json({ ok: false, error: "WooCommerce order not found" }, 404);
    const snap = destinationAddress(woo);
    sets.push("delivery_address_json = ?", "destination_country = ?");
    params.push(JSON.stringify(snap), snap.country.toUpperCase());
  } else {
    const deliveryRaw = body.delivery ?? body.address;
    if (deliveryRaw) {
      const delivery = parseOrderAddress(deliveryRaw);
      if (!delivery) {
        return c.json({ ok: false, error: "delivery.address1 and delivery.country are required" }, 400);
      }
      sets.push("delivery_address_json = ?", "destination_country = ?");
      params.push(JSON.stringify(delivery), delivery.country.toUpperCase());
    }
  }

  if (body.useCompanyBilling) {
    const company = await loadCompanyBilling(order.vendor);
    sets.push("billing_address_json = ?");
    params.push(JSON.stringify(company));
  } else if (body.billing) {
    const billing = parseCompanyBilling(body.billing);
    if (!billing.address1 || !billing.country) {
      return c.json({ ok: false, error: "billing.address1 and billing.country are required" }, 400);
    }
    sets.push("billing_address_json = ?");
    params.push(JSON.stringify(billing));
  }

  if (sets.length === 0) {
    return c.json({ ok: false, error: "nothing to update" }, 400);
  }

  sets.push("updated_at = NOW()");
  params.push(id);
  await execute(`UPDATE ${sil("sil_vendor_orders")} SET ${sets.join(", ")} WHERE id = ?`, params);
  await execute(
    `INSERT INTO ${sil("sil_order_events")} (vendor_order_id, from_status, to_status, message, context)
     VALUES (?, ?, ?, ?, ?)`,
    [
      id,
      order.status,
      order.status,
      body.resetDeliveryFromWoo
        ? "delivery reset from WooCommerce"
        : body.useCompanyBilling
          ? "billing set from saved company profile"
          : "delivery/billing address updated from dashboard",
      JSON.stringify({
        resetDeliveryFromWoo: Boolean(body.resetDeliveryFromWoo),
        useCompanyBilling: Boolean(body.useCompanyBilling),
        hasDelivery: Boolean(body.delivery ?? body.address),
        hasBilling: Boolean(body.billing),
      }),
    ],
  );
  return c.json({ ok: true });
});

const OPERATIONAL_STAGES = [
  "received",
  "approved",
  "submitted",
  "confirmed",
  "dispatched",
  "delivered",
] as const;

api.post("/orders/:id/status", async (c) => {
  const id = Number(c.req.param("id"));
  const [order] = await query<RowDataPacket & { status: string; dry_run: number; wc_order_id: number }>(
    `SELECT id, status, dry_run, wc_order_id FROM ${sil("sil_vendor_orders")} WHERE id = ?`,
    [id],
  );
  if (!order) return c.json({ ok: false, error: "not found" }, 404);

  const body = (await c.req.json().catch(() => ({}))) as { status?: string; confirm?: boolean };
  const next = body.status;
  if (!next || !(OPERATIONAL_STAGES as readonly string[]).includes(next)) {
    return c.json(
      { ok: false, error: `status must be one of: ${OPERATIONAL_STAGES.join(", ")}` },
      400,
    );
  }

  // Same edit window as address: pre-live or dry-run submitted. After live submit require confirm.
  const lockedAfterLive =
    Number(order.dry_run) === 0 &&
    ["submitted", "confirmed", "dispatched", "delivered"].includes(order.status);
  if (lockedAfterLive && !body.confirm) {
    return c.json(
      {
        ok: false,
        error: "confirm required to change status after a live submit",
        needsConfirm: true,
      },
      409,
    );
  }

  const from = order.status;
  await execute(
    `UPDATE ${sil("sil_vendor_orders")}
        SET status = ?,
            approved_at   = IF(? = 'approved'   AND approved_at   IS NULL, NOW(), approved_at),
            submitted_at  = IF(? = 'submitted'  AND submitted_at  IS NULL, NOW(), submitted_at),
            dispatched_at = IF(? = 'dispatched' AND dispatched_at IS NULL, NOW(), dispatched_at),
            delivered_at  = IF(? = 'delivered'  AND delivered_at  IS NULL, NOW(), delivered_at),
            updated_at = NOW()
      WHERE id = ?`,
    [next, next, next, next, next, id],
  );
  await execute(
    `INSERT INTO ${sil("sil_order_events")} (vendor_order_id, from_status, to_status, message, context)
     VALUES (?, ?, ?, ?, ?)`,
    [
      id,
      from,
      next,
      "manual status override",
      JSON.stringify({ confirm: Boolean(body.confirm) }),
    ],
  );

  if (next === "delivered" || from === "delivered") {
    const settings = await loadSettings();
    await maybeCompleteWooOrder(Number(order.wc_order_id), settings.ordersNotifyCustomer);
  }

  return c.json({ ok: true, status: next });
});

api.post("/orders/:id/approve", async (c) => {
  const id = Number(c.req.param("id"));
  return c.json(await approveVendorOrder(id, true));
});

api.post("/orders/:id/dispatch", async (c) => {
  const id = Number(c.req.param("id"));
  const body = (await c.req.json().catch(() => ({}))) as { live?: boolean };
  // Dashboard buttons are explicit: Dry-run always dry, Live always live — never inherit settings.
  const result = await dispatchVendorOrder(id, {
    force: true,
    dryRun: body.live === true ? false : true,
  });
  return c.json(result);
});

api.get("/settings", async (c) => {
  const s = await loadSettings();
  const [wpfBilling] = await Promise.all([
    loadCompanyBilling("wholesale-perfumes"),
  ]);
  return c.json({
    sillage_profile: env.sillageProfile,
    parked_vendors: "",
    orders_sandbox_locked: "1",
    sync_enabled: s.syncEnabled ? "1" : "0",
    fast_sync_minutes: String(s.fastSyncMinutes),
    full_sync_enabled: s.fullSyncEnabled ? "1" : "0",
    full_sync_hour: String(s.fullSyncHour),
    schedule_timezone: s.scheduleTimezone,
    sync_source: s.syncSource,
    global_price_multiplier: String(s.priceMultiplier),
    price_tiers: JSON.stringify(s.priceTiers),
    global_stock_threshold: String(s.stockThreshold),
    hide_products_without_image: s.hideProductsWithoutImage ? "1" : "0",
    image_cdn_base_url: s.imageCdnBaseUrl,
    wp_base_url: s.wpBaseUrl,
    cart_min_enabled: s.cartMinEnabled ? "1" : "0",
    cart_min_subtotal_eur: String(s.cartMinSubtotalEur),
    cart_min_fee_eur: String(s.cartMinFeeEur),
    cart_min_fee_label: s.cartMinFeeLabel,
    cart_min_message: s.cartMinMessage,
    orders_dry_run: s.ordersDryRun ? "1" : "0",
    orders_auto_dispatch: s.ordersAutoDispatch ? "1" : "0",
    orders_max_value_eur: String(s.ordersMaxValueEur),
    orders_daily_cap_eur: String(s.ordersDailyCapEur),
    orders_poll_minutes: String(s.ordersPollMinutes),
    orders_notify_customer: s.ordersNotifyCustomer ? "1" : "0",
    description_mode: s.descriptionMode,
    volume_filter_mode: s.volumeFilterMode,
    live_feed_min_minutes: String(s.liveFeedMinMinutes),
    pending_catalogue_rebuild: (await isCatalogueRebuildPending()) ? "1" : "0",
    company_billing_wholesale_perfumes: JSON.stringify(wpfBilling),
  });
});

api.put("/settings", async (c) => {
  const body = await c.req.json<Record<string, string>>();
  const allowed = new Set([
    "sync_enabled",
    "fast_sync_minutes",
    "full_sync_enabled",
    "full_sync_hour",
    "schedule_timezone",
    "sync_source",
    "global_price_multiplier",
    "price_tiers",
    "global_stock_threshold",
    "hide_products_without_image",
    "image_cdn_base_url",
    "wp_base_url",
    "cart_min_enabled",
    "cart_min_subtotal_eur",
    "cart_min_fee_eur",
    "cart_min_fee_label",
    "cart_min_message",
    "orders_dry_run",
    "orders_auto_dispatch",
    "orders_max_value_eur",
    "orders_daily_cap_eur",
    "orders_poll_minutes",
    "orders_notify_customer",
    "description_mode",
    "volume_filter_mode",
    "live_feed_min_minutes",
    "company_billing_wholesale_perfumes",
  ]);
  // Settings that change what we write to WooCommerce. Hashes only see vendor feed data, so a
  // multiplier edit would otherwise look like "nothing changed" forever.
  const priceKeys = new Set([
    "global_price_multiplier",
    "price_tiers",
    "global_stock_threshold",
    "hide_products_without_image",
  ]);
  const contentKeys = new Set(["description_mode", "volume_filter_mode"]);

  // Dashboard Save posts the whole form. Only kick rewrites when a price/content key
  // actually changes — otherwise every Save queues a full/cache rewrite forever.
  const priorRows = await query<RowDataPacket & { setting_key: string; setting_value: string }>(
    `SELECT setting_key, setting_value FROM ${sil("sil_settings")} WHERE setting_key IN (${[...allowed]
      .filter((k) => !k.startsWith("company_billing_"))
      .map(() => "?")
      .join(",")})`,
    [...allowed].filter((k) => !k.startsWith("company_billing_")),
  );
  const prior = new Map(priorRows.map((r) => [r.setting_key, r.setting_value]));

  let n = 0;
  let touchPrice = false;
  let touchContent = false;
  for (const [key, value] of Object.entries(body)) {
    if (!allowed.has(key) || typeof value !== "string") continue;
    if (key === "company_billing_wholesale_perfumes") {
      try {
        const parsed = parseCompanyBilling(JSON.parse(value));
        await saveCompanyBilling("wholesale-perfumes", parsed);
      } catch {
        continue;
      }
      n++;
      continue;
    }
    let persist = value;
    if (key === "price_tiers") {
      // Persist the canonical sorted/validated form so the dashboard round-trips cleanly.
      const parsed = parsePriceTiers(value);
      persist = JSON.stringify(parsed.tiers);
    } else if (key === "schedule_timezone") {
      persist = resolveTimeZone(value);
    } else if (key === "full_sync_hour") {
      const h = Math.min(23, Math.max(0, Math.trunc(Number(value)) || 0));
      persist = String(h);
    } else if (key === "live_feed_min_minutes" || key === "fast_sync_minutes") {
      const m = Math.max(1, Math.trunc(Number(value)) || 60);
      persist = String(m);
    }
    const changed = prior.get(key) !== persist;
    if (!changed) continue;
    if (
      isWholesaleProfile() &&
      ((key === "orders_dry_run" && persist !== "1" && persist !== "true") ||
        (key === "orders_auto_dispatch" && persist !== "0" && persist !== "false"))
    ) {
      continue;
    }
    await setSetting(key, persist);
    n++;
    // One operator "minutes between syncs" keeps schedule cadence and vendor gate in lockstep.
    if (key === "live_feed_min_minutes" && prior.get("fast_sync_minutes") !== persist) {
      await setSetting("fast_sync_minutes", persist);
      n++;
    } else if (key === "fast_sync_minutes" && prior.get("live_feed_min_minutes") !== persist) {
      await setSetting("live_feed_min_minutes", persist);
      n++;
    }
    if (priceKeys.has(key)) touchPrice = true;
    if (contentKeys.has(key)) touchContent = true;
    // Turning sync back on clears a previous Stop.
    if (key === "sync_enabled" && (value === "1" || value === "true")) {
      await clearSyncAbort();
    }
  }

  // Hot-apply public URLs so WooCommerce links / tracking use the new shop host without restart.
  const refreshed = await loadSettings();
  applyRuntimeUrls({ wpBaseUrl: refreshed.wpBaseUrl, imageCdnBaseUrl: refreshed.imageCdnBaseUrl });

  let marked = 0;
  let syncStatus: "started" | "queued" | null = null;
  if (touchContent) {
    marked = await markAllProductsDirty();
    if (marked > 0) syncStatus = await kickContentRewrite();
  } else if (touchPrice) {
    marked = await markAllPricesDirty();
    if (marked > 0) syncStatus = await kickPriceRewrite();
  }

  return c.json({
    ok: true,
    updated: n,
    marked,
    syncStarted: syncStatus === "started",
    syncQueued: syncStatus === "queued",
    syncKind: syncStatus ? (touchContent ? "full/cache" : "fast/rewrite-only") : null,
    detail:
      syncStatus === "queued"
        ? "Sync already running — new prices will apply when it finishes (rewrite-only follow-up queued)."
        : syncStatus === "started"
          ? touchContent
            ? "Rewriting catalogue content from cache…"
            : "Recalculating prices from stored offers (no live vendor download)."
          : undefined,
  });
});

api.get("/logs", async (c) => {
  const level = c.req.query("level");
  const scope = c.req.query("scope");
  const page = Math.max(1, Number(c.req.query("page") ?? 1));
  const limit = Math.min(200, Math.max(1, Number(c.req.query("limit") ?? 50)));
  const offset = (page - 1) * limit;
  const clauses: string[] = [];
  const params: unknown[] = [];
  if (level) {
    clauses.push("level = ?");
    params.push(level);
  }
  if (scope) {
    clauses.push("scope = ?");
    params.push(scope);
  }
  const where = clauses.length ? `WHERE ${clauses.join(" AND ")}` : "";

  const [totalRows, events] = await Promise.all([
    query<RowDataPacket & { total: number }>(
      `SELECT COUNT(*) AS total FROM ${sil("sil_events")} ${where}`,
      params,
    ),
    query<RowDataPacket>(
      `SELECT id, level, scope, message, context, run_id, created_at
         FROM ${sil("sil_events")} ${where}
        ORDER BY id DESC LIMIT ? OFFSET ?`,
      [...params, limit, offset],
    ),
  ]);

  return c.json({
    events,
    total: Number(totalRows[0]?.total ?? 0),
    page,
    limit,
  });
});
