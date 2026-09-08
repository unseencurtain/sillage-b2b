import { describe, expect, test } from "bun:test";
import { checkAutoDispatch, checkCoverage, checkOrderCeiling } from "../src/orders/rails.ts";
import type { GlobalSettings } from "../src/db/settings.ts";

const settings = (patch: Partial<GlobalSettings> = {}): GlobalSettings => ({
  priceMultiplier: 1,
  priceTiers: [],
  stockThreshold: 0,
  maxRrpRatio: 10,
  dedupeByEan: true,
  primaryOfferStrategy: "cheapest",
  descriptionMode: "none",
  volumeFilterMode: "ranges",
  liveFeedMinMinutes: 60,
  writeBatchSize: 500,
  maxStatementBytes: 4_194_304,
  syncEnabled: true,
  fastSyncMinutes: 30,
  fullSyncEnabled: true,
  fullSyncHour: 3,
  scheduleTimezone: "UTC",
  syncSource: "live",
  hideProductsWithoutImage: true,
  imageCdnBaseUrl: "https://images.slilverbelt.xyz",
  wpBaseUrl: "https://cosmetic.example",
  cartMinEnabled: false,
  cartMinSubtotalEur: 50,
  cartMinFeeEur: 5,
  cartMinMessage: "Add {remaining} more to your order to remove the small-order fee.",
  cartMinFeeLabel: "Small order fee",
  ordersDryRun: true,
  ordersAutoDispatch: false,
  ordersMaxValueEur: 500,
  ordersDailyCapEur: 2000,
  ordersPollMinutes: 15,
  ordersNotifyCustomer: true,
  ...patch,
});

describe("dispatch safety rails", () => {
  test("coverage rejects an unsupported country", () => {
    const r = checkCoverage("US", ["DE", "FR"]);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.rail).toBe("coverage");
  });

  test("coverage is case-insensitive", () => {
    expect(checkCoverage("de", ["DE", "FR"]).ok).toBe(true);
  });

  test("ceiling blocks an oversized order", () => {
    const r = checkOrderCeiling(480, 30, 500);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.rail).toBe("max_order_value");
  });

  test("ceiling allows an order on the limit", () => {
    expect(checkOrderCeiling(490, 10, 500).ok).toBe(true);
  });

  test("auto_dispatch is off by default", () => {
    const r = checkAutoDispatch(settings(), false);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.rail).toBe("auto_dispatch");
  });

  test("force bypasses auto_dispatch", () => {
    expect(checkAutoDispatch(settings(), true).ok).toBe(true);
  });

  test("enabling auto_dispatch lets the rail through", () => {
    expect(checkAutoDispatch(settings({ ordersAutoDispatch: true }), false).ok).toBe(true);
  });
});
