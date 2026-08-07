import { describe, expect, test } from "bun:test";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import {
  mapWholesalePerfumesPollStatus,
  wholesalePerfumesCartCode,
} from "../src/orders/adapters/wholesale-perfumes.ts";
import type { OrderItem } from "../src/orders/adapter.ts";
import {
  composeWholesalePerfumesName,
  formatWholesalePerfumesVolume,
  joinCatalogAndStore,
  mapWholesalePerfumesGender,
  WholesalePerfumesConnector,
} from "../src/vendors/wholesale-perfumes/connector.ts";
import {
  assertApiOk,
  extractOrderNumber,
  parseCatalogXml,
  parseOrderGetResponse,
  parseStoreXml,
  readApiErrorCode,
  WHOLESALE_PERFUMES_API,
  WholesalePerfumesApiError,
} from "../src/vendors/wholesale-perfumes/WholesalePerfumesClient.ts";

const fixtures = join(import.meta.dir, "fixtures");

describe("wholesale-perfumes XML parse + normalize", () => {
  test("multi-EAN fan-out preserves leading-zero EANs as strings", async () => {
    const catalog = parseCatalogXml(await readFile(join(fixtures, "wholesale_perfumes_catalog.xml"), "utf8"));
    const store = parseStoreXml(await readFile(join(fixtures, "wholesale_perfumes_store.xml"), "utf8"));
    const connector = new WholesalePerfumesConnector();
    await connector.prepare("local");

    const joined = joinCatalogAndStore(catalog, store);
    const first = connector.normalize(joined[0]!);
    expect(first).not.toBeNull();
    expect(first!.eans).toEqual(["01231231231234", "4564564564567", "7897897897891"]);
    expect(first!.eans[0]).toBe("01231231231234");
    expect(typeof first!.eans[0]).toBe("string");

    const leading = connector.normalize(joined.find((p) => p.id === "4")!);
    expect(leading!.eans).toEqual(["0000123456789"]);
    expect(leading!.eans[0]!.startsWith("0000")).toBe(true);
  });

  test("composes name from brand, series, model and name_addon", () => {
    expect(
      composeWholesalePerfumesName({
        brand: "Giorgio Armani",
        series: "Emporio RED White",
        model: "Intense",
        nameAddon: "For Men",
      }),
    ).toBe("Giorgio Armani Emporio RED White Intense For Men");
    expect(
      composeWholesalePerfumesName({ brand: "Dior", series: "Sauvage", model: null, nameAddon: null }),
    ).toBe("Dior Sauvage");
  });

  test("parses volume with unit and maps gender / type attributes", async () => {
    expect(formatWholesalePerfumesVolume("100", "ml")).toBe("100 ml");
    expect(mapWholesalePerfumesGender("M")).toBe("Men");
    expect(mapWholesalePerfumesGender("F")).toBe("Women");
    expect(mapWholesalePerfumesGender("U")).toBe("Unisex");
    expect(mapWholesalePerfumesGender("W")).toBe("Women");

    const catalog = parseCatalogXml(await readFile(join(fixtures, "wholesale_perfumes_catalog.xml"), "utf8"));
    const store = parseStoreXml(await readFile(join(fixtures, "wholesale_perfumes_store.xml"), "utf8"));
    const connector = new WholesalePerfumesConnector();
    await connector.prepare("local");
    const p = connector.normalize(joinCatalogAndStore(catalog, store)[0]!);
    expect(p!.attributes["volume"]).toBe("100 ml");
    expect(p!.attributes["gender"]).toBe("Men");
    expect(p!.attributes["type"]).toBe("Eau de Toilette");
    expect(p!.sku).toBe("WPF-1");
    expect(p!.vendorPrice).toBe(125.64);
    expect(p!.stock).toBe(10);
    expect(p!.imageUrl).toContain("HQlgckCAqXUZdlXzHgtlzQ");
    // product_cat = type only; brand stays on product_brand via `brand`.
    expect(p!.categoryRefs.every((k) => k.startsWith("type:"))).toBe(true);
    expect(p!.categoryRefs.some((k) => k.startsWith("brand:"))).toBe(false);
    expect(p!.brand).toBeTruthy();
  });

  test("product missing flask_front has null imageUrl", async () => {
    const catalog = parseCatalogXml(await readFile(join(fixtures, "wholesale_perfumes_catalog.xml"), "utf8"));
    const store = parseStoreXml(await readFile(join(fixtures, "wholesale_perfumes_store.xml"), "utf8"));
    const connector = new WholesalePerfumesConnector();
    await connector.prepare("local");
    const joined = joinCatalogAndStore(catalog, store);

    // id 3 has only <other>, no flask_front
    const noFlask = connector.normalize(joined.find((p) => p.id === "3")!);
    expect(noFlask!.imageUrl).toBeNull();

    // id 4 has empty <pictures>
    const emptyPics = connector.normalize(joined.find((p) => p.id === "4")!);
    expect(emptyPics!.imageUrl).toBeNull();
  });

  test("joins catalog to store on id and drops rows without a positive price", async () => {
    const catalog = parseCatalogXml(await readFile(join(fixtures, "wholesale_perfumes_catalog.xml"), "utf8"));
    const store = parseStoreXml(await readFile(join(fixtures, "wholesale_perfumes_store.xml"), "utf8"));
    const connector = new WholesalePerfumesConnector();
    await connector.prepare("local");
    const normalized = joinCatalogAndStore(catalog, store)
      .map((r) => connector.normalize(r))
      .filter((p) => p !== null);
    expect(normalized.length).toBe(4);
    expect(normalized.every((p) => p.sku.startsWith("WPF-"))).toBe(true);
  });
});

describe("wholesale-perfumes cart/order API helpers", () => {
  test("cart code is catalog product id (vendorProductId), not EAN", () => {
    const item = {
      vendorProductId: "3",
      ean: "0123456789012",
      sku: "WPF-3",
      quantity: 2,
      unitCost: 10,
    } as OrderItem;
    expect(wholesalePerfumesCartCode(item)).toBe("3");
  });

  test("assertApiOk accepts error 0 / missing error and rejects documented codes", () => {
    expect(() => assertApiOk({ error: 0, message: "OK" }, "GET /cart")).not.toThrow();
    expect(() => assertApiOk({ message: "OK", items: [] }, "GET /cart")).not.toThrow();
    expect(() => assertApiOk(null, "GET /cart")).not.toThrow();

    expect(readApiErrorCode({ error: "8" })).toBe(8);

    try {
      assertApiOk(
        {
          error: WHOLESALE_PERFUMES_API.OPERATION_FAILED,
          message: "Operation failed",
          items: {
            "1": {
              error: 3,
              message: "Not enough pieces in stock. In store is 4 pcs",
              id_product: "1",
              available_quantity: "3",
            },
          },
        },
        "POST /cart/submit",
      );
      expect.unreachable("expected WholesalePerfumesApiError");
    } catch (err) {
      expect(err).toBeInstanceOf(WholesalePerfumesApiError);
      const api = err as WholesalePerfumesApiError;
      expect(api.apiError).toBe(8);
      expect(api.isClearReject).toBe(true);
      expect(api.message).toContain("Operation failed");
    }

    expect(() =>
      assertApiOk({ error: WHOLESALE_PERFUMES_API.CART_EMPTY, message: "Cart is empty" }, "submit"),
    ).toThrow(/1012/);
  });

  test("extractOrderNumber reads submit success body", () => {
    expect(
      extractOrderNumber({
        error: 0,
        message: "Order was created",
        order_number: "3416985071",
        items: [],
      }),
    ).toBe("3416985071");
    expect(extractOrderNumber({ error: 0, message: "OK" })).toBeNull();
  });

  test("parseOrderGetResponse reads nested result.items[0] status fields", () => {
    const view = parseOrderGetResponse({
      result: {
        items: [
          {
            order_number: 3416985071,
            currency: "EUR",
            status_code: 2,
            status_msg: "Processing",
            order_items: [
              {
                id_product: 123,
                name: "Pretty item xy",
                pieces: 10,
                vat: 21,
                piece_price_without_vat: 10,
                total_price: 100,
              },
            ],
          },
        ],
      },
    });
    expect(view.orderNumber).toBe("3416985071");
    expect(view.statusCode).toBe(2);
    expect(view.statusMsg).toBe("Processing");
    expect(view.orderItems).toHaveLength(1);

    const mapped = mapWholesalePerfumesPollStatus(view);
    expect(mapped.status).toBe("confirmed");
    expect(mapped.rawStatus).toBe("Processing");

    // Numeric-only sample from the vendor doc → unknown (codes undocumented)
    const numericOnly = mapWholesalePerfumesPollStatus(
      parseOrderGetResponse({
        result: { items: [{ order_number: 1, status_code: 2, status_msg: 2, order_items: [] }] },
      }),
    );
    expect(numericOnly.status).toBe("unknown");
    expect(numericOnly.rawStatus).toBe("2");
  });
});
