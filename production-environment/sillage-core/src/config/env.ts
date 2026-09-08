import { randomBytes } from "node:crypto";
import { resolve } from "node:path";

function str(key: string, fallback?: string): string {
  const v = process.env[key];
  if (v !== undefined && v !== "") return v;
  if (fallback !== undefined) return fallback;
  throw new Error(`Missing required environment variable ${key}`);
}

function opt(key: string, fallback = ""): string {
  return process.env[key] ?? fallback;
}

/** Never default to "admin" — that value is pre-filled by attackers. */
function dashboardUser(): string {
  const v = (process.env.DASHBOARD_USER ?? "").trim();
  if (v.toLowerCase() === "admin") {
    throw new Error('DASHBOARD_USER must not be "admin"');
  }
  if (v) return v;
  if ((process.env.NODE_ENV ?? "development") === "production") {
    throw new Error("Missing required environment variable DASHBOARD_USER");
  }
  return "operator";
}

function int(key: string, fallback: number): number {
  const v = process.env[key];
  if (v === undefined || v === "") return fallback;
  const n = Number.parseInt(v, 10);
  if (Number.isNaN(n)) throw new Error(`Environment variable ${key} must be an integer`);
  return n;
}

function bool(key: string, fallback: boolean): boolean {
  const v = process.env[key];
  if (v === undefined || v === "") return fallback;
  return v === "true" || v === "1" || v === "yes";
}

const rootDir = resolve(import.meta.dir, "../..");

const lockPrefix = opt("SILLAGE_LOCK_PREFIX") || "sillage-wholesale";

export const env = {
  rootDir,
  /** wholesale-perfumes shop. Retail is unseencurtain/Sillage. */
  sillageProfile: "wholesale" as const,
  /** MariaDB GET_LOCK / IS_USED_LOCK prefix. Must differ per storefront on a shared server. */
  lockPrefix,
  nodeEnv: opt("NODE_ENV", "development"),
  isProduction: opt("NODE_ENV", "development") === "production",
  logLevel: opt("LOG_LEVEL", "info"),
  port: int("PORT", 4000),

  db: {
    host: str("DB_HOST", "127.0.0.1"),
    port: int("DB_PORT", 3308),
    user: str("DB_USER", "sillage"),
    password: str("SILLAGE_DB_PASSWORD"),
    /** sillage-core's own schema. */
    sillage: str("SILLAGE_DB", "sillage_wpf"),
    wordpress: str("WORDPRESS_DB", "earth_wpf"),
    wpPrefix: str("WP_TABLE_PREFIX", "wp_"),
    connectionLimit: int("DB_CONNECTION_LIMIT", 10),
  },

  wordpress: {
    baseUrl: str("WP_BASE_URL", "http://localhost").replace(/\/$/, ""),
    /** In-Docker URL for finalize / REST (e.g. http://ecom). Falls back to baseUrl. */
    internalUrl: (opt("WORDPRESS_INTERNAL_URL") || opt("WP_INTERNAL_URL") || "").replace(/\/$/, ""),
    sharedSecret: str("SILLAGE_SHARED_SECRET"),
  },

  wholesalePerfumes: {
    user: opt("WHOLESALE_PERFUMES_USER"),
    token: opt("WHOLESALE_PERFUMES_TOKEN"),
    catalogUrl: opt(
      "WHOLESALE_PERFUMES_CATALOG_URL",
      "https://www.wholesale-perfumes.eu/xml/catalog/LovelyXml/en",
    ),
    storeUrl: opt(
      "WHOLESALE_PERFUMES_STOCK_URL",
      "https://www.wholesale-perfumes.eu/xml/store/LovelyXml/EUR",
    ),
    apiBaseUrl: opt("WHOLESALE_PERFUMES_API_BASE_URL", "https://www.wholesale-perfumes.eu/api/v1"),
  },

  dashboard: {
    user: dashboardUser(),
    password: opt("DASHBOARD_PASSWORD"),
    sessionSecret: opt("SESSION_SECRET") || randomBytes(32).toString("hex"),
  },

  fixturesDir: resolve(rootDir, opt("FIXTURES_DIR", "../../.feedscratch")),
  /** Bind-mounted overlay written by the dashboard Secrets UI (gitignored). */
  secretsFile: resolve(rootDir, opt("SILLAGE_SECRETS_FILE", "data/secrets.overlay.env")),
};

/**
 * Re-read vendor API credentials from `process.env` into `env`.
 * Called after the secrets overlay is applied (boot / set / clear / sync start).
 */
export function refreshVendorSecretsFromProcessEnv(): void {
  env.wholesalePerfumes.user = opt("WHOLESALE_PERFUMES_USER");
  env.wholesalePerfumes.token = opt("WHOLESALE_PERFUMES_TOKEN");
}

/**
 * Apply dashboard-editable public URLs into runtime `env`.
 * Empty / whitespace values leave the current (env-bootstrap) value alone.
 */
export function applyRuntimeUrls(urls: { wpBaseUrl?: string; imageCdnBaseUrl?: string }): void {
  const shop = (urls.wpBaseUrl ?? "").trim().replace(/\/$/, "");
  if (shop) env.wordpress.baseUrl = shop;
  // image CDN is consumed via loadSettings(); no process.env mutation required for sync.
}

/** Fully-qualified WordPress table name. Never rely on a pooled connection's default schema. */
export function wp(table: string): string {
  return `\`${env.db.wordpress}\`.\`${env.db.wpPrefix}${table}\``;
}

/** Fully-qualified sillage table name. */
export function sil(table: string): string {
  return `\`${env.db.sillage}\`.\`${table}\``;
}

/** Advisory lock name. Retail uses `sillage:sync`; wholesale uses `sillage-wholesale:sync`. */
export function lockName(name: string): string {
  return `${env.lockPrefix}:${name}`;
}

export function isWholesaleProfile(): boolean {
  return true;
}
