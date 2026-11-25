// 역할: 상품 목록 선택·필터 훅. 검색어·공개 상태·재고 필터, 드래그 다중 선택과 삭제된 상품 선택 정리, 브랜드 선택지 목록을 관리합니다.
"use client";
import { mergeProductBrandNames } from "@/lib/admin-ui/product-form";
import { type SizeChartKind, type SizeChartValues } from "@/lib/size-chart";
import type { DeckSpec } from "@/types/store";
import {
  useEffect,
  useMemo,
  useRef,
  useState,
  type PointerEvent as ReactPointerEvent,
} from "react";
import { normalizeSearchText } from "./admin-product-name-input";

export function useAdminProductSelection({
  products,
  brands,
  draft,
}: Readonly<{
  products: readonly Readonly<{
    id: string;
    name: string;
    brand: string;
    category: string;
    price: number;
    stock: number;
    isVisible: boolean;
    version: number;
    sku?: string;
    imageUrl?: string;
    compareAtPrice?: number;
    sizes: string;
    description: string;
    isFeatured: boolean;
    nameI18n?: Readonly<{ en: string; ko: string }>;
    descriptionI18n?: Readonly<{ en: readonly string[]; ko: readonly string[] }>;
    deckSpec?: DeckSpec;
    deckSpecsBySize?: Readonly<Record<string, DeckSpec>>;
    sizeChart?: Readonly<{ kind: SizeChartKind; values: SizeChartValues }>;
    sizeChartKind?: SizeChartKind;
    sizeChartsBySize?: Readonly<Record<string, SizeChartValues>>;
  }>[];
  brands: readonly string[];
  draft: Readonly<{
    name: string;
    brand: string;
    category: string;
    sku: string;
    price: string;
    compareAtPrice: string;
    stock: string;
    imageUrl: string;
    sizes: string;
    description: string;
    isVisible: boolean;
    isFeatured: boolean;
    productId?: string;
    version?: number;
    sourceLocale?: "en" | "ko";
    nameI18n?: Readonly<{ en: string; ko: string }>;
    descriptionI18n?: Readonly<{ en: readonly string[]; ko: readonly string[] }>;
  }>;
}>) {
  const [selectedIds, setSelectedIds] = useState<ReadonlySet<string>>(() => new Set());
  const [filterQuery, setFilterQuery] = useState("");
  const [statusFilter, setStatusFilter] = useState<"all" | "published" | "draft">(
    "all",
  );
  const [stockFilter, setStockFilter] = useState<"all" | "inStock" | "soldOut">("all");
  const [optionResetKey, setOptionResetKey] = useState(0);
  const [manualBrandEditor, setManualBrandEditor] = useState<string | null>(null);
  const brandInputRef = useRef<HTMLTextAreaElement | null>(null);
  const brandChoices = useMemo(
    () =>
      mergeProductBrandNames(
        products.map((product) => product.brand),
        brands,
      ),
    [brands, products],
  );
  const selectedBrandIndex = brandChoices.indexOf(draft.brand.trim());
  const dragSelectRef = useRef<"add" | "remove" | null>(null);

  useEffect(() => {
    const endDrag = () => {
      dragSelectRef.current = null;
    };

    window.addEventListener("pointerup", endDrag);
    window.addEventListener("pointercancel", endDrag);
    return () => {
      window.removeEventListener("pointerup", endDrag);
      window.removeEventListener("pointercancel", endDrag);
    };
  }, []);

  useEffect(() => {
    const validIds = new Set(products.map((product) => product.id));
    // eslint-disable-next-line react-hooks/set-state-in-effect -- prunes deleted ids once; returns the same Set when nothing changed.
    setSelectedIds((current) => {
      const next = new Set([...current].filter((productId) => validIds.has(productId)));
      return next.size === current.size ? current : next;
    });
  }, [products]);

  const filteredProducts = useMemo(() => {
    const normalizedQuery = normalizeSearchText(filterQuery);

    return products.filter((product) => {
      if (
        statusFilter === "published" &&
        (!product.isVisible || product.version <= 0)
      ) {
        return false;
      }

      if (statusFilter === "draft" && product.isVisible && product.version > 0) {
        return false;
      }

      if (stockFilter === "inStock" && product.stock <= 0) {
        return false;
      }

      if (stockFilter === "soldOut" && product.stock > 0) {
        return false;
      }

      if (!normalizedQuery) {
        return true;
      }

      return [product.name, product.brand, product.category, product.sku ?? ""].some(
        (field) => normalizeSearchText(field).includes(normalizedQuery),
      );
    });
  }, [filterQuery, products, statusFilter, stockFilter]);

  const allFilteredSelected =
    filteredProducts.length > 0 &&
    filteredProducts.every((product) => selectedIds.has(product.id));

  const applySelection = (productId: string, mode: "add" | "remove") => {
    setSelectedIds((current) => {
      const next = new Set(current);

      if (mode === "add") {
        next.add(productId);
      } else {
        next.delete(productId);
      }

      return next;
    });
  };

  const handleSelectPointerDown = (
    productId: string,
    event: ReactPointerEvent<HTMLButtonElement>,
  ) => {
    if (event.button !== 0) {
      return;
    }

    event.preventDefault();
    const mode = selectedIds.has(productId) ? "remove" : "add";
    dragSelectRef.current = mode;
    applySelection(productId, mode);
  };

  const handleSelectPointerEnter = (productId: string) => {
    if (!dragSelectRef.current) {
      return;
    }

    applySelection(productId, dragSelectRef.current);
  };

  const toggleSelectAllFiltered = () => {
    setSelectedIds((current) => {
      const next = new Set(current);

      if (allFilteredSelected) {
        for (const product of filteredProducts) {
          next.delete(product.id);
        }
      } else {
        for (const product of filteredProducts) {
          next.add(product.id);
        }
      }

      return next;
    });
  };

  const selectedProducts = products.filter((product) => selectedIds.has(product.id));
  return {
    selectedIds,
    filterQuery,
    setFilterQuery,
    statusFilter,
    setStatusFilter,
    stockFilter,
    setStockFilter,
    optionResetKey,
    setOptionResetKey,
    manualBrandEditor,
    setManualBrandEditor,
    brandInputRef,
    brandChoices,
    selectedBrandIndex,
    filteredProducts,
    allFilteredSelected,
    applySelection,
    handleSelectPointerDown,
    handleSelectPointerEnter,
    toggleSelectAllFiltered,
    selectedProducts,
  } as const;
}
