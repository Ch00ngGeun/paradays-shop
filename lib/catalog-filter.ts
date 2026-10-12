// 역할: 메뉴 다중 선택을 카탈로그 필터 조건으로 해석합니다.
// 같은 차원(카테고리·브랜드) 안은 OR, 차원 끼리는 AND.

import type { Product } from "@/types/store";

/** Clothes 그룹이 가리키는 상품 category 값 */
export const CLOTHES_CATEGORIES = [
  "Top",
  "Bottoms",
  "Accessories",
  "Shoes",
  "Acc",
] as const;

/** SkateBoard 그룹이 가리키는 상품 category 값 */
export const SKATE_CATEGORIES = ["Deck", "Wheels", "Trucks", "Acc"] as const;

const CLOTHES_ITEM_CATEGORIES: Record<string, string> = {
  top: "Top",
  bottoms: "Bottoms",
  accessories: "Accessories",
  shoes: "Shoes",
  "clothes-acc": "Acc",
};

const SKATE_ITEM_CATEGORIES: Record<string, string> = {
  deck: "Deck",
  wheels: "Wheels",
  truck: "Trucks",
  "skate-acc": "Acc",
};

const BRAND_ITEM_IDS: Record<string, string> = {
  "brand-april": "April",
  "brand-avenir": "Avenir",
  "brand-butter": "Butter",
  "brand-cashonly": "Cash Only",
  "brand-dc": "DC",
  "brand-deathwish": "Deathwish",
  "brand-dgk": "DGK",
  "brand-dime": "Dime",
  "brand-fuckingawesome": "Fucking Awesome",
  "brand-heaps": "Heaps",
  "brand-k88": "K88",
  "brand-paradays": "PARADAYS",
  "brand-polar": "Polar",
  "brand-primitive": "Primitive",
  "brand-spitfire": "Spitfire",
};

export const CLOTHES_FILTER_IDS = [
  "clothes-all",
  ...Object.keys(CLOTHES_ITEM_CATEGORIES),
] as const;

export const SKATE_FILTER_IDS = [
  "skateboard-all",
  ...Object.keys(SKATE_ITEM_CATEGORIES),
] as const;

export const BRAND_FILTER_IDS = ["brand-all", ...Object.keys(BRAND_ITEM_IDS)] as const;

/** 메뉴 id 토글 시 같은 그룹의 All과 개별 항목이 서로 배타적으로 바뀌게 함 */
export function nextSelectedFilterIds(
  current: ReadonlySet<string>,
  itemId: string,
): Set<string> {
  const next = new Set(current);

  if (itemId === "all") {
    return new Set();
  }

  const toggleInGroup = (groupIds: readonly string[], allId: string) => {
    if (itemId === allId) {
      for (const id of groupIds) {
        if (id !== allId) {
          next.delete(id);
        }
      }
      if (next.has(allId)) {
        next.delete(allId);
      } else {
        next.add(allId);
      }
      return;
    }

    next.delete(allId);
    if (next.has(itemId)) {
      next.delete(itemId);
    } else {
      next.add(itemId);
    }
  };

  if ((CLOTHES_FILTER_IDS as readonly string[]).includes(itemId)) {
    toggleInGroup(CLOTHES_FILTER_IDS, "clothes-all");
    return next;
  }

  if ((SKATE_FILTER_IDS as readonly string[]).includes(itemId)) {
    toggleInGroup(SKATE_FILTER_IDS, "skateboard-all");
    return next;
  }

  if ((BRAND_FILTER_IDS as readonly string[]).includes(itemId)) {
    toggleInGroup(BRAND_FILTER_IDS, "brand-all");
    return next;
  }

  if (itemId === "sale") {
    if (next.has("sale")) {
      next.delete("sale");
    } else {
      next.add("sale");
    }
    return next;
  }

  return next;
}

type ResolvedFilters = {
  categories: string[] | null;
  brands: string[] | null;
  saleOnly: boolean;
};

/** 선택된 메뉴 id → 필터 차원 (null = 해당 차원 제한 없음) */
export function resolveCatalogFilters(
  selectedIds: ReadonlySet<string>,
): ResolvedFilters {
  const categories = new Set<string>();
  let hasCategorySelection = false;

  if (selectedIds.has("clothes-all")) {
    hasCategorySelection = true;
    for (const category of CLOTHES_CATEGORIES) {
      categories.add(category);
    }
  } else {
    for (const [id, category] of Object.entries(CLOTHES_ITEM_CATEGORIES)) {
      if (selectedIds.has(id)) {
        hasCategorySelection = true;
        categories.add(category);
      }
    }
  }

  if (selectedIds.has("skateboard-all")) {
    hasCategorySelection = true;
    for (const category of SKATE_CATEGORIES) {
      categories.add(category);
    }
  } else {
    for (const [id, category] of Object.entries(SKATE_ITEM_CATEGORIES)) {
      if (selectedIds.has(id)) {
        hasCategorySelection = true;
        categories.add(category);
      }
    }
  }

  let brands: string[] | null = null;
  if (selectedIds.has("brand-all")) {
    brands = null;
  } else {
    const selectedBrands: string[] = [];
    for (const [id, brand] of Object.entries(BRAND_ITEM_IDS)) {
      if (selectedIds.has(id)) {
        selectedBrands.push(brand);
      }
    }
    if (selectedBrands.length > 0) {
      brands = selectedBrands;
    }
  }

  return {
    categories: hasCategorySelection ? [...categories] : null,
    brands,
    saleOnly: selectedIds.has("sale"),
  };
}

/** 상품 목록에 필터 적용 (카테고리·브랜드 각각 OR, 차원 간 AND) */
export function filterProducts(
  catalog: readonly Product[],
  selectedIds: ReadonlySet<string>,
): Product[] {
  if (selectedIds.size === 0) {
    return [...catalog];
  }

  const { categories, brands, saleOnly } = resolveCatalogFilters(selectedIds);

  return catalog.filter((product) => {
    if (categories && !categories.includes(product.category)) {
      return false;
    }

    if (brands && !brands.includes(product.brand)) {
      return false;
    }

    if (saleOnly && product.compareAtPrice == null) {
      return false;
    }

    return true;
  });
}
