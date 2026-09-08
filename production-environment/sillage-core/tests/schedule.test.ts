import { describe, expect, test } from "bun:test";
import type { GlobalSettings } from "../src/db/settings.ts";
import { decide, normaliseHour, type ScheduleTiming } from "../src/sync/schedule.ts";

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

const timing = (patch: Partial<ScheduleTiming> = {}): ScheduleTiming => ({
  minutesSinceAny: 5,
  fullRunsSinceWindow: 1,
  windowOpen: true,
  ...patch,
});

describe("schedule decisions", () => {
  test("the kill switch stops everything", () => {
    expect(decide(settings({ syncEnabled: false }), timing({ minutesSinceAny: 9999 })).action).toBe("skip");
  });

  test("nothing runs before the cadence has elapsed", () => {
    expect(decide(settings(), timing({ minutesSinceAny: 29 })).action).toBe("skip");
  });

  test("a fast sync runs once the cadence has elapsed", () => {
    expect(decide(settings(), timing({ minutesSinceAny: 30 })).action).toBe("fast");
  });

  test("the full sync wins over a due fast sync inside its window", () => {
    const d = decide(settings(), timing({ minutesSinceAny: 999, fullRunsSinceWindow: 0 }));
    expect(d.action).toBe("full");
  });

  test("the full sync runs only once per day, even if it failed", () => {
    // fullRunsSinceWindow counts attempts, not successes, so a failure must not retry every tick.
    const d = decide(settings(), timing({ minutesSinceAny: 999, fullRunsSinceWindow: 1 }));
    expect(d.action).toBe("fast");
  });

  test("the full sync does not run before its hour", () => {
    const d = decide(settings(), timing({ minutesSinceAny: 999, fullRunsSinceWindow: 0, windowOpen: false }));
    expect(d.action).toBe("fast");
  });

  test("disabling the full sync leaves the fast cadence alone", () => {
    const d = decide(
      settings({ fullSyncEnabled: false }),
      timing({ minutesSinceAny: 999, fullRunsSinceWindow: 0 }),
    );
    expect(d.action).toBe("fast");
  });

  test("a queued catalogue rebuild upgrades the next due fast sync to full", () => {
    const d = decide(settings({ fullSyncEnabled: false }), timing({ minutesSinceAny: 30 }), true);
    expect(d.action).toBe("full");
  });

  test("a queued rebuild still waits for the call interval", () => {
    const d = decide(settings(), timing({ minutesSinceAny: 10, fullRunsSinceWindow: 1 }), true);
    expect(d.action).toBe("skip");
  });

  test("an empty catalogue seeds with a full sync", () => {
    const d = decide(settings(), timing({ minutesSinceAny: null, fullRunsSinceWindow: 1 }));
    expect(d.action).toBe("full");
  });

  test("an out-of-range hour is clamped rather than rejected", () => {
    expect(normaliseHour(-4)).toBe(0);
    expect(normaliseHour(99)).toBe(23);
    expect(normaliseHour(3.7)).toBe(3);
    expect(normaliseHour(Number.NaN)).toBe(0);
  });
});
