/**
 * Company billing profiles and per-order delivery/billing JSON helpers.
 * Dashboard edits stay in Sillage — WooCommerce addresses are never written from here.
 */
import { sil } from "../config/env.ts";
import { query, type RowDataPacket } from "../db/pool.ts";
import { setSetting } from "../db/settings.ts";
import type { OrderAddress } from "./types.ts";

export interface CompanyBillingAddress extends OrderAddress {
  /** VAT / BTW number — used on invoices where the vendor supports it. */
  vat: string;
}

const empty = (): OrderAddress => ({
  firstName: "",
  lastName: "",
  company: "",
  address1: "",
  address2: "",
  city: "",
  state: "",
  postcode: "",
  country: "",
  email: "",
  phone: "",
});

export function emptyCompanyBilling(): CompanyBillingAddress {
  return { ...empty(), vat: "" };
}

export function emptyOrderAddress(): OrderAddress {
  return empty();
}

/** Normalize arbitrary JSON (DB or request body) into OrderAddress. */
export function parseOrderAddress(raw: unknown): OrderAddress | null {
  if (!raw || typeof raw !== "object") return null;
  const o = raw as Record<string, unknown>;
  const str = (k: string, alt?: string) => String(o[k] ?? (alt ? o[alt] : "") ?? "");
  const address1 = str("address1", "address_1");
  const country = str("country").toUpperCase();
  if (!address1 || !country) return null;
  return {
    firstName: str("firstName", "first_name"),
    lastName: str("lastName", "last_name"),
    company: str("company"),
    address1,
    address2: str("address2", "address_2"),
    city: str("city"),
    state: str("state"),
    postcode: str("postcode"),
    country,
    email: str("email"),
    phone: str("phone"),
  };
}

export function parseCompanyBilling(raw: unknown): CompanyBillingAddress {
  const base = parseOrderAddress(raw) ?? empty();
  const vat =
    raw && typeof raw === "object" ? String((raw as Record<string, unknown>).vat ?? "") : "";
  return { ...base, vat };
}

function parseJsonColumn(raw: unknown): unknown {
  if (raw == null) return null;
  if (typeof raw === "string") {
    try {
      return JSON.parse(raw);
    } catch {
      return null;
    }
  }
  return raw;
}

export function companyBillingSettingKey(_vendorSlug: string): string {
  return "company_billing_wholesale_perfumes";
}

export async function loadCompanyBilling(vendorSlug: string): Promise<CompanyBillingAddress> {
  const key = companyBillingSettingKey(vendorSlug);
  const rows = await query<RowDataPacket & { setting_value: string }>(
    `SELECT setting_value FROM ${sil("sil_settings")} WHERE setting_key = ?`,
    [key],
  );
  if (!rows[0]?.setting_value) return emptyCompanyBilling();
  try {
    return parseCompanyBilling(JSON.parse(rows[0].setting_value));
  } catch {
    return emptyCompanyBilling();
  }
}

export async function saveCompanyBilling(
  vendorSlug: string,
  address: CompanyBillingAddress,
): Promise<void> {
  await setSetting(companyBillingSettingKey(vendorSlug), JSON.stringify(address));
}

/**
 * Delivery for dispatch: per-order JSON override, else fallback address (usually live WC).
 */
export function resolveDeliveryAddress(
  deliveryJson: unknown,
  fallback: OrderAddress | null,
  destinationCountry: string,
): OrderAddress {
  const fromJson = parseOrderAddress(parseJsonColumn(deliveryJson));
  if (fromJson) return fromJson;
  if (fallback && fallback.address1 && fallback.country) return fallback;
  return { ...empty(), country: destinationCountry.toUpperCase() };
}

/**
 * Invoice / billing for vendors that support it: per-order override, else company profile.
 */
export async function resolveBillingAddress(
  billingJson: unknown,
  vendorSlug: string,
): Promise<CompanyBillingAddress> {
  const fromJson = parseCompanyBilling(parseJsonColumn(billingJson) ?? {});
  if (fromJson.address1 && fromJson.country) return fromJson;
  return loadCompanyBilling(vendorSlug);
}

export function addressHasContent(a: OrderAddress): boolean {
  return Boolean(a.address1 && a.country);
}
