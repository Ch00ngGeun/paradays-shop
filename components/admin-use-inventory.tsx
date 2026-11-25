// 역할: 재고 메뉴 훅. 최신 재고 다시 읽기와 재고 변경(기대 버전·수량 확인, 범위 검증, 서버 저장 또는 이 화면 임시 변경)을 처리하고 알림·운영 기록을 남깁니다.
"use client";
import type { AdminCatalogListItem, AdminDashboardActions } from "@/lib/admin-ui/types";
import { type RefObject } from "react";
import { Notice, OperationActivity } from "./admin-shared";

export function useAdminInventory({
  setInventoryNotice,
  refreshCatalogProducts,
  localProducts,
  inventoryBusyRef,
  actions,
  catalogMutationGenerationRef,
  setLocalProducts,
  recordActivity,
  setInventorySavingIds,
}: Readonly<{
  setInventoryNotice: React.Dispatch<React.SetStateAction<Notice>>;
  refreshCatalogProducts: () => Promise<readonly AdminCatalogListItem[] | null>;
  localProducts: readonly AdminCatalogListItem[];
  inventoryBusyRef: RefObject<Set<string>>;
  actions: AdminDashboardActions | undefined;
  catalogMutationGenerationRef: RefObject<number>;
  setLocalProducts: React.Dispatch<
    React.SetStateAction<readonly AdminCatalogListItem[]>
  >;
  recordActivity: (activity: Omit<OperationActivity, "at">) => void;
  setInventorySavingIds: React.Dispatch<React.SetStateAction<ReadonlySet<string>>>;
}>) {
  const refreshInventoryProducts = async () => {
    setInventoryNotice(null);
    const products = await refreshCatalogProducts();
    if (!products) {
      setInventoryNotice({
        kind: "error",
        message: {
          ko: "최신 재고를 불러오지 못했습니다. 연결을 확인하고 다시 조회해 주세요.",
          en: "Could not load the latest stock. Check the connection and load it again.",
        },
      });
    }
    return products;
  };

  const handleInventoryStockChange = async (
    productId: string,
    nextStock: number,
    expected: Readonly<{ version: number; stock: number }>,
  ): Promise<AdminCatalogListItem | null> => {
    const product = localProducts.find((item) => item.id === productId);

    if (!product || inventoryBusyRef.current.has(productId)) {
      return null;
    }
    if (product.version !== expected.version || product.stock !== expected.stock) {
      setInventoryNotice({
        kind: "error",
        message: {
          ko: "상품 재고가 변경되었습니다. 최신 수량을 다시 확인해 주세요.",
          en: "The product stock has changed. Check the latest quantity again.",
        },
      });
      return null;
    }
    if (!Number.isInteger(nextStock) || nextStock < 0 || nextStock > 1_000_000) {
      setInventoryNotice({
        kind: "error",
        message: {
          ko: "재고는 0~1,000,000 사이의 정수로 입력해 주세요.",
          en: "Enter stock as a whole number from 0 to 1,000,000.",
        },
      });
      return null;
    }

    const clamped = Math.max(0, Math.min(1_000_000, Math.trunc(nextStock)));

    if (clamped === product.stock) {
      return product;
    }

    if (!actions?.updateProductStock || product.version < 1) {
      const updated = { ...product, stock: clamped };
      catalogMutationGenerationRef.current += 1;
      setLocalProducts((current) =>
        current.map((item) => (item.id === productId ? updated : item)),
      );
      setInventoryNotice({
        kind: "success",
        message: {
          ko: `${product.name} 수량을 이 화면에서만 ${clamped}개로 변경했습니다. 서버 재고에는 반영되지 않았습니다.`,
          en: `Changed ${product.name} to ${clamped} on this screen only. Server stock was not updated.`,
        },
      });
      recordActivity({
        key: `inventory:${productId}`,
        section: "inventory",
        status: "draft",
        detail: {
          ko: "이 화면의 수량만 변경했습니다. 서버 재고 미반영",
          en: "Changed the quantity on this screen only. Server stock not updated",
        },
      });
      return updated;
    }

    inventoryBusyRef.current.add(productId);
    setInventorySavingIds((current) => new Set(current).add(productId));
    setInventoryNotice(null);

    try {
      const updated = await actions.updateProductStock({
        id: product.id,
        version: product.version,
        stock: clamped,
      });
      catalogMutationGenerationRef.current += 1;

      setLocalProducts((current) =>
        current.map((item) =>
          item.id === productId && item.version <= updated.version ? updated : item,
        ),
      );
      setInventoryNotice({
        kind: "success",
        message: {
          ko: `${updated.name} 재고를 ${updated.stock}개로 저장했습니다.`,
          en: `Saved ${updated.name} stock as ${updated.stock}.`,
        },
      });
      recordActivity({
        key: `inventory:${productId}`,
        section: "inventory",
        status: "complete",
        detail: {
          ko: "서버가 재고 수량 변경을 확인했습니다.",
          en: "The server confirmed the stock change.",
        },
      });
      return updated;
    } catch {
      const products = await refreshCatalogProducts();
      recordActivity({
        key: `inventory:${productId}`,
        section: "inventory",
        status: "attention",
        detail: {
          ko: "재고 변경 결과를 확인해야 합니다. 중복 반영하지 마세요.",
          en: "Check the stock change result. Do not apply it twice.",
        },
      });
      setInventoryNotice({
        kind: "error",
        message: products
          ? {
              ko: "재고 변경 결과를 다시 확인해야 합니다. 최신 목록을 불러왔으니 수량을 검토한 뒤 다시 시작해 주세요.",
              en: "Check the stock change result again. The latest list is loaded, so review the quantity and start again.",
            }
          : {
              ko: "재고 변경 결과와 최신 수량을 확인하지 못했습니다. 중복 저장하지 말고 새로고침으로 결과를 확인해 주세요.",
              en: "Could not confirm the stock change or the latest quantity. Do not save again; refresh to check the result.",
            },
      });
      return null;
    } finally {
      inventoryBusyRef.current.delete(productId);
      setInventorySavingIds((current) => {
        const next = new Set(current);
        next.delete(productId);
        return next;
      });
    }
  };
  return { refreshInventoryProducts, handleInventoryStockChange } as const;
}
