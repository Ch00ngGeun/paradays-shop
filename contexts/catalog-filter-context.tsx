// 역할: 메뉴 다중 선택 필터 상태를 홈 카탈로그와 공유합니다.
"use client";

import {
  createContext,
  useCallback,
  useContext,
  useMemo,
  useState,
  type ReactNode,
} from "react";

import { nextSelectedFilterIds } from "@/lib/catalog-filter";

type CatalogFilterContextValue = {
  selectedIds: ReadonlySet<string>;
  isSelected: (itemId: string) => boolean;
  toggleFilter: (itemId: string) => void;
  clearFilters: () => void;
};

const CatalogFilterContext = createContext<CatalogFilterContextValue | null>(null);

/** 메뉴·상품 그리드가 같은 선택 집합을 쓰게 함 */
export function CatalogFilterProvider({ children }: { children: ReactNode }) {
  const [selectedIds, setSelectedIds] = useState<Set<string>>(() => new Set());

  const toggleFilter = useCallback((itemId: string) => {
    setSelectedIds((current) => nextSelectedFilterIds(current, itemId));
  }, []);

  const clearFilters = useCallback(() => {
    setSelectedIds(new Set());
  }, []);

  const value = useMemo<CatalogFilterContextValue>(
    () => ({
      selectedIds,
      isSelected: (itemId: string) =>
        itemId === "all" ? selectedIds.size === 0 : selectedIds.has(itemId),
      toggleFilter,
      clearFilters,
    }),
    [selectedIds, toggleFilter, clearFilters],
  );

  return (
    <CatalogFilterContext.Provider value={value}>
      {children}
    </CatalogFilterContext.Provider>
  );
}

export function useCatalogFilter() {
  const context = useContext(CatalogFilterContext);

  if (!context) {
    throw new Error("useCatalogFilter must be used within CatalogFilterProvider");
  }

  return context;
}
