// 역할: 상품 삭제 훅. 선택 상품 삭제를 확인받아 서버 상품은 API로 지우고 이 화면에만 있는 상품은 로컬 목록에서 빼며, 알림·운영 기록을 남깁니다.
"use client";
import { ProductEditorSessions } from "@/lib/admin-ui/navigation";
import type { AdminCatalogListItem, AdminDashboardActions } from "@/lib/admin-ui/types";
import { Notice } from "./admin-shared";

export function useAdminProductDelete({
  isDeletingProducts,
  isKorean,
  setIsDeletingProducts,
  actions,
  setProductNotice,
  refreshCatalogProducts,
  setLocalProducts,
  productEditors,
}: Readonly<{
  isDeletingProducts: boolean;
  isKorean: boolean;
  setIsDeletingProducts: React.Dispatch<React.SetStateAction<boolean>>;
  actions: AdminDashboardActions | undefined;
  setProductNotice: React.Dispatch<React.SetStateAction<Notice>>;
  refreshCatalogProducts: () => Promise<readonly AdminCatalogListItem[] | null>;
  setLocalProducts: React.Dispatch<
    React.SetStateAction<readonly AdminCatalogListItem[]>
  >;
  productEditors: ProductEditorSessions;
}>) {
  const handleDeleteProducts = async (
    items: ReadonlyArray<Readonly<{ id: string; version: number }>>,
  ) => {
    if (items.length === 0 || isDeletingProducts) {
      return;
    }

    const confirmed = window.confirm(
      items.length === 1
        ? isKorean
          ? "선택한 상품을 삭제할까요? 이 작업은 되돌릴 수 없습니다."
          : "Delete the selected product? This cannot be undone."
        : isKorean
          ? `선택한 ${items.length}개 상품을 삭제할까요? 이 작업은 되돌릴 수 없습니다.`
          : `Delete the ${items.length} selected products? This cannot be undone.`,
    );

    if (!confirmed) {
      return;
    }

    const apiItems = items.filter((item) => item.version > 0);
    const localOnlyIds = new Set(
      items.filter((item) => item.version <= 0).map((item) => item.id),
    );

    setIsDeletingProducts(true);

    try {
      if (apiItems.length > 0) {
        if (!actions?.deleteCatalogProducts) {
          setProductNotice({
            kind: "error",
            message: {
              ko: "상품 삭제 API가 아직 연결되지 않았습니다.",
              en: "The product delete API is not connected yet.",
            },
          });
          return;
        }

        await actions.deleteCatalogProducts(apiItems);

        if (actions.listCatalogProducts) {
          await refreshCatalogProducts();
        }
      }

      if (localOnlyIds.size > 0) {
        setLocalProducts((current) =>
          current.filter((product) => !localOnlyIds.has(product.id)),
        );
      }

      productEditors.invalidateProducts(new Set(items.map((item) => item.id)));

      setProductNotice({
        kind: "success",
        message:
          items.length === 1
            ? { ko: "상품을 삭제했습니다.", en: "Deleted the product." }
            : {
                ko: `${items.length}개 상품을 삭제했습니다.`,
                en: `Deleted ${items.length} products.`,
              },
      });
    } catch {
      setProductNotice({
        kind: "error",
        message: {
          ko: "상품을 삭제하지 못했습니다. 관리자 권한과 API를 확인해 주세요.",
          en: "Could not delete the products. Check admin access and the API.",
        },
      });
    } finally {
      setIsDeletingProducts(false);
    }
  };
  return { handleDeleteProducts } as const;
}
