import { beforeEach, describe, expect, it } from "vitest";

import {
  isSamePublishedCatalog,
  readPublishedCatalogCache,
  readPublishedCatalogMemoryCache,
  resetPublishedCatalogCacheForTests,
  writePublishedCatalogCache,
} from "@/lib/commerce/published-catalog-cache";
import type { Product } from "@/types/store";

function createStorage() {
  const values = new Map<string, string>();

  return {
    getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, value: string) => {
      values.set(key, value);
    },
    removeItem: (key: string) => {
      values.delete(key);
    },
    values,
  };
}

const product = {
  id: "prd_rizzo_deck",
  slug: "rizzo-deck-8-25",
  image: "/images/rizzo-deck.webp",
  price: 98000,
  inventoryQuantity: 9,
} as Product;

describe("published catalog cache", () => {
  beforeEach(() => {
    resetPublishedCatalogCacheForTests();
  });

  it("returns undefined before anything is cached", () => {
    expect(readPublishedCatalogMemoryCache()).toBeUndefined();
    expect(readPublishedCatalogCache(createStorage())).toBeUndefined();
  });

  it("restores products from session storage after a reload", () => {
    const storage = createStorage();
    writePublishedCatalogCache([product], storage);
    resetPublishedCatalogCacheForTests();

    expect(readPublishedCatalogCache(storage)).toEqual([product]);
    expect(readPublishedCatalogMemoryCache()).toEqual([product]);
  });

  it("drops malformed storage entries", () => {
    const storage = createStorage();
    storage.setItem("paradays:published-catalog:v1", JSON.stringify([{ id: 1 }]));

    expect(readPublishedCatalogCache(storage)).toBeUndefined();
    expect(storage.values.size).toBe(0);
  });

  it("remembers an unconfigured API as null in memory only", () => {
    const storage = createStorage();
    writePublishedCatalogCache(null, storage);

    expect(readPublishedCatalogMemoryCache()).toBeNull();
    expect(storage.values.size).toBe(0);
  });

  it("compares catalogs by content", () => {
    expect(isSamePublishedCatalog([product], [{ ...product }])).toBe(true);
    expect(
      isSamePublishedCatalog([product], [{ ...product, inventoryQuantity: 0 }]),
    ).toBe(false);
    expect(isSamePublishedCatalog(undefined, null)).toBe(false);
  });
});
