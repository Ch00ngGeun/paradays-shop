// 역할: 메뉴 다중 선택 필터 상태를 홈 카탈로그와 공유합니다.
"use client";

import {
  createContext,
  useCallback,
  useContext,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from "react";

import { nextSelectedFilterIds } from "@/lib/catalog-filter";
import {
  readCatalogFilterSession,
  writeCatalogFilterSession,
} from "@/lib/catalog-filter-session";

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
  const selectedIdsRef = useRef<Set<string>>(new Set());
  const initializedRef = useRef(false);

  const getCurrentIds = useCallback(() => {
    if (!initializedRef.current) {
      selectedIdsRef.current = readCatalogFilterSession();
      initializedRef.current = true;
    }
    return selectedIdsRef.current;
  }, []);

  useLayoutEffect(() => {
    // SSR와 첫 hydration은 빈 값으로 일치시키고 첫 페인트 전에 복원합니다.
    // 자식 layout effect에서 먼저 조작해도 한 번만 복원하며 나중에 덮어쓰지 않습니다.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setSelectedIds(getCurrentIds());
  }, [getCurrentIds]);

  const toggleFilter = useCallback(
    (itemId: string) => {
      const next = nextSelectedFilterIds(getCurrentIds(), itemId);
      selectedIdsRef.current = next;
      writeCatalogFilterSession(next);
      setSelectedIds(next);
    },
    [getCurrentIds],
  );

  const clearFilters = useCallback(() => {
    getCurrentIds();
    const next = new Set<string>();
    selectedIdsRef.current = next;
    writeCatalogFilterSession(next);
    setSelectedIds(next);
  }, [getCurrentIds]);

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
