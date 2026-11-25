// 역할: 관리자 상품 목록을 API에서 불러오는 훅. 요청·변경 세대 번호로 늦게 도착한 응답을 버리고, 실패하면 불러오기 실패 상태와 알림을 남깁니다.
"use client";
import type { AdminCatalogListItem, AdminDashboardActions } from "@/lib/admin-ui/types";
import { useEffect, type RefObject } from "react";
import { Notice } from "./admin-shared";

export function useAdminCatalog({
  actions,
  catalogRequestGenerationRef,
  catalogMutationGenerationRef,
  setIsLoadingProducts,
  setCatalogLoadFailed,
  setLocalProducts,
  setProductNotice,
}: Readonly<{
  actions: AdminDashboardActions | undefined;
  catalogRequestGenerationRef: RefObject<number>;
  catalogMutationGenerationRef: RefObject<number>;
  setIsLoadingProducts: React.Dispatch<React.SetStateAction<boolean>>;
  setCatalogLoadFailed: React.Dispatch<React.SetStateAction<boolean>>;
  setLocalProducts: React.Dispatch<
    React.SetStateAction<readonly AdminCatalogListItem[]>
  >;
  setProductNotice: React.Dispatch<React.SetStateAction<Notice>>;
}>) {
  const refreshCatalogProducts = async () => {
    if (!actions?.listCatalogProducts) {
      return null;
    }

    const requestGeneration = ++catalogRequestGenerationRef.current;
    const mutationGeneration = catalogMutationGenerationRef.current;
    const current = () =>
      requestGeneration === catalogRequestGenerationRef.current &&
      mutationGeneration === catalogMutationGenerationRef.current;
    setIsLoadingProducts(true);
    setCatalogLoadFailed(false);

    try {
      const products = await actions.listCatalogProducts();
      if (!current()) return null;
      setLocalProducts(products);
      return products;
    } catch {
      if (!current()) return null;
      setCatalogLoadFailed(true);
      setProductNotice({
        kind: "error",
        message: {
          ko: "상품 목록을 불러오지 못했습니다. 관리자 권한과 API를 확인해 주세요.",
          en: "Could not load the product list. Check admin access and the API.",
        },
      });
      return null;
    } finally {
      if (requestGeneration === catalogRequestGenerationRef.current)
        setIsLoadingProducts(false);
    }
  };

  useEffect(() => {
    void refreshCatalogProducts();
    // actions 객체는 getAccessToken 참조로 바뀌므로 listCatalogProducts 존재 여부만 의존합니다.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [Boolean(actions?.listCatalogProducts)]);
  return { refreshCatalogProducts } as const;
}
