/**
 * Operator-managed vendor API secrets.
 *
 * Compose injects the main `.env` once at container start. Writing that file from inside
 * the container does not update `process.env`. Instead we persist allow-listed keys to a
 * bind-mounted overlay (`SILLAGE_SECRETS_FILE`, default `data/secrets.overlay.env`), apply
 * them into `process.env` + `env` on load, and re-apply at the start of each sync so cron
 * picks up dashboard changes without a container recreate.
 *
 * GET never returns secret values — only set/empty + source.
 */
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { env, refreshVendorSecretsFromProcessEnv } from "./env.ts";

export const MANAGED_SECRETS = [
  { key: "WHOLESALE_PERFUMES_USER", label: "wholesale-perfumes user" },
  { key: "WHOLESALE_PERFUMES_TOKEN", label: "wholesale-perfumes token" },
] as const;

export type ManagedSecretKey = (typeof MANAGED_SECRETS)[number]["key"];

const MANAGED_KEY_SET = new Set<string>(MANAGED_SECRETS.map((s) => s.key));

export type SecretSource = "overlay" | "env" | "unset";

export interface SecretStatus {
  key: ManagedSecretKey;
  label: string;
  set: boolean;
  source: SecretSource;
  /** Present only when set — never the real value. */
  masked: string;
}

function isManagedKey(key: string): key is ManagedSecretKey {
  return MANAGED_KEY_SET.has(key);
}

/** Parse a minimal dotenv file (KEY=VALUE, optional quotes, # comments). */
export function parseEnvFile(text: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith("#")) continue;
    const eq = line.indexOf("=");
    if (eq <= 0) continue;
    const key = line.slice(0, eq).trim();
    let value = line.slice(eq + 1).trim();
    if (value.startsWith('"') && value.endsWith('"')) {
      value = value.slice(1, -1).replace(/\\"/g, '"').replace(/\\\\/g, "\\");
    } else if (value.startsWith("'") && value.endsWith("'")) {
      value = value.slice(1, -1);
    }
    out[key] = value;
  }
  return out;
}

export function serializeEnvFile(map: Record<string, string>): string {
  const lines = [
    "# Sillage secrets overlay — written by the operator dashboard. Gitignored.",
    "# Applied on boot and at the start of each sync (hot-reload). Do not commit.",
    "",
  ];
  for (const { key } of MANAGED_SECRETS) {
    if (map[key] === undefined) continue;
    const value = map[key]!;
    // Quote when needed so spaces / # survive a round-trip.
    const needsQuote = /[\s#"']/.test(value) || value === "";
    lines.push(needsQuote ? `${key}="${value.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"` : `${key}=${value}`);
  }
  lines.push("");
  return lines.join("\n");
}

function readOverlayMap(): Record<string, string> {
  const path = env.secretsFile;
  if (!existsSync(path)) return {};
  return parseEnvFile(readFileSync(path, "utf8"));
}

function writeOverlayMap(map: Record<string, string>): void {
  const path = env.secretsFile;
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, serializeEnvFile(map), { encoding: "utf8", mode: 0o600 });
  try {
    chmodSync(path, 0o600);
  } catch {
    // ignore chmod failures on odd filesystems
  }
}

/** Apply overlay keys into process.env + env.*; overlay wins over compose-injected values. */
export function loadSecretsOverlay(): { path: string; applied: number } {
  const path = env.secretsFile;
  if (!existsSync(path)) {
    refreshVendorSecretsFromProcessEnv();
    return { path, applied: 0 };
  }
  const map = readOverlayMap();
  let applied = 0;
  for (const { key } of MANAGED_SECRETS) {
    if (map[key] === undefined) continue;
    process.env[key] = map[key]!;
    applied += 1;
  }
  refreshVendorSecretsFromProcessEnv();
  return { path, applied };
}

export function listSecretStatus(): { path: string; secrets: SecretStatus[] } {
  const overlay = readOverlayMap();
  const secrets: SecretStatus[] = MANAGED_SECRETS.map(
    ({ key, label }) => {
      const overlayVal = overlay[key];
      const inOverlay = typeof overlayVal === "string" && overlayVal.length > 0;
      const envVal = process.env[key] ?? "";
      const inEnv = envVal.length > 0;
      const source: SecretSource = inOverlay ? "overlay" : inEnv ? "env" : "unset";
      return {
        key,
        label,
        set: inEnv || inOverlay,
        source,
        masked: inEnv || inOverlay ? "••••••••" : "",
      };
    },
  );
  return { path: env.secretsFile, secrets };
}

export function setSecret(key: string, value: string): SecretStatus {
  if (!isManagedKey(key)) throw new Error(`Secret key not allowed: ${key}`);
  const trimmed = value.trim();
  if (!trimmed) throw new Error("Secret value must not be empty — use Clear instead");

  const map = readOverlayMap();
  map[key] = trimmed;
  writeOverlayMap(map);
  process.env[key] = trimmed;
  refreshVendorSecretsFromProcessEnv();

  return (
    listSecretStatus().secrets.find((s) => s.key === key) ?? {
      key,
      label: MANAGED_SECRETS.find((s) => s.key === key)?.label ?? key,
      set: true,
      source: "overlay",
      masked: "••••••••",
    }
  );
}

export function clearSecret(key: string): SecretStatus {
  if (!isManagedKey(key)) throw new Error(`Secret key not allowed: ${key}`);

  const map = readOverlayMap();
  delete map[key];
  writeOverlayMap(map);
  delete process.env[key];
  refreshVendorSecretsFromProcessEnv();

  return (
    listSecretStatus().secrets.find((s) => s.key === key) ?? {
      key,
      label: MANAGED_SECRETS.find((s) => s.key === key)?.label ?? key,
      set: false,
      source: "unset",
      masked: "",
    }
  );
}
