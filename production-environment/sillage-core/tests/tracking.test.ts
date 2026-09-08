import { describe, expect, test } from "bun:test";
import { isPermanentPollFailure, nextVendorOrderStatus } from "../src/orders/pollRules.ts";

describe("isPermanentPollFailure", () => {
  test("flags no-OrderReference message", () => {
    expect(isPermanentPollFailure(new Error("no OrderReference in the response"))).toBe(true);
  });

  test("flags invalid vendor order number", () => {
    expect(isPermanentPollFailure(new Error("invalid vendor order number: abc"))).toBe(true);
  });

  test("does not park transient network errors", () => {
    expect(isPermanentPollFailure(new Error("ECONNRESET"))).toBe(false);
  });
});

describe("nextVendorOrderStatus", () => {
  test("applies Cancelled from submitted", () => {
    expect(nextVendorOrderStatus("submitted", "cancelled")).toBe("cancelled");
    expect(nextVendorOrderStatus("confirmed", "cancelled")).toBe("cancelled");
    expect(nextVendorOrderStatus("dispatched", "cancelled")).toBe("cancelled");
  });
});
