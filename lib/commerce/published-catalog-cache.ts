// 역할: 홈 카탈로그가 재방문·새로고침 때 최종 상품 목록으로 한 번만 그려지도록 발행 상품을 탭 단위로 캐시합니다.
import type { Product } from "@/types/store";

const STORAGE_KEY = "paradays:published-catalog:v1";

type StorageLike = Pick<Storage, "getItem" | "setItem" | "removeItem">;

/** undefined = 아직 모름, null = 공개 카탈로그 API 미설정 */
let memoryCache: Product[] | null | undefined;

export function readPublishedCatalogMemoryCache(): Product[] | null | undefined {
  return memoryCache;
}

export function readPublishedCatalogCache(
  storage: StorageLike | null = getSessionStorage(),
): Product[] | null | undefined {
  if (memoryCache !== undefined) {
    return memoryCache;
  }

  if (!storage) {
    return undefined;
  }

  try {
    const raw = storage.getItem(STORAGE_KEY);

    if (!raw) {
      return undefined;
    }

    const parsed: unknown = JSON.parse(raw);

    if (!Array.isArray(parsed) || !parsed.every(isCachedProduct)) {
      storage.removeItem(STORAGE_KEY);
      return undefined;
    }

    memoryCache = parsed;
    return parsed;
  } catch {
    return undefined;
  }
}

export function writePublishedCatalogCache(
  products: Product[] | null,
  storage: StorageLike | null = getSessionStorage(),
) {
  memoryCache = products;

  if (!storage) {
    return;
  }

  try {
    if (products) {
      storage.setItem(STORAGE_KEY, JSON.stringify(products));
    } else {
      storage.removeItem(STORAGE_KEY);
    }
  } catch {
    // 저장 공간 부족·프라이빗 모드여도 메모리 캐시만으로 같은 탭 이동은 계속 부드럽게 동작합니다.
  }
}

export function resetPublishedCatalogCacheForTests() {
  memoryCache = undefined;
}

export function isSamePublishedCatalog(
  left: readonly Product[] | null | undefined,
  right: readonly Product[] | null | undefined,
) {
  if (left === right) {
    return true;
  }

  if (!left || !right) {
    return false;
  }

  return JSON.stringify(left) === JSON.stringify(right);
}

function isCachedProduct(value: unknown): value is Product {
  if (!value || typeof value !== "object") {
    return false;
  }

  const record = value as Record<string, unknown>;

  return (
    typeof record.id === "string" &&
    typeof record.slug === "string" &&
    typeof record.image === "string" &&
    typeof record.price === "number"
  );
}

function getSessionStorage(): StorageLike | null {
  if (typeof window === "undefined") {
    return null;
  }

  try {
    return window.sessionStorage;
  } catch {
    return null;
  }
}
