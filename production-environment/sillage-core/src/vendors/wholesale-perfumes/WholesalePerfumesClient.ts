/**
 * wholesale-perfumes.eu (SoleLuna) HTTP Basic client.
 *
 * Feeds: catalog XML (daily) and store XML (hourly price/stock).
 * Order API: account-global cart → submit. There is no sandbox — callers must honour dry-run.
 *
 * Cart/order JSON uses an application-level `error` field (0 = OK) on HTTP 200 — see
 * docs/vendors/wholesale-perfumes-api.md. Never call the live host from tests; use the
 * parse helpers + fixtures.
 */
import { XMLParser } from "fast-xml-parser";

export interface WholesalePerfumesClientConfig {
  /** E-shop login email. */
  user: string;
  /** API token from user settings (not the shop password). */
  token: string;
  catalogUrl: string;
  storeUrl: string;
  /** Base for cart/order API, e.g. https://www.wholesale-perfumes.eu/api/v1 */
  apiBaseUrl: string;
  timeout?: number;
}

/** Documented cart/submit application codes (HTTP status is often still 200). */
export const WHOLESALE_PERFUMES_API = {
  OK: 0,
  NOT_ENOUGH_STOCK: 3,
  OPERATION_FAILED: 8,
  DELIVERY_TYPE_NOT_CHOSEN: 1005,
  CART_EMPTY: 1012,
  DELIVERY_COUNTRY_UNSUPPORTED: 1018,
  ITEM_OUT_OF_STOCK: 1030,
  VARIATION_NOT_CHOSEN: 1031,
} as const;

/** Clear rejections — order was not created. Safe to mark failed (not ambiguous). */
export const WHOLESALE_PERFUMES_CLEAR_REJECT_CODES = new Set<number>([
  WHOLESALE_PERFUMES_API.NOT_ENOUGH_STOCK,
  WHOLESALE_PERFUMES_API.OPERATION_FAILED,
  WHOLESALE_PERFUMES_API.DELIVERY_TYPE_NOT_CHOSEN,
  WHOLESALE_PERFUMES_API.CART_EMPTY,
  WHOLESALE_PERFUMES_API.DELIVERY_COUNTRY_UNSUPPORTED,
  WHOLESALE_PERFUMES_API.ITEM_OUT_OF_STOCK,
  WHOLESALE_PERFUMES_API.VARIATION_NOT_CHOSEN,
]);

export interface WholesalePerfumesOrderView {
  orderNumber: string | null;
  statusCode: string | number | null;
  statusMsg: string | number | null;
  currency: string | null;
  orderItems: unknown[];
  raw: unknown;
}

export interface WholesalePerfumesCatalogProduct {
  id: string;
  ean: string;
  allEans: string[];
  typeId: string | null;
  typeName: string | null;
  brandId: string | null;
  brand: string | null;
  series: string | null;
  model: string | null;
  gender: string | null;
  volume: string | null;
  volumeUnit: string | null;
  typeInfo: string | null;
  nameAddon: string | null;
  setComposition: string | null;
  flaskFront: string | null;
  pictureUrls: string[];
  scents: { top: string[]; middle: string[]; base: string[] };
  params: Record<string, string[]>;
  /** Joined from the store feed when available. */
  priceNoVat?: number;
  quantity?: number;
}

export interface WholesalePerfumesStoreProduct {
  id: string;
  priceNoVat: number;
  quantity: number;
}

export interface WholesalePerfumesCartLine {
  code: string | number;
  quantity: number;
}

export class WholesalePerfumesRequestError extends Error {
  constructor(
    message: string,
    public readonly statusCode?: number,
    public readonly details?: unknown,
  ) {
    super(message);
    this.name = "WholesalePerfumesRequestError";
  }
}

/** JSON body reported `error != 0` (often still HTTP 200). */
export class WholesalePerfumesApiError extends WholesalePerfumesRequestError {
  constructor(
    message: string,
    public readonly apiError: number,
    details?: unknown,
  ) {
    super(message, undefined, details);
    this.name = "WholesalePerfumesApiError";
  }

  get isClearReject(): boolean {
    return WHOLESALE_PERFUMES_CLEAR_REJECT_CODES.has(this.apiError);
  }
}

export function readApiErrorCode(json: unknown): number | null {
  if (!json || typeof json !== "object") return null;
  const err = (json as Record<string, unknown>).error;
  if (err === undefined || err === null) return null;
  const n = typeof err === "number" ? err : Number(String(err).trim());
  return Number.isFinite(n) ? n : null;
}

export function assertApiOk(json: unknown, action: string): void {
  const code = readApiErrorCode(json);
  if (code === null || code === WHOLESALE_PERFUMES_API.OK) return;
  const message =
    json && typeof json === "object" && "message" in json
      ? String((json as { message?: unknown }).message ?? "").trim()
      : "";
  throw new WholesalePerfumesApiError(
    message
      ? `wholesale-perfumes ${action}: error ${code} — ${message}`
      : `wholesale-perfumes ${action}: error ${code}`,
    code,
    json,
  );
}

/** Pull `order_number` from a cart/submit or POST /order success body. */
export function extractOrderNumber(response: unknown): string | null {
  if (response === null || response === undefined) return null;
  if (typeof response === "string" || typeof response === "number") {
    const s = String(response).trim();
    return s || null;
  }
  if (typeof response === "object") {
    const obj = response as Record<string, unknown>;
    for (const key of ["order_number", "orderNumber", "number", "id", "order_id"]) {
      const v = obj[key];
      if (v !== undefined && v !== null && String(v).trim() !== "") return String(v).trim();
    }
  }
  return null;
}

/**
 * Parse GET /order/{order_number}. Vendor sample nests under `result.items[0]`
 * with `status_code` / `status_msg` (types in the sample are loose).
 */
export function parseOrderGetResponse(json: unknown): WholesalePerfumesOrderView {
  const empty: WholesalePerfumesOrderView = {
    orderNumber: null,
    statusCode: null,
    statusMsg: null,
    currency: null,
    orderItems: [],
    raw: json,
  };
  if (!json || typeof json !== "object") return empty;

  const root = json as Record<string, unknown>;
  const result = root.result;
  let item: Record<string, unknown> | null = null;

  if (result && typeof result === "object") {
    const items = (result as { items?: unknown }).items;
    if (Array.isArray(items) && items[0] && typeof items[0] === "object") {
      item = items[0] as Record<string, unknown>;
    } else if (items && typeof items === "object" && !Array.isArray(items)) {
      item = items as Record<string, unknown>;
    }
  }
  if (!item) {
    // Tolerate a flatter shape if the vendor ever returns one.
    if ("order_number" in root || "status_code" in root || "order_items" in root) {
      item = root;
    }
  }
  if (!item) return empty;

  const orderItemsRaw = item.order_items;
  const orderItems = Array.isArray(orderItemsRaw) ? orderItemsRaw : orderItemsRaw ? [orderItemsRaw] : [];

  return {
    orderNumber:
      item.order_number !== undefined && item.order_number !== null
        ? String(item.order_number).trim()
        : null,
    statusCode: item.status_code !== undefined && item.status_code !== null ? (item.status_code as string | number) : null,
    statusMsg: item.status_msg !== undefined && item.status_msg !== null ? (item.status_msg as string | number) : null,
    currency: item.currency !== undefined && item.currency !== null ? String(item.currency) : null,
    orderItems,
    raw: json,
  };
}

const xmlParser = new XMLParser({
  ignoreAttributes: false,
  attributeNamePrefix: "@_",
  // Keep numeric-looking EANs and ids as strings — leading zeros matter.
  parseTagValue: false,
  trimValues: true,
  isArray: (name) =>
    name === "product" ||
    name === "ean" ||
    name === "scent" ||
    name === "value" ||
    name === "param",
});

function asText(value: unknown): string {
  if (value === null || value === undefined) return "";
  if (typeof value === "string" || typeof value === "number" || typeof value === "boolean") {
    return String(value).trim();
  }
  if (typeof value === "object" && value !== null && "#text" in value) {
    return String((value as { "#text": unknown })["#text"] ?? "").trim();
  }
  return "";
}

function asAttr(value: unknown, attr: string): string {
  if (!value || typeof value !== "object") return "";
  return String((value as Record<string, unknown>)[`@_${attr}`] ?? "").trim();
}

function textList(value: unknown): string[] {
  if (value === null || value === undefined || value === "") return [];
  if (Array.isArray(value)) return value.map(asText).filter(Boolean);
  const one = asText(value);
  return one ? [one] : [];
}

function firstPicture(pictures: unknown): { flaskFront: string | null; urls: string[] } {
  if (!pictures || typeof pictures !== "object") return { flaskFront: null, urls: [] };
  const obj = pictures as Record<string, unknown>;
  const urls: string[] = [];
  let flaskFront: string | null = null;
  for (const [slot, raw] of Object.entries(obj)) {
    const url = asText(raw);
    if (!url || url === "...") continue;
    urls.push(url);
    if (slot === "flask_front") flaskFront = url;
  }
  return { flaskFront, urls };
}

function parseScents(raw: unknown): WholesalePerfumesCatalogProduct["scents"] {
  const empty = { top: [] as string[], middle: [] as string[], base: [] as string[] };
  if (!raw || typeof raw !== "object") return empty;
  const obj = raw as Record<string, unknown>;
  return {
    top: textList((obj.top as { scent?: unknown } | undefined)?.scent ?? obj.top),
    middle: textList((obj.middle as { scent?: unknown } | undefined)?.scent ?? obj.middle),
    base: textList((obj.base as { scent?: unknown } | undefined)?.scent ?? obj.base),
  };
}

function parseParams(raw: unknown): Record<string, string[]> {
  const out: Record<string, string[]> = {};
  if (!raw || typeof raw !== "object") return out;
  const params = (raw as { param?: unknown }).param;
  const list = Array.isArray(params) ? params : params ? [params] : [];
  for (const p of list) {
    if (!p || typeof p !== "object") continue;
    const name = asAttr(p, "name") || asText((p as { name?: unknown }).name);
    if (!name) continue;
    out[name] = textList((p as { value?: unknown }).value);
  }
  return out;
}

export function parseCatalogXml(xml: string): WholesalePerfumesCatalogProduct[] {
  const doc = xmlParser.parse(xml) as { catalog?: { product?: unknown } };
  const products = doc?.catalog?.product;
  const list = Array.isArray(products) ? products : products ? [products] : [];
  const out: WholesalePerfumesCatalogProduct[] = [];

  for (const raw of list) {
    if (!raw || typeof raw !== "object") continue;
    const r = raw as Record<string, unknown>;
    const id = asText(r.id);
    if (!id) continue;

    const allEansNode = r.all_eans as { ean?: unknown } | undefined;
    const fromAll = textList(allEansNode?.ean);
    const primary = asText(r.ean);
    const allEans = [...new Set([...(primary ? [primary] : []), ...fromAll].filter((e) => /^\d+$/.test(e)))];

    const typeRaw = r.type;
    const brandRaw = r.brand;
    const volumeRaw = r.volume;
    const pics = firstPicture(r.pictures);
    const setRaw = r.set as { composition?: unknown } | undefined;

    out.push({
      id,
      ean: primary,
      allEans,
      typeId: asAttr(typeRaw, "id") || null,
      typeName: asText(typeRaw) || null,
      brandId: asAttr(brandRaw, "id") || null,
      brand: asText(brandRaw) || null,
      series: asText(r.series) || null,
      model: asText(r.model) || null,
      gender: asText(r.gender) || null,
      volume: asText(volumeRaw) || null,
      volumeUnit: asAttr(volumeRaw, "unit") || null,
      typeInfo: asText(r.type_info) || null,
      nameAddon: asText(r.name_addon) || null,
      setComposition: asText(setRaw?.composition) || null,
      flaskFront: pics.flaskFront,
      pictureUrls: pics.urls,
      scents: parseScents(r.scents),
      params: parseParams(r.params),
    });
  }
  return out;
}

export function parseStoreXml(xml: string): WholesalePerfumesStoreProduct[] {
  const doc = xmlParser.parse(xml) as { store?: { product?: unknown } };
  const products = doc?.store?.product;
  const list = Array.isArray(products) ? products : products ? [products] : [];
  const out: WholesalePerfumesStoreProduct[] = [];

  for (const raw of list) {
    if (!raw || typeof raw !== "object") continue;
    const r = raw as Record<string, unknown>;
    const id = asText(r.id);
    if (!id) continue;
    const priceNoVat = Number.parseFloat(asText(r.price_no_vat));
    const quantity = Number.parseInt(asText(r.quantity), 10);
    out.push({
      id,
      priceNoVat: Number.isFinite(priceNoVat) ? priceNoVat : 0,
      quantity: Number.isFinite(quantity) ? Math.max(0, quantity) : 0,
    });
  }
  return out;
}

export class WholesalePerfumesClient {
  private readonly user: string;
  private readonly token: string;
  private readonly catalogUrl: string;
  private readonly storeUrl: string;
  private readonly apiBaseUrl: string;
  private readonly timeout: number;

  constructor(config: WholesalePerfumesClientConfig) {
    if (!config.user || !config.token) {
      throw new WholesalePerfumesRequestError("WHOLESALE_PERFUMES_USER and WHOLESALE_PERFUMES_TOKEN are required for live wholesale-perfumes calls");
    }
    this.user = config.user;
    this.token = config.token;
    this.catalogUrl = config.catalogUrl;
    this.storeUrl = config.storeUrl;
    this.apiBaseUrl = config.apiBaseUrl.replace(/\/$/, "");
    this.timeout = config.timeout ?? 120_000;
  }

  private authHeader(): string {
    return `Basic ${Buffer.from(`${this.user}:${this.token}`).toString("base64")}`;
  }

  private async request(
    method: string,
    url: string,
    body?: unknown,
  ): Promise<{ status: number; text: string; json: unknown }> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeout);
    try {
      const res = await fetch(url, {
        method,
        headers: {
          Authorization: this.authHeader(),
          Accept: "application/json, application/xml, text/xml, */*",
          ...(body !== undefined ? { "Content-Type": "application/json" } : {}),
        },
        body: body !== undefined ? JSON.stringify(body) : undefined,
        signal: controller.signal,
      });
      const text = await res.text();
      let json: unknown = null;
      if (text) {
        try {
          json = JSON.parse(text);
        } catch {
          json = null;
        }
      }
      if (!res.ok) {
        throw new WholesalePerfumesRequestError(`wholesale-perfumes ${method} ${url} failed: HTTP ${res.status}`, res.status, json ?? text);
      }
      return { status: res.status, text, json };
    } finally {
      clearTimeout(timer);
    }
  }

  async fetchCatalogXml(): Promise<string> {
    const { text } = await this.request("GET", this.catalogUrl);
    return text;
  }

  async fetchStoreXml(): Promise<string> {
    const { text } = await this.request("GET", this.storeUrl);
    return text;
  }

  async fetchCatalog(): Promise<WholesalePerfumesCatalogProduct[]> {
    return parseCatalogXml(await this.fetchCatalogXml());
  }

  async fetchStore(): Promise<WholesalePerfumesStoreProduct[]> {
    return parseStoreXml(await this.fetchStoreXml());
  }

  /** Empty the account-global cart. Mutates shared vendor state. */
  async clearCart(): Promise<unknown> {
    const { json, text } = await this.request("DELETE", `${this.apiBaseUrl}/cart`);
    assertApiOk(json, "DELETE /cart");
    return json ?? text;
  }

  /**
   * Replace-style insert: POST /cart takes the full line list (`[{ code, quantity }, ...]`)
   * and is all-or-nothing. Callers must clear first when building a fresh cart.
   * `code` = catalog product id (not EAN).
   */
  async addToCart(lines: WholesalePerfumesCartLine[]): Promise<unknown> {
    const { json, text } = await this.request("POST", `${this.apiBaseUrl}/cart`, lines);
    assertApiOk(json, "POST /cart");
    return json ?? text;
  }

  async getCart(): Promise<unknown> {
    const { json, text } = await this.request("GET", `${this.apiBaseUrl}/cart`);
    assertApiOk(json, "GET /cart");
    return json ?? text;
  }

  /** Optional `note` is written onto the vendor order (e.g. our SIL-* reference). */
  async submitCart(options?: { note?: string }): Promise<unknown> {
    const body =
      options?.note !== undefined && options.note !== ""
        ? { note: options.note }
        : undefined;
    const { json, text } = await this.request("POST", `${this.apiBaseUrl}/cart/submit`, body);
    assertApiOk(json, "POST /cart/submit");
    return json ?? text;
  }

  async getOrder(orderNumber: string): Promise<WholesalePerfumesOrderView> {
    const { json, text } = await this.request(
      "GET",
      `${this.apiBaseUrl}/order/${encodeURIComponent(orderNumber)}`,
    );
    // Order GET uses a `result` envelope; only assert when an `error` field is present.
    if (readApiErrorCode(json) !== null) {
      assertApiOk(json, `GET /order/${orderNumber}`);
    }
    return parseOrderGetResponse(json ?? text);
  }
}
