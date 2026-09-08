/**
 * Pre-flight checks. Run this before the first import and any time something looks wrong.
 *
 *   bun run doctor
 *
 * Every check states what breaks if it fails, so the output is actionable rather than a list of
 * red crosses.
 */
import { env, sil, wp } from "../config/env.ts";
import { loadSecretsOverlay } from "../config/secrets.ts";
import { closePool, query, type RowDataPacket } from "../db/pool.ts";
import { loadSettings, loadVendors } from "../db/settings.ts";
import { signPayload } from "../lib/hmac.ts";
import { setLogLevel } from "../lib/log.ts";

setLogLevel("warn");
loadSecretsOverlay();

interface Check {
  name: string;
  ok: boolean;
  detail: string;
  consequence?: string;
}

const checks: Check[] = [];
const add = (name: string, ok: boolean, detail: string, consequence?: string): void => {
  checks.push({ name, ok, detail, consequence });
};

async function scalar<T = string>(sql: string, params: unknown[] = []): Promise<T | undefined> {
  const rows = await query<RowDataPacket>(sql, params);
  const row = rows[0];
  if (!row) return undefined;
  return Object.values(row)[0] as T;
}

// ── Database ────────────────────────────────────────────────────────────────
try {
  const version = await scalar<string>("SELECT VERSION()");
  add("Database reachable", true, `MariaDB ${version} at ${env.db.host}:${env.db.port}`);
} catch (err) {
  add("Database reachable", false, String(err), "Nothing works until this is fixed.");
}

for (const [name, minimum, label] of [
  ["max_allowed_packet", 64 * 1024 * 1024, "64 MB"],
  ["innodb_buffer_pool_size", 2 * 1024 * 1024 * 1024, "2 GB"],
] as const) {
  const value = Number(await scalar(`SELECT @@${name}`));
  add(
    `MariaDB ${name}`,
    value >= minimum,
    `${(value / 1024 / 1024).toFixed(0)} MB (want at least ${label})`,
    "The cold import will be very slow or fail on large statements.",
  );
}

const autoinc = Number(await scalar("SELECT @@innodb_autoinc_lock_mode"));
add(
  "innodb_autoinc_lock_mode",
  true,
  `${autoinc}${autoinc === 2 ? " (interleaved — the writer reads post ids back by slug)" : ""}`,
);

// ── Grants ──────────────────────────────────────────────────────────────────
for (const table of [
  "posts",
  "postmeta",
  "terms",
  "term_taxonomy",
  "term_relationships",
  "wc_product_meta_lookup",
  "wc_product_attributes_lookup",
  "wc_category_lookup",
]) {
  try {
    await query(`SELECT 1 FROM ${wp(table)} LIMIT 1`);
    add(`Read ${env.db.wpPrefix}${table}`, true, "granted");
  } catch (err) {
    add(`Read ${env.db.wpPrefix}${table}`, false, String(err), "The writer cannot maintain this table.");
  }
}

// ── WooCommerce configuration ───────────────────────────────────────────────
const currency = await scalar<string>(
  `SELECT option_value FROM ${wp("options")} WHERE option_name = 'woocommerce_currency'`,
);
add(
  "WooCommerce currency",
  currency === "EUR",
  String(currency),
  "Both vendors quote EUR; any other setting misprices the whole catalogue.",
);

const hpos = await scalar<string>(
  `SELECT option_value FROM ${wp("options")} WHERE option_name = 'woocommerce_custom_orders_table_enabled'`,
);
add("HPOS enabled", hpos === "yes", String(hpos), "Stage 2 reads orders from the wp_wc_orders tables.");

const attributes = (
  await query<RowDataPacket & { attribute_name: string }>(
    `SELECT attribute_name FROM ${wp("woocommerce_attribute_taxonomies")}`,
  )
).map((r) => `pa_${r.attribute_name}`);
for (const required of ["pa_gender", "pa_item-type", "pa_volume"]) {
  add(
    `Attribute ${required}`,
    attributes.includes(required),
    attributes.includes(required) ? "registered" : "missing",
    "Products will be written without this facet; activate sillage-bridge to create it.",
  );
}

const visibility = await query<RowDataPacket & { slug: string }>(
  `SELECT t.slug FROM ${wp("terms")} t
     JOIN ${wp("term_taxonomy")} tt ON tt.term_id = t.term_id
    WHERE tt.taxonomy = 'product_visibility'`,
);
const visibilitySlugs = visibility.map((v) => v.slug);
for (const required of ["exclude-from-catalog", "exclude-from-search", "outofstock"]) {
  add(
    `Visibility term ${required}`,
    visibilitySlugs.includes(required),
    visibilitySlugs.includes(required) ? "present" : "missing",
    "Out-of-stock products cannot be hidden without it.",
  );
}

// ── sillage schema ──────────────────────────────────────────────────────────
const silTables = (
  await query<RowDataPacket & { TABLE_NAME: string }>(
    `SELECT TABLE_NAME FROM information_schema.TABLES WHERE TABLE_SCHEMA = ?`,
    [env.db.sillage],
  )
).map((r) => r.TABLE_NAME);
for (const required of ["sil_vendors", "sil_settings", "sil_offers", "sil_products", "sil_ean_index"]) {
  add(`Table ${required}`, silTables.includes(required), silTables.includes(required) ? "present" : "missing", "Run `bun run migrate`.");
}

const vendors = await loadVendors();
add(
  "Vendors registered",
  vendors.length > 0,
  vendors.map((v) => `${v.slug}${v.active ? "" : " (inactive)"}`).join(", ") || "none",
);

const settings = await loadSettings();
add(
  "Pricing",
  true,
  `multiplier ${settings.priceMultiplier}, stock threshold ${settings.stockThreshold}, ` +
    `dedupe ${settings.dedupeByEan ? "on" : "off"}, descriptions ${settings.descriptionMode}`,
);
add(
  "Order safety rails",
  settings.ordersDryRun || !settings.ordersAutoDispatch,
  `dry run ${settings.ordersDryRun ? "on" : "OFF"}, auto-dispatch ${settings.ordersAutoDispatch ? "ON" : "off"}, ` +
    `ceiling EUR ${settings.ordersMaxValueEur}, daily cap EUR ${settings.ordersDailyCapEur}`,
  "Both rails are off — vendor orders will be placed with real money automatically.",
);

// ── Credentials ─────────────────────────────────────────────────────────────
add(
  "wholesale-perfumes credentials",
  Boolean(env.wholesalePerfumes.user && env.wholesalePerfumes.token),
  env.wholesalePerfumes.user ? "set" : "missing",
);
add(
  "Shared secret",
  env.wordpress.sharedSecret.length >= 32,
  `${env.wordpress.sharedSecret.length} characters`,
  "The WordPress bridge endpoints will reject sillage-core.",
);

// ── The bridge plugin ───────────────────────────────────────────────────────
try {
  const body = "";
  const response = await fetch(`${env.wordpress.baseUrl}/wp-json/sillage/v1/status`, {
    headers: { "X-Sillage-Signature": signPayload(body, env.wordpress.sharedSecret) },
    signal: AbortSignal.timeout(15_000),
  });

  if (response.ok) {
    const status = (await response.json()) as Record<string, unknown>;
    add(
      "sillage-bridge plugin",
      true,
      `v${status["plugin_version"]}, WooCommerce ${status["woocommerce_version"]}, ` +
        `${status["published_products"]} published products`,
    );
    add(
      "EAN index readable by WordPress",
      status["ean_index_readable"] === true,
      String(status["ean_index_readable"]),
      "Barcode search will fall back to the default title search.",
    );
    add("WP-Cron disabled", status["wp_cron_disabled"] === true, String(status["wp_cron_disabled"]),
      "WordPress will run its own scheduler alongside the container cron.");
  } else {
    add(
      "sillage-bridge plugin",
      false,
      `HTTP ${response.status} from ${env.wordpress.baseUrl}`,
      response.status === 401 || response.status === 403
        ? "The shared secret does not match SILLAGE_SHARED_SECRET in wp-config.php."
        : "Is the plugin activated?",
    );
  }
} catch (err) {
  add("sillage-bridge plugin", false, String(err), `Cannot reach ${env.wordpress.baseUrl}.`);
}

// ── Fixtures ────────────────────────────────────────────────────────────────
for (const file of ["wholesale_perfumes_catalog.xml", "wholesale_perfumes_store.xml"]) {
  const handle = Bun.file(`${env.fixturesDir}/${file}`);
  const exists = await handle.exists();
  add(
    `Fixture ${file}`,
    exists,
    exists ? `${(handle.size / 1_048_576).toFixed(1)} MB` : "missing",
    "`--source=local` will fail; run `bun run src/cli/fixtures.ts`.",
  );
}

// ── Catalogue state ─────────────────────────────────────────────────────────
const offers = Number(await scalar(`SELECT COUNT(*) FROM ${sil("sil_offers")}`));
const products = Number(await scalar(`SELECT COUNT(*) FROM ${sil("sil_products")}`));
const published = Number(
  await scalar(`SELECT COUNT(*) FROM ${wp("posts")} WHERE post_type = 'product' AND post_status = 'publish'`),
);
const catalogVisible = Number(
  await scalar(
    `SELECT COUNT(*) FROM ${wp("posts")} p
      WHERE p.post_type = 'product' AND p.post_status = 'publish'
        AND NOT EXISTS (
          SELECT 1 FROM ${wp("term_relationships")} tr
          JOIN ${wp("term_taxonomy")} tt ON tt.term_taxonomy_id = tr.term_taxonomy_id
          JOIN ${wp("terms")} t ON t.term_id = tt.term_id
          WHERE tr.object_id = p.ID
            AND tt.taxonomy = 'product_visibility'
            AND t.slug = 'exclude-from-catalog'
        )`,
  ),
);
add(
  "Catalogue",
  true,
  `${offers} offers, ${products} products, ${catalogVisible} visible in shop / ${published} published`,
);

const visibleWithoutPhoto = Number(
  await scalar(
    `SELECT COUNT(*) FROM ${wp("posts")} p
      LEFT JOIN ${wp("postmeta")} thumb
        ON thumb.post_id = p.ID AND thumb.meta_key = '_external_thumbnail_url'
     WHERE p.post_type = 'product' AND p.post_status = 'publish'
       AND NOT EXISTS (
         SELECT 1 FROM ${wp("term_relationships")} tr
         JOIN ${wp("term_taxonomy")} tt ON tt.term_taxonomy_id = tr.term_taxonomy_id
         JOIN ${wp("terms")} t ON t.term_id = tt.term_id
         WHERE tr.object_id = p.ID
           AND tt.taxonomy = 'product_visibility'
           AND t.slug = 'exclude-from-catalog'
       )
       AND (
         thumb.meta_value IS NULL
         OR TRIM(thumb.meta_value) = ''
         OR LOWER(TRIM(thumb.meta_value)) IN ('none', 'null')
         OR LOWER(TRIM(thumb.meta_value)) NOT REGEXP '^https?://'
         OR LOWER(thumb.meta_value) LIKE '%no_image%'
         OR LOWER(thumb.meta_value) LIKE '%placeholder%'
       )`,
  ),
);
add(
  "No placeholder on the shop",
  visibleWithoutPhoto === 0,
  visibleWithoutPhoto === 0
    ? "every catalogue-visible product has a real http(s) photo"
    : `${visibleWithoutPhoto} published + catalog-visible products have junk or empty Woo thumbs`,
  "Shoppers see the grey WooCommerce camera. Hide those SKUs or write a real URL.",
);

// ── Report ──────────────────────────────────────────────────────────────────
const width = Math.max(...checks.map((c) => c.name.length)) + 2;
let failed = 0;

console.log("");
for (const check of checks) {
  const mark = check.ok ? "\x1b[32m ok \x1b[0m" : "\x1b[31mFAIL\x1b[0m";
  console.log(`  ${mark}  ${check.name.padEnd(width)}${check.detail}`);
  if (!check.ok) {
    failed++;
    if (check.consequence) console.log(`        ${" ".repeat(width)}\x1b[33m${check.consequence}\x1b[0m`);
  }
}
console.log("");
console.log(failed === 0 ? `  All ${checks.length} checks passed.` : `  ${failed} of ${checks.length} checks failed.`);
console.log("");

await closePool();
process.exitCode = failed > 0 ? 1 : 0;
