/** Shapes shared by order ingest, dispatch and tracking. */

export interface OrderAddress {
  firstName: string;
  lastName: string;
  company: string;
  address1: string;
  address2: string;
  city: string;
  state: string;
  postcode: string;
  country: string;
  email: string;
  phone: string;
}

/** One `line_item` row from the order, before it is attributed to a vendor. */
export interface WooOrderLine {
  itemId: number;
  name: string;
  /** WordPress post ID of the product, 0 for a line whose product was deleted. */
  productId: number;
  quantity: number;
  /** What the customer paid for the line, excluding tax. */
  lineTotal: number;
}

export interface WooOrder {
  id: number;
  status: string;
  currency: string;
  total: number;
  customerNote: string;
  createdAt: string;
  billing: OrderAddress;
  shipping: OrderAddress;
  lines: WooOrderLine[];
}

/** A line that has been matched to a vendor and priced at cost. */
export interface VendorLine extends WooOrderLine {
  vendorId: number;
  vendorSlug: string;
  vendorProductId: string;
  sku: string;
  ean: string | null;
  offerId: number;
  /** What we pay the vendor per unit. */
  unitCost: number;
  /** What the customer paid per unit. */
  unitPrice: number;
}

export interface IngestResult {
  orderId: number;
  /** Vendor order rows created by this call. */
  created: Array<{ vendorOrderId: number; vendor: string; reference: string; lines: number; itemsCost: number }>;
  /** Vendors that already had a row; left untouched. */
  existing: string[];
  /** Lines that could not be attributed to a vendor. */
  unresolved: Array<{ itemId: number; productId: number; name: string; reason: string }>;
}
