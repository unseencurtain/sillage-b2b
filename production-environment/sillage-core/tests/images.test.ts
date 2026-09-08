import { describe, expect, test } from "bun:test";
import { indexOfferImages, resolveImageUrl } from "../src/sync/imageRules.ts";

describe("resolveImageUrl", () => {
  const placeholder =
    "https://images.example.com/imgs/productos_cosmetica/imagenes/no_image.webp";
  const real = "https://images.example.com/ok.jpg";

  test("uses a curated override over a placeholder", () => {
    const overrides = new Map([["197575132998", real]]);
    expect(resolveImageUrl(["0197575132998"], placeholder, overrides, new Map())).toBe(real);
  });

  test("fills from another offer when the current URL is unusable", () => {
    const fromOffers = new Map([["197575132998", real]]);
    expect(resolveImageUrl(["0197575132998"], placeholder, new Map(), fromOffers)).toBe(real);
  });

  test("clears when both the winning offer and the donor are placeholders", () => {
    const fromOffers = new Map([["197575132998", placeholder]]);
    expect(resolveImageUrl(["0197575132998"], placeholder, new Map(), fromOffers)).toBe(null);
  });
});

describe("indexOfferImages", () => {
  test("indexes extra EANs so a row can use a donor photo", () => {
    const map = indexOfferImages([
      {
        primary_ean: "111",
        eans: ["111", "222"],
        image_url: "https://images.example.com/ok.jpg",
      },
      {
        primary_ean: "333",
        eans: JSON.stringify(["333"]),
        image_url: placeholderUrl(),
      },
    ]);
    expect(map.get("111")).toBe("https://images.example.com/ok.jpg");
    expect(map.get("222")).toBe("https://images.example.com/ok.jpg");
    expect(map.has("333")).toBe(false);
  });
});

function placeholderUrl() {
  return "https://images.example.com/imgs/productos_cosmetica/imagenes/no_image.webp";
}
