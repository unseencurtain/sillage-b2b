import { describe, expect, test } from "bun:test";
import { fetchedLabel } from "../web/src/lib/syncRunLabels.ts";

describe("fetchedLabel", () => {
  test("wholesale shows WPF SKU count", () => {
    expect(
      fetchedLabel({
        products_fetched: 140155,
        fetched_by_vendor: { "wholesale-perfumes": 19083 },
      }),
    ).toBe("WPF 19,083");
  });
});
