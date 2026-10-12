// 역할: 메뉴 다중 선택 → 카탈로그 필터(OR/AND) 동작을 검증합니다.
import { describe, expect, it } from "vitest";

import { products } from "@/data/products";
import { filterProducts, nextSelectedFilterIds } from "@/lib/catalog-filter";

describe("catalog-filter", () => {
  it("ORs categories across Clothes/Skate and ANDs with Brand", () => {
    const selected = new Set(["top", "deck", "brand-butter"]);
    const result = filterProducts(products, selected);
    const ids = result.map((product) => product.id).sort();

    expect(ids).toEqual(["dekeyzer-deck", "plaid-overshirt"]);
  });

  it("ORs multiple brands", () => {
    const selected = new Set(["brand-butter", "brand-april", "brand-polar"]);
    const result = filterProducts(products, selected);

    expect(
      result.every((product) => ["Butter", "April", "Polar"].includes(product.brand)),
    ).toBe(true);
    expect(result.length).toBeGreaterThanOrEqual(3);
  });

  it("clears all filters when root All is toggled", () => {
    const next = nextSelectedFilterIds(new Set(["top", "brand-butter"]), "all");
    expect([...next]).toEqual([]);
  });

  it("replaces group All when a specific item is chosen", () => {
    const withAll = nextSelectedFilterIds(new Set(), "clothes-all");
    expect(withAll.has("clothes-all")).toBe(true);

    const withTop = nextSelectedFilterIds(withAll, "top");
    expect(withTop.has("clothes-all")).toBe(false);
    expect(withTop.has("top")).toBe(true);
  });
});
