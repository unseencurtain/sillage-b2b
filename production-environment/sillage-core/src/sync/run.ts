import { applyRuntimeUrls, env, lockName, sil } from "../config/env.ts";
import { loadSecretsOverlay } from "../config/secrets.ts";
import { execute, getPool, query, type RowDataPacket } from "../db/pool.ts";
import type { PoolConnection } from "mysql2/promise";
import { loadSettings, loadVendors, recordEvent, type GlobalSettings, type Vendor } from "../db/settings.ts";
import { formatDuration, logger } from "../lib/log.ts";
import { createConnector, vendorSelectableForSync } from "../vendors/registry.ts";
import { applyStorefrontProfile } from "../storefront/profile.ts";
import type { FeedSource, NormalizedProduct } from "../vendors/types.ts";
import {
  applyPriceStockDelta,
  diffOffers,
  existingVendorProductIds,
  markDirtyFromPendingOffers,
  markPriceDirtyFromPendingOffers,
  resolveProductIdentities,
  selectPrimaryOffers,
  staleOfferRatio,
} from "./diff.ts";
import { resolveDeltaSince } from "./deltaSince.ts";
import { finalizeWordPress } from "./finalize.ts";
import { writeProductSitemaps } from "./sitemaps.ts";
import {
  ATTRIBUTE_TAXONOMIES,
  BRAND_TAXONOMY,
  parkForeignVendorsFromStorefront,
  purgeVendorProductAttributes,
  purgeVendorProductCatLanes,
  purgeWholesalePerfumesBrandProductCats,
  loadCategoryMapsFromDb,
  loadFlatTermMapFromDb,
  rebuildCategoryLookup,
  recountTerms,
  syncCategories,
  syncFlatTerms,
  type TermRef,
} from "./taxonomy.ts";
import { clearSyncAbort, SyncAbortedError, throwIfSyncAborted } from "./abort.ts";
import { normalizeVolume, vendorStorefrontLabel } from "./volume.ts";
import { buildWriteContext, writePendingProducts, type WriteContext, type WriteMode } from "./writer.ts";
import type { CacheVendor } from "../vendors/feedCache.ts";
import { checkLiveGate, recordLiveFetch } from "../vendors/liveGate.ts";
import {
  consumeCatalogueRebuildFlag,
  restoreCatalogueRebuildFlag,
} from "./pendingRewrite.ts";

const log = logger("sync");

export interface SyncOptions {
  mode: WriteMode;
  source: FeedSource;
  /**
   * Vendor slugs to include. Empty means every active *retail* vendor
   * (`--vendor=all` skips parked slugs for this storefront profile).
   */
  vendors?: string[];
  /** Fetch and diff but make no WooCommerce writes. */
  dryRun?: boolean;
  /** Re-mark products a previous run errored on, so this run retries them. */
  redrive?: boolean;
  /** Re-mark every product, ignoring the applied hashes. */
  rewriteAll?: boolean;
  /**
   * Skip vendor feed fetch entirely — only rewrite already-dirty WooCommerce rows from DB state.
   * Used when a settings change (multiplier, description) must hit the storefront without burning
   * a live API download.
   */
  rewriteOnly?: boolean;
}

/**
 * Force a content rewrite of every product.
 *
 * The writer skips a product whose content hash is unchanged, which is what makes a re-run cheap.
 * But the hash covers only vendor data — it cannot see a change to the description template, the
 * attribute mapping, or the taxonomy a term lives in. After any of those, the stored hashes are
 * stale in a way nothing detects, and this is the only way to pick the change up.
 */
export async function markAllProductsDirty(): Promise<number> {
  const result = await execute(
    `UPDATE ${sil("sil_products")}
        SET needs_content_write = 1, needs_price_write = 1,
            applied_content_hash = NULL, applied_price_hash = NULL, last_error = NULL`,
  );
  return result.affectedRows;
}

/**
 * Force a price rewrite. Price hashes cover vendor cost only — changing the multiplier, FX rate,
 * or stock threshold leaves every applied_price_hash looking "current" until this runs.
 */
export async function markAllPricesDirty(): Promise<number> {
  const result = await execute(
    `UPDATE ${sil("sil_products")}
        SET needs_price_write = 1, applied_price_hash = NULL, last_error = NULL`,
  );
  return result.affectedRows;
}

/**
 * Re-mark products a previous run failed to write.
 *
 * When a batch throws, the writer clears its dirty flags so the run can still terminate and records
 * the error on the row. Nothing would ever pick those rows up again, so the retry has to be
 * explicit — otherwise a transient fault silently strands products forever.
 */
export async function redriveErroredProducts(): Promise<number> {
  const result = await execute(
    `UPDATE ${sil("sil_products")}
        SET needs_content_write = 1, needs_price_write = 1, last_error = NULL
      WHERE last_error IS NOT NULL OR wp_post_id IS NULL`,
  );
  return result.affectedRows;
}

export interface SyncSummary {
  runId: number;
  mode: WriteMode;
  durationMs: number;
  fetched: number;
  created: number;
  updated: number;
  vanished: number;
  postsCreated: number;
  postsUpdated: number;
  pricesUpdated: number;
  termsCreated: number;
  errors: number;
  /** Products hidden because the resolved image was still missing/placeholder. */
  hiddenNoImage: number;
  /** Per-vendor rows touched in this run (full catalogue size or BTS delta count). */
  fetchedByVendor?: Record<string, number>;
  skippedVendors?: string[];
  /** True when BTS used the changes API rather than a full catalogue pull. */
  btsDelta?: boolean;
}

async function startRun(mode: WriteMode, source: FeedSource, vendorId: number | null): Promise<number> {
  const result = await execute(
    `INSERT INTO ${sil("sil_sync_runs")} (vendor_id, mode, source, status) VALUES (?, ?, ?, 'running')`,
    [vendorId, mode, source],
  );
  return result.insertId;
}

async function finishRun(runId: number, startedAt: number, summary: Partial<SyncSummary>, error?: unknown): Promise<void> {
  const durationMs = Date.now() - startedAt;
  const status = error ? "error" : (summary.errors ?? 0) > 0 ? "partial" : "success";
  await execute(
    `UPDATE ${sil("sil_sync_runs")}
        SET finished_at = NOW(), duration_ms = ?, status = ?, error_message = ?,
            products_fetched = ?, products_new = ?, products_updated = ?, products_vanished = ?,
            posts_created = ?, posts_updated = ?, prices_updated = ?, terms_created = ?,
            errors = ?, stats = ?
      WHERE id = ?`,
    [
      durationMs,
      status,
      error ? String(error).slice(0, 2000) : null,
      summary.fetched ?? 0,
      summary.created ?? 0,
      summary.updated ?? 0,
      summary.vanished ?? 0,
      summary.postsCreated ?? 0,
      summary.postsUpdated ?? 0,
      summary.pricesUpdated ?? 0,
      summary.termsCreated ?? 0,
      summary.errors ?? 0,
      JSON.stringify(summary),
      runId,
    ],
  );
}

/**
 * Guard against two syncs writing the same rows concurrently.
 *
 * MariaDB GET_LOCK is connection-scoped. The shared pool must NOT run GET_LOCK /
 * RELEASE_LOCK on arbitrary checked-out connections — RELEASE on connection B leaves
 * the lock held forever on idle connection A, and every later Save queues forever.
 * Hold one dedicated connection for the whole sync lifetime.
 */
async function acquireLockOn(conn: PoolConnection, name: string, timeoutSeconds = 0): Promise<boolean> {
  const [rows] = await conn.query<Array<RowDataPacket & { locked: number | null }>>(
    `SELECT GET_LOCK(?, ?) AS locked`,
    [lockName(name), timeoutSeconds],
  );
  return rows[0]?.locked === 1;
}

async function releaseLockOn(conn: PoolConnection, name: string): Promise<void> {
  await conn.query(`SELECT RELEASE_LOCK(?)`, [lockName(name)]);
}

export async function runSync(options: SyncOptions): Promise<SyncSummary> {
  const startedAt = Date.now();
  // Pick up dashboard Secrets overlay without restarting sillage-cron / sillage-core.
  loadSecretsOverlay();

  const lockConn = await getPool().getConnection();
  let lockHeld = false;
  if (!(await acquireLockOn(lockConn, "sync"))) {
    lockConn.release();
    throw new Error("another sync is already running");
  }
  lockHeld = true;

  // Everything after acquireLock must release — including failures before startRun
  // (e.g. invalid source ENUM) so the pool connection does not hold GET_LOCK forever.
  let runId = 0;
  const summary: SyncSummary = {
    runId: 0,
    mode: options.mode,
    durationMs: 0,
    fetched: 0,
    created: 0,
    updated: 0,
    vanished: 0,
    postsCreated: 0,
    postsUpdated: 0,
    pricesUpdated: 0,
    termsCreated: 0,
    errors: 0,
    hiddenNoImage: 0,
    fetchedByVendor: {},
    skippedVendors: [],
    btsDelta: false,
  };

  try {
    // A previous Stop must not permanently block the next deliberate run.
    await clearSyncAbort();

    await applyStorefrontProfile();
    const settings = await loadSettings();
    applyRuntimeUrls({ wpBaseUrl: settings.wpBaseUrl, imageCdnBaseUrl: settings.imageCdnBaseUrl });
    const allVendors = await loadVendors();
    // Empty vendors = --vendor=all → skip parked slugs for this profile.
    // Retail still allows an explicit wholesale-perfumes slug (offline tests).
    // Wholesale never selects BeautyFort / BTS, even when named.
    const named = Boolean(options.vendors?.length);
    const pool = (named
      ? allVendors.filter((v) => options.vendors!.includes(v.slug))
      : allVendors
    ).filter((v) => vendorSelectableForSync(v.slug, named));
    const selected = pool.filter((v) => v.active);
    if (selected.length === 0) throw new Error("no active vendors selected");

    runId = await startRun(options.mode, options.source, selected.length === 1 ? selected[0]!.id : null);
    summary.runId = runId;
    if (options.mode === "full" && !options.rewriteOnly) {
      await consumeCatalogueRebuildFlag();
    }
    log.info(
      `run ${runId}: ${options.mode} sync from ${options.source}` +
        (options.rewriteOnly ? " (rewrite-only, no vendor fetch)" : "") +
        ` for ${selected.map((v) => v.slug).join(", ")}`,
    );

    if (options.rewriteAll) {
      const marked = await markAllProductsDirty();
      log.info(`rewrite-all: ${marked} products re-marked for a full content rewrite`);
    } else if (options.redrive) {
      const redriven = await redriveErroredProducts();
      log.info(`redrive: ${redriven} products re-marked for writing`);
    }

    // Settings-driven rewrites: products are already dirty; do not touch vendor APIs.
    // Must rebuild taxonomy maps from DB — empty maps + full mode wipe product_cat / brands.
    // Also purges any leftover LPS* product_cat vendor lanes (Decision 28).
    if (options.rewriteOnly) {
      await throwIfSyncAborted();
      const ctx = await buildRewriteWriteContext(settings, allVendors);
      if (!options.dryRun) {
        const written = await writePendingProducts(ctx, options.mode, (done, total) => {
          log.progress(`writing ${done}/${total}`);
        });
        log.progressEnd();
        summary.postsCreated = written.postsCreated;
        summary.postsUpdated = written.postsUpdated;
        summary.pricesUpdated = written.pricesUpdated;
        summary.errors += written.errors;
        summary.hiddenNoImage = written.hiddenNoImage;
        if (options.mode === "full") {
          await recountTerms(["product_cat", BRAND_TAXONOMY, ...Object.values(ATTRIBUTE_TAXONOMIES)]);
          await rebuildCategoryLookup();
        } else {
          await recountTerms(["product_cat", BRAND_TAXONOMY]);
        }
        await finalizeWordPress();
        if (options.mode === "full") {
          await writeProductSitemaps().catch((err) => {
            log.warn(`static sitemap write failed (shop data is still correct): ${String(err)}`);
          });
        }
      }
      summary.durationMs = Date.now() - startedAt;
      await finishRun(runId, startedAt, summary);
      return summary;
    }

    const categoryMaps = new Map<number, Map<string, TermRef>>();
    const brandValues = new Set<string>();
    const attributeValues = new Map<string, Set<string>>();

    for (const vendor of selected) {
      await throwIfSyncAborted();
      const connector = createConnector(vendor.slug);
      // ── Fast path: price and stock only ────────────────────────────────────
      if (options.mode === "fast") {
        const changed = await fastSyncVendor(vendor, connector, options, runId, summary);
        log.info(`${vendor.slug}: ${changed} offers changed`);
        continue;
      }

      // ── Full path ──────────────────────────────────────────────────────────
      if (options.source === "live" && vendor.slug !== "wholesale-perfumes") {
        const gate = await checkLiveGate(vendor.slug as CacheVendor);
        if (!gate.allow) {
          log.warn(`${vendor.slug}: skipping live catalogue rebuild — ${gate.reason}`);
          summary.skippedVendors = [...(summary.skippedVendors ?? []), vendor.slug];
          continue;
        }
      }

      const fetchStarted = Date.now();
      await connector.prepare(options.source, (m) => log.progress(`${vendor.slug}: ${m}`));
      const raw = await connector.fetchRaw(options.source, (m) => log.progress(`${vendor.slug}: ${m}`));
      log.progressEnd();

      const products: NormalizedProduct[] = [];
      let skipped = 0;
      for (const record of raw) {
        const normalized = connector.normalize(record);
        if (normalized) products.push(normalized);
        else skipped++;
      }
      log.info(
        `${vendor.slug}: fetched ${raw.length}, normalized ${products.length}` +
          (skipped ? `, skipped ${skipped}` : "") +
          ` in ${formatDuration(Date.now() - fetchStarted)}`,
      );

      const diff = await diffOffers(vendor, products, runId);
      summary.fetched += diff.fetched;
      summary.fetchedByVendor = summary.fetchedByVendor ?? {};
      summary.fetchedByVendor[vendor.slug] = (summary.fetchedByVendor[vendor.slug] ?? 0) + diff.fetched;
      summary.created += diff.created;
      summary.updated += diff.updated;
      summary.vanished += diff.vanished;

      // Terms are created before the writer runs so every product can resolve its term ids.
      const referenced = new Set<string>();
      for (const p of products) for (const ref of p.categoryRefs) referenced.add(ref);

      const categories = await syncCategories(vendor.id, connector.categories(), referenced);
      categoryMaps.set(vendor.id, categories.map);
      summary.termsCreated += categories.created;

      for (const p of products) {
        if (p.brand) brandValues.add(p.brand);
        for (const [key, value] of Object.entries(p.attributes)) {
          const taxonomy = ATTRIBUTE_TAXONOMIES[key];
          if (!taxonomy) continue;
          let bucket = attributeValues.get(taxonomy);
          if (!bucket) {
            bucket = new Set();
            attributeValues.set(taxonomy, bucket);
          }
          if (key === "volume") {
            const normalized = normalizeVolume(value, settings.volumeFilterMode);
            if (normalized) bucket.add(normalized);
          } else {
            bucket.add(value);
          }
        }
        // Do not sync pa_vendor — LPS storefront labels must not appear on product pages.
        // Retail vendor identity stays on `_sillage_vendor` postmeta only.
      }
    }

    const skippedAll =
      (summary.skippedVendors?.length ?? 0) > 0 &&
      selected.every((v) => summary.skippedVendors!.includes(v.slug));
    if (skippedAll) {
      log.warn("all selected vendors were inside their call interval — no catalogue writes");
      summary.durationMs = Date.now() - startedAt;
      await finishRun(runId, startedAt, summary);
      if (options.mode === "full" && !options.rewriteOnly) await restoreCatalogueRebuildFlag();
      return summary;
    }

    if (options.mode === "full") {
      const brands = await syncFlatTerms(BRAND_TAXONOMY, brandValues);
      summary.termsCreated += brands.created;

      const attributeMaps = new Map<string, Map<string, TermRef>>();
      for (const [taxonomy, values] of attributeValues) {
        const result = await syncFlatTerms(taxonomy, values);
        attributeMaps.set(taxonomy, result.map);
        summary.termsCreated += result.created;
      }

      const storefrontLabels: Record<string, string> = {};
      for (const v of allVendors) storefrontLabels[v.slug] = vendorStorefrontLabel(v);
      // Vendor lanes: `_sillage_vendor` meta only — strip LPS* product_cat and pa_vendor leftovers.
      if (!options.dryRun) {
        await purgeVendorProductCatLanes(allVendors, storefrontLabels);
        await purgeVendorProductAttributes();
        await purgeWholesalePerfumesBrandProductCats();
        await parkForeignVendorsFromStorefront();
      }

      await resolveProductIdentities(settings);
      await markDirtyFromPendingOffers();
      const reassigned = await selectPrimaryOffers(settings);
      if (reassigned > 0) log.info(`${reassigned} products changed their primary offer`);

      if (options.dryRun) {
        log.warn("dry run — no WooCommerce writes performed");
      } else {
        const ctx = await buildWriteContext(
          settings,
          allVendors,
          categoryMaps,
          brands.map,
          attributeMaps,
        );
        const written = await writePendingProducts(ctx, "full", (done, total) =>
          log.progress(`writing ${done}/${total}`),
        );
        log.progressEnd();
        summary.postsCreated = written.postsCreated;
        summary.postsUpdated = written.postsUpdated;
        summary.pricesUpdated = written.pricesUpdated;
        summary.errors += written.errors;
        summary.hiddenNoImage = written.hiddenNoImage;

        // Once per run, never per batch.
        await recountTerms(["product_cat", BRAND_TAXONOMY, ...Object.values(ATTRIBUTE_TAXONOMIES)]);
        await rebuildCategoryLookup();
        await finalizeWordPress();
        await writeProductSitemaps().catch((err) => {
          log.warn(`static sitemap write failed (shop data is still correct): ${String(err)}`);
        });
      }
    } else if (!options.dryRun) {
      // BTS delta used to set offer.status='pending' and return without ever
      // marking sil_products dirty, so WooCommerce never saw BTS price/stock.
      await resolveProductIdentities(settings);
      if (summary.created > 0) {
        const reassigned = await selectPrimaryOffers(settings);
        if (reassigned > 0) log.info(`${reassigned} products changed their primary offer`);
      }
      const priced = await markPriceDirtyFromPendingOffers();
      if (priced > 0) log.info(`${priced} products marked for a price/stock write`);

      const ctx = await buildWriteContext(settings, allVendors, new Map(), new Map(), new Map());
      const written = await writePendingProducts(ctx, "fast", (done, total) =>
        log.progress(`writing ${done}/${total}`),
      );
      log.progressEnd();
      summary.pricesUpdated = written.pricesUpdated;
      summary.errors += written.errors;
      summary.hiddenNoImage = written.hiddenNoImage;

      const unposted = await countUnpostedDirty();
      if (unposted > 0) {
        log.info(`${unposted} new products need WooCommerce posts`);
        const ctxFull = await buildRewriteWriteContext(settings, allVendors);
        const created = await writePendingProducts(
          ctxFull,
          "full",
          (done, total) => log.progress(`creating ${done}/${total}`),
          { unpostedOnly: true },
        );
        log.progressEnd();
        summary.postsCreated += created.postsCreated;
        summary.postsUpdated += created.postsUpdated;
        summary.pricesUpdated += created.pricesUpdated;
        summary.errors += created.errors;
        summary.hiddenNoImage += created.hiddenNoImage;
      }

      // Stock changes move products in and out of the catalogue, so counts shift.
      await recountTerms(["product_cat", BRAND_TAXONOMY]);
      await finalizeWordPress();
      // New Woo posts from this fast tick should be listed. Price/stock-only
      // changes must not rebuild the sitemap (that would recrawl PHP).
      if (summary.postsCreated > 0) {
        await writeProductSitemaps().catch((err) => {
          log.warn(`static sitemap write failed (shop data is still correct): ${String(err)}`);
        });
      }
    }

    summary.durationMs = Date.now() - startedAt;
    await finishRun(runId, startedAt, summary);

    log.info(
      `run ${runId} finished in ${formatDuration(summary.durationMs)} — ` +
        `${summary.postsCreated} created, ${summary.postsUpdated} updated, ` +
        `${summary.pricesUpdated} repriced, ${summary.vanished} vanished, ` +
        `${summary.hiddenNoImage} hidden (no image), ${summary.errors} errors`,
    );
    return summary;
  } catch (err) {
    summary.durationMs = Date.now() - startedAt;
    const aborted = err instanceof SyncAbortedError || String(err).includes("aborted");
    if (runId > 0) {
      if (options.mode === "full" && !options.rewriteOnly) {
        await restoreCatalogueRebuildFlag();
      }
      await finishRun(runId, startedAt, summary, err);
      await recordEvent(
        aborted ? "warn" : "error",
        "sync",
        `run ${runId} ${aborted ? "aborted" : "failed"}: ${String(err)}`,
        undefined,
        runId,
      );
    } else {
      await recordEvent("error", "sync", `sync failed before run row: ${String(err)}`);
    }
    throw err;
  } finally {
    let releasedOk = !lockHeld;
    if (lockHeld) {
      try {
        await releaseLockOn(lockConn, "sync");
        releasedOk = true;
      } catch (err) {
        log.error(`failed to RELEASE_LOCK(${lockName("sync")}): ${String(err)}`);
      }
      lockHeld = false;
    }
    // Never return a connection that still holds GET_LOCK to the pool — that leaves
    // every later Save queued forever until the process restarts.
    if (releasedOk) lockConn.release();
    else lockConn.destroy();
    // Settings/vendor pricing saves may have marked dirty while we held the lock — pick them up.
    const { drainPendingRewrites } = await import("./pendingRewrite.ts");
    await drainPendingRewrites();
  }
}

/**
 * The 30-minute cadence.
 *
 * BTS exposes a real delta endpoint. BeautyFort does not, so it re-downloads the whole 3.5 MB
 * stock file and diffs locally — still only a few seconds, and far cheaper than a full rewrite.
 */
async function fastSyncVendor(
  vendor: Vendor,
  connector: ReturnType<typeof createConnector>,
  options: SyncOptions,
  runId: number,
  summary: SyncSummary,
): Promise<number> {
  if (options.source === "live" && vendor.slug !== "wholesale-perfumes") {
    const gate = await checkLiveGate(vendor.slug as CacheVendor);
    if (!gate.allow) {
      // Do not fall back to a stale on-disk feed — operator/schedule must wait out the cooldown.
      log.warn(`${vendor.slug}: skipping live price/stock sync — ${gate.reason}`);
      summary.skippedVendors = [...(summary.skippedVendors ?? []), vendor.slug];
      return 0;
    }
  }

  // After a long gap the BTS delta window (even floored) cannot resurrect vanished
  // SKUs or refresh last_seen on the unchanged majority. Rebuild from the full feed.
  let forceFullFeed = false;
  if (vendor.slug === "bts") {
    const stale = await staleOfferRatio(vendor.id, 7 * 24);
    if (stale > 0.25) {
      log.warn(
        `${vendor.slug}: ${Math.round(stale * 100)}% of offers unseen for 7d — pulling the full catalogue`,
      );
      forceFullFeed = true;
    }
  }

  if (!forceFullFeed && connector.fetchPriceStock && options.source === "live") {
    // wholesale-perfumes store feed has its own hourly gate inside fetchPriceStock.
    const sharedGate = vendor.slug !== "wholesale-perfumes";
    const lastVendorSuccess = await lastSuccessfulRun(vendor.id);
    const since = resolveDeltaSince({ lastSuccessAt: lastVendorSuccess, vendorId: vendor.slug });
    try {
      const updates = await connector.fetchPriceStock(since, (m) => log.progress(`${vendor.slug}: ${m}`));
      log.progressEnd();
      if (updates) {
        if (sharedGate) await recordLiveFetch(vendor.slug as CacheVendor);
        const ids = updates.map((u) => u.vendorProductId);
        const known = await existingVendorProductIds(vendor.id, ids);
        const matched = vendor.slug === "wholesale-perfumes"
          ? updates.filter((u) => known.has(u.vendorProductId))
          : updates;
        // Fetched = SKUs in our catalogue we compared, not raw vendor XML lines.
        // wholesale-perfumes store XML has many rows per product id.
        summary.fetched += matched.length;
        summary.fetchedByVendor = summary.fetchedByVendor ?? {};
        summary.fetchedByVendor[vendor.slug] = (summary.fetchedByVendor[vendor.slug] ?? 0) + matched.length;
        if (vendor.slug === "bts") summary.btsDelta = true;
        const changed = await applyPriceStockDelta(vendor.id, matched);
        summary.updated += changed;

        try {
          const imported = await importMissingDeltaProducts({
            vendor,
            connector,
            updates: vendor.slug === "wholesale-perfumes" ? matched : updates,
            since,
            runId,
            summary,
          });
          return changed + imported;
        } catch (err) {
          // Delta prices/stock already applied. Do not fall through to a full
          // catalogue pull — that would re-hit the vendor and trip the call interval.
          log.warn(`${vendor.slug}: importing new SKUs from delta failed: ${String(err)}`);
          return changed;
        }
      }
    } catch (err) {
      log.warn(`${vendor.slug}: delta fetch failed, falling back to a full feed diff`, String(err));
    }
  }
  // BeautyFort, stale BTS recovery, and delta miss: pull the full feed and diff by checksum.
  // source=local|cache reads fixtures/disk; source=live hits the vendor (gate already checked).
  try {
    await connector.prepare(options.source, (m) => log.progress(`${vendor.slug}: ${m}`));
    const raw = await connector.fetchRaw(options.source, (m) => log.progress(`${vendor.slug}: ${m}`));
    log.progressEnd();

    const products = raw.map((r) => connector.normalize(r)).filter((p): p is NormalizedProduct => p !== null);
    const diff = await diffOffers(vendor, products, runId);
    summary.fetched += diff.fetched;
    summary.fetchedByVendor = summary.fetchedByVendor ?? {};
    summary.fetchedByVendor[vendor.slug] = (summary.fetchedByVendor[vendor.slug] ?? 0) + diff.fetched;
    summary.updated += diff.updated;
    summary.created += diff.created;
    summary.vanished += diff.vanished;

    return diff.updated + diff.vanished;
  } catch (err) {
    if (String(err).includes("live fetch blocked")) {
      log.warn(`${vendor.slug}: full-feed fallback skipped — ${String(err)}`);
      summary.skippedVendors = [...(summary.skippedVendors ?? []), vendor.slug];
      return 0;
    }
    throw err;
  }
}

/**
 * Delta rows only UPDATE existing offers. SKUs BTS added since the last full
 * import never get a row — pull their catalogue records and upsert without
 * vanishing the rest of the vendor.
 */
async function importMissingDeltaProducts(opts: {
  vendor: Vendor;
  connector: ReturnType<typeof createConnector>;
  updates: Array<{ vendorProductId: string; sku?: string }>;
  since: Date;
  runId: number;
  summary: SyncSummary;
}): Promise<number> {
  const { vendor, connector, updates, since, runId, summary } = opts;
  if (!connector.fetchNormalizedBySkus) return 0;

  const missing = new Map<string, string>();
  const deltaIds = updates.map((u) => u.vendorProductId);
  const known = await existingVendorProductIds(vendor.id, deltaIds);
  for (const u of updates) {
    if (known.has(u.vendorProductId)) continue;
    const sku = u.sku?.trim();
    if (sku) missing.set(u.vendorProductId, sku);
  }

  if (connector.fetchNewProductKeys) {
    const days = Math.min(30, Math.max(1, Math.ceil((Date.now() - since.getTime()) / 86_400_000)));
    try {
      const news = await connector.fetchNewProductKeys(days, (m) => log.progress(`${vendor.slug}: ${m}`));
      log.progressEnd();
      const newsIds = news.map((n) => n.vendorProductId);
      const newsKnown = await existingVendorProductIds(vendor.id, newsIds);
      for (const n of news) {
        if (newsKnown.has(n.vendorProductId)) continue;
        if (n.sku) missing.set(n.vendorProductId, n.sku);
      }
    } catch (err) {
      log.warn(`${vendor.slug}: new-products listing failed: ${String(err)}`);
    }
  }

  if (missing.size === 0) return 0;

  const skus = [...new Set(missing.values())];
  const products = await connector.fetchNormalizedBySkus(skus, (m) => log.progress(`${vendor.slug}: ${m}`));
  log.progressEnd();
  if (products.length === 0) return 0;

  const diff = await diffOffers(vendor, products, runId, { vanish: false });
  summary.created += diff.created;
  summary.updated += diff.updated;
  log.info(`${vendor.slug}: imported ${diff.created} new SKUs from the delta/new-products feed`);
  return diff.created + diff.updated;
}

async function countUnpostedDirty(): Promise<number> {
  const [row] = await query<RowDataPacket & { n: number }>(
    `SELECT COUNT(*) AS n FROM ${sil("sil_products")} p
       JOIN ${sil("sil_offers")} o ON o.id = p.primary_offer_id
      WHERE p.wp_post_id IS NULL
        AND (p.needs_content_write = 1 OR p.needs_price_write = 1)`,
  );
  return Number(row?.n ?? 0);
}

/**
 * Rebuild a full write context from DB maps — no vendor feed fetch.
 * rewrite-only used to pass empty maps, which deleted every product_cat / brand relationship.
 */
async function buildRewriteWriteContext(
  settings: GlobalSettings,
  allVendors: Vendor[],
): Promise<WriteContext> {
  const categoryMaps = await loadCategoryMapsFromDb(allVendors.map((v) => v.id));
  const brandMap = await loadFlatTermMapFromDb(BRAND_TAXONOMY);
  const attributeMaps = new Map<string, Map<string, TermRef>>();
  for (const taxonomy of new Set(Object.values(ATTRIBUTE_TAXONOMIES))) {
    attributeMaps.set(taxonomy, await loadFlatTermMapFromDb(taxonomy));
  }
  const storefrontLabels: Record<string, string> = {};
  for (const v of allVendors) storefrontLabels[v.slug] = vendorStorefrontLabel(v);
  await purgeVendorProductCatLanes(allVendors, storefrontLabels);
  await purgeVendorProductAttributes();
  await purgeWholesalePerfumesBrandProductCats();
  await parkForeignVendorsFromStorefront();
  return buildWriteContext(settings, allVendors, categoryMaps, brandMap, attributeMaps);
}

async function lastSuccessfulRun(vendorId: number): Promise<Date> {
  const rows = await query<RowDataPacket & { started_at: string }>(
    `SELECT started_at FROM ${sil("sil_sync_runs")}
      WHERE (vendor_id = ? OR vendor_id IS NULL) AND status IN ('success','partial')
      ORDER BY started_at DESC LIMIT 1`,
    [vendorId],
  );
  const value = rows[0]?.started_at;
  // With no prior run, look back far enough to be useful but inside the endpoint's 30-day cap.
  if (!value) return new Date(Date.now() - 7 * 24 * 60 * 60 * 1000);
  // Overlap by a few minutes so a change landing mid-run is not missed.
  return new Date(new Date(`${value.replace(" ", "T")}Z`).getTime() - 5 * 60 * 1000);
}

export { env };
