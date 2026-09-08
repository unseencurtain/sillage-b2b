import { describe, expect, test } from "bun:test";
import {
  displayedShopImage,
  isUnusableImage,
  isWeakVendorThumb,
  shouldHideForMissingImage,
  shopImageKey,
  shopVisibility,
  thumbsNeedWrite,
} from "../src/sync/imageRules.ts";

describe("imageRules hide-without-image", () => {
  const real = "https://images.example.com/ok.jpg";
  const placeholder =
    "https://images.example.com/imgs/productos_cosmetica/imagenes/no_image.webp";

  test("treats Python None/null strings as missing", () => {
    expect(isUnusableImage("None")).toBe(true);
    expect(isUnusableImage("null")).toBe(true);
    expect(shouldHideForMissingImage("None", true)).toBe(true);
    expect(shopImageKey("None")).toBe("");
    expect(shopImageKey(real)).toBe(real);
  });

  test("displayedShopImage trusts Woo meta when it was queried", () => {
    expect(displayedShopImage("", real)).toBeNull();
    expect(displayedShopImage("None", real)).toBeNull();
    expect(displayedShopImage(null, real)).toBeNull();
    expect(displayedShopImage(undefined, real)).toBe(real);
    expect(displayedShopImage(real, null)).toBe(real);
  });

  test("thumbsNeedWrite when Woo holds junk and the feed has a real URL", () => {
    expect(thumbsNeedWrite("None", real)).toBe(true);
    expect(thumbsNeedWrite("", real)).toBe(true);
    expect(thumbsNeedWrite(real, real)).toBe(false);
    expect(thumbsNeedWrite(null, null)).toBe(false);
  });

  test("placeholders are unusable", () => {
    expect(isWeakVendorThumb(placeholder)).toBe(true);
    expect(isUnusableImage(placeholder)).toBe(true);
  });

  test("hides placeholders when hide-without-image is on", () => {
    expect(shouldHideForMissingImage(placeholder, true)).toBe(true);
    expect(shouldHideForMissingImage(placeholder, false)).toBe(false);
    expect(shouldHideForMissingImage(real, true)).toBe(false);
  });

  test("shopVisibility prefers no-image hide over in-stock", () => {
    expect(
      shopVisibility({ stock: 1, imageUrl: placeholder, hideWithoutImage: true, stockThreshold: 0 }),
    ).toBe("hidden_no_image");
    expect(
      shopVisibility({
        stock: 1,
        imageUrl: real,
        hideWithoutImage: true,
        stockThreshold: 0,
      }),
    ).toBe("visible");
    expect(
      shopVisibility({
        stock: 0,
        imageUrl: real,
        hideWithoutImage: true,
        stockThreshold: 0,
      }),
    ).toBe("hidden_stock");
    expect(
      shopVisibility({
        stock: 1,
        imageUrl: real,
        hideWithoutImage: true,
        stockThreshold: 0,
        operatorHidden: true,
      }),
    ).toBe("hidden_operator");
  });
});
