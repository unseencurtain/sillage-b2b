import { describe, expect, test } from "bun:test";
import { indexOfferImages, resolveImageUrl } from "../src/sync/imageRules.ts";

describe("resolveImageUrl", () => {
  const bfPic = "https://www.beautyfort.com/pic/QU1ycVFZZlVUQm5hN1NiU0RpcEtGcXRoTllvMURGSVE%3D";
  const btsPlaceholder =
    "https://images.btswholesaler.com/imgs/productos_cosmetica/imagenes/no_image.webp";
  const real = "https://images.btswholesaler.com/ok.jpg";

  test("uses a curated override over a weak BeautyFort thumb", () => {
    const overrides = new Map([["197575132998", real]]);
    expect(resolveImageUrl(["0197575132998"], bfPic, overrides, new Map())).toBe(real);
  });

  test("fills from another vendor when the current URL is unusable", () => {
    const fromOffers = new Map([["197575132998", real]]);
    expect(resolveImageUrl(["0197575132998"], bfPic, new Map(), fromOffers)).toBe(real);
  });

  test("clears when both the winning offer and the other vendor are placeholders", () => {
    const fromOffers = new Map([["197575132998", btsPlaceholder]]);
    expect(resolveImageUrl(["0197575132998"], bfPic, new Map(), fromOffers)).toBe(null);
  });
});

describe("indexOfferImages", () => {
  test("indexes extra EANs so a BF row can use a BTS donor photo", () => {
    const map = indexOfferImages([
      {
        primary_ean: "111",
        eans: ["111", "222"],
        image_url: "https://images.btswholesaler.com/ok.jpg",
      },
      {
        primary_ean: "333",
        eans: JSON.stringify(["333"]),
        image_url: "https://www.beautyfort.com/pic/abc",
      },
    ]);
    expect(map.get("111")).toBe("https://images.btswholesaler.com/ok.jpg");
    expect(map.get("222")).toBe("https://images.btswholesaler.com/ok.jpg");
    expect(map.has("333")).toBe(false);
  });
});
