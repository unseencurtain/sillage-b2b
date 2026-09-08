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

describe("imageRules weak BeautyFort thumbs", () => {
  const bfPic =
    "https://www.beautyfort.com/pic/dHNhMzRKNjBiNDA0V2xZRGM5UHhranNEWDVYaTNFdlk%3D";

  test("treats Python None/null strings as missing", () => {
    expect(isUnusableImage("None")).toBe(true);
    expect(isUnusableImage("null")).toBe(true);
    expect(shouldHideForMissingImage("None", true)).toBe(true);
    expect(shopImageKey("None")).toBe("");
    expect(shopImageKey("https://images.btswholesaler.com/ok.jpg")).toBe(
      "https://images.btswholesaler.com/ok.jpg",
    );
  });

  test("displayedShopImage trusts Woo meta when it was queried", () => {
    const feed = "https://images.btswholesaler.com/ok.jpg";
    expect(displayedShopImage("", feed)).toBeNull();
    expect(displayedShopImage("None", feed)).toBeNull();
    expect(displayedShopImage(null, feed)).toBeNull();
    expect(displayedShopImage(undefined, feed)).toBe(feed);
    expect(displayedShopImage(feed, null)).toBe(feed);
  });

  test("thumbsNeedWrite when Woo holds junk and the feed has a real URL", () => {
    const feed = "https://images.btswholesaler.com/ok.jpg";
    expect(thumbsNeedWrite("None", feed)).toBe(true);
    expect(thumbsNeedWrite("", feed)).toBe(true);
    expect(thumbsNeedWrite(feed, feed)).toBe(false);
    expect(thumbsNeedWrite(null, null)).toBe(false);
  });

  test("flags beautyfort.com/pic URLs as weak", () => {
    expect(isWeakVendorThumb(bfPic)).toBe(true);
    expect(isUnusableImage(bfPic)).toBe(true);
  });

  test("hides weak /pic/ thumbs when hide-without-image is on", () => {
    expect(shouldHideForMissingImage(bfPic, true)).toBe(true);
    expect(shouldHideForMissingImage(bfPic, false)).toBe(false);
    expect(
      shouldHideForMissingImage("https://images.slilverbelt.xyz/9339341005643.jpg", true),
    ).toBe(false);
  });

  test("shopVisibility prefers no-image hide over in-stock", () => {
    expect(
      shopVisibility({ stock: 1, imageUrl: bfPic, hideWithoutImage: true, stockThreshold: 0 }),
    ).toBe("hidden_no_image");
    expect(
      shopVisibility({
        stock: 1,
        imageUrl: "https://images.btswholesaler.com/ok.jpg",
        hideWithoutImage: true,
        stockThreshold: 0,
      }),
    ).toBe("visible");
    expect(
      shopVisibility({
        stock: 1,
        imageUrl: "https://images.btswholesaler.com/imgs/productos_cosmetica/imagenes/no_image.webp",
        hideWithoutImage: true,
        stockThreshold: 0,
      }),
    ).toBe("hidden_no_image");
    expect(
      shopVisibility({
        stock: 0,
        imageUrl: "https://images.btswholesaler.com/ok.jpg",
        hideWithoutImage: true,
        stockThreshold: 0,
      }),
    ).toBe("hidden_stock");
    expect(
      shopVisibility({
        stock: 1,
        imageUrl: "https://images.btswholesaler.com/ok.jpg",
        hideWithoutImage: true,
        stockThreshold: 0,
        operatorHidden: true,
      }),
    ).toBe("hidden_operator");
  });
});
