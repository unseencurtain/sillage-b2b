/**
 * Vendor order adapter contract.
 *
 * Catalogue connectors (`VendorConnector`) fetch products. These adapters place and track
 * orders. Kept separate because every successful `submit` with dryRun=false spends real money,
 * and neither vendor has a sandbox.
 */
import type { OrderAddress } from "./types.ts";

export interface OrderItem {
  sku: string;
  vendorProductId: string;
  /** Primary EAN. BTS's order APIs key products by EAN, not by their internal id. */
  ean: string | null;
  name: string;
  quantity: number;
  unitCost: number;
}

export interface Destination {
  address: OrderAddress;
  /** ISO country code, uppercase. */
  country: string;
}

export interface StockLineResult {
  sku: string;
  requested: number;
  available: number;
  ok: boolean;
}

export interface StockVerification {
  ok: boolean;
  lines: StockLineResult[];
  /** Free-form reason when ok is false. */
  reason?: string;
}

export interface ShippingQuote {
  id: string;
  company: string;
  /** Cost in EUR. */
  cost: number;
  /** Business days, when the vendor reports it. */
  deliveryDays?: number;
}

export interface VendorOrderDraft {
  /** Our idempotency / correlation key: SIL-{wc_order_id}-{PREFIX}. */
  ourReference: string;
  /** WooCommerce HPOS order id. */
  wcOrderId: number;
  /** Customer ship-to (delivery). */
  destination: Destination;
  /**
   * Company invoice / billing profile. BeautyFort maps this to InvoiceAddress*.
   * BTS has no billing API fields — adapters still include it in dry-run payloads for ops.
   */
  billing?: Destination & { vat?: string };
  items: OrderItem[];
  /** Already-chosen shipping option, when re-submitting after a quote. */
  shippingOptionId?: string;
}

export interface VendorOrderResult {
  /** False on dry-run: the payload was built and validated, but the committing call was skipped. */
  committed: boolean;
  vendorOrderNumber: string | null;
  shippingCost: number | null;
  shippingOptionId: string | null;
  shippingCompany: string | null;
  totalCost: number | null;
  /** Exact request that would have been / was sent. Recorded for crash recovery. */
  requestPayload: unknown;
  responsePayload: unknown;
  /** Set when the outcome is genuinely unknown (network error after a BTS submit). */
  ambiguous?: boolean;
  error?: string;
}

export type VendorPollStatus =
  | "pending"
  | "confirmed"
  | "dispatched"
  | "delivered"
  | "cancelled"
  | "unknown";

export interface TrackingParcel {
  courier: string;
  code: string;
  url: string;
  dispatchedAt: string | null;
}

export interface VendorOrderStatus {
  status: VendorPollStatus;
  vendorOrderNumber: string;
  rawStatus: string;
  parcels: TrackingParcel[];
  shippingCompany: string | null;
}

export interface CancelResult {
  ok: boolean;
  fee: string | null;
  message: string;
}

export interface VendorOrderAdapter {
  readonly slug: string;
  serviceableCountries(): Promise<string[]>;
  verifyStock(items: OrderItem[]): Promise<StockVerification>;
  quoteShipping(dest: Destination, items: OrderItem[]): Promise<ShippingQuote[]>;
  submit(order: VendorOrderDraft, dryRun: boolean): Promise<VendorOrderResult>;
  poll(vendorOrderNumber: string, ourReference?: string): Promise<VendorOrderStatus>;
  cancel?(vendorOrderNumber: string, ourReference?: string): Promise<CancelResult>;
}
