import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { getPublishedCatalogProduct } from "@/lib/commerce/public-catalog-api-client";

const baseProduct = {
  id: "prd_odwyer_sync",
  slug: "odwyer-sync-2-8-5",
  name: "O'Dwyer 'Sync 2' [8.5\"]",
  category: "Deck",
  brand: "Quasi",
  price: 107000,
  image: "/images/odwyer.webp",
  description: ['8.5" x 31.75" WB 14.25"'],
  sizes: ["8.5"],
};

const deckSpec = {
  nose: 6.875,
  tail: 6.5,
  width: 8.5,
  length: 31.75,
  wheelbase: 14.25,
};

function fetchReturning(product: unknown): typeof fetch {
  return (async () =>
    new Response(JSON.stringify({ product }), { status: 200 })) as typeof fetch;
}

describe("public catalog deckSpec", () => {
  const previousBaseUrl = process.env.NEXT_PUBLIC_COMMERCE_API_BASE_URL;

  beforeEach(() => {
    process.env.NEXT_PUBLIC_COMMERCE_API_BASE_URL = "https://api.example.test";
  });

  afterEach(() => {
    // process.env stores assigned undefined as the string "undefined".
    if (previousBaseUrl === undefined)
      delete process.env.NEXT_PUBLIC_COMMERCE_API_BASE_URL;
    else process.env.NEXT_PUBLIC_COMMERCE_API_BASE_URL = previousBaseUrl;
  });

  it("keeps a complete deckSpec", async () => {
    const product = await getPublishedCatalogProduct(
      baseProduct.slug,
      fetchReturning({ ...baseProduct, deckSpec }),
    );

    expect(product?.deckSpec).toEqual(deckSpec);
  });

  it("drops only the deckSpec when it is incomplete or invalid", async () => {
    for (const invalid of [
      { ...deckSpec, tail: undefined },
      { ...deckSpec, width: 0 },
      { ...deckSpec, length: "31.75" },
      { ...deckSpec, nose: Number.POSITIVE_INFINITY },
      "6.875",
    ]) {
      const product = await getPublishedCatalogProduct(
        baseProduct.slug,
        fetchReturning({ ...baseProduct, deckSpec: invalid }),
      );

      expect(product?.id).toBe(baseProduct.id);
      expect(product).not.toHaveProperty("deckSpec");
    }
  });

  it("omits deckSpec for products without one", async () => {
    const product = await getPublishedCatalogProduct(
      baseProduct.slug,
      fetchReturning(baseProduct),
    );

    expect(product).not.toHaveProperty("deckSpec");
  });

  const optionSpec = { ...deckSpec, width: 8.25, wheelbase: 14 };
  const withOptions = (deckSpecsBySize: unknown) =>
    getPublishedCatalogProduct(
      baseProduct.slug,
      fetchReturning({
        ...baseProduct,
        sizes: ["8.25", "8.5", "__proto__", "constructor", "prototype"],
        deckSpec,
        deckSpecsBySize,
      }),
    );

  it("keeps per-option size charts next to the default", async () => {
    const product = await withOptions({ "8.25": optionSpec });

    expect(product?.deckSpec).toEqual(deckSpec);
    expect(product?.deckSpecsBySize).toEqual({ "8.25": optionSpec });
  });

  it("drops only malformed, unknown-size and unsafe option entries", async () => {
    const product = await withOptions(
      JSON.parse(
        JSON.stringify({
          "8.25": optionSpec,
          "8.5": { ...optionSpec, width: 0 },
          "9.0": optionSpec,
          constructor: optionSpec,
          prototype: optionSpec,
          proto: optionSpec,
        }).replace('"proto"', '"__proto__"'),
      ),
    );

    expect(product?.id).toBe(baseProduct.id);
    expect(product?.deckSpecsBySize).toEqual({ "8.25": optionSpec });
    expect(Object.getPrototypeOf(product?.deckSpecsBySize)).toBe(Object.prototype);
  });

  it("omits the option map when no entry survives, keeping the product", async () => {
    for (const invalid of [
      { "8.5": {} },
      { "9.0": optionSpec },
      "8.25",
      [optionSpec],
    ]) {
      const product = await withOptions(invalid);

      expect(product?.id).toBe(baseProduct.id);
      expect(product?.deckSpec).toEqual(deckSpec);
      expect(product).not.toHaveProperty("deckSpecsBySize");
    }
  });
});
