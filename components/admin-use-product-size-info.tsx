"use client";
import {
  getAdminProductEditorId,
  ProductEditorSessions,
} from "@/lib/admin-ui/navigation";
import { createProductSku, renameProductOption } from "@/lib/admin-ui/product-form";
import type { AdminCatalogListItem, AdminDashboardActions } from "@/lib/admin-ui/types";
import { AdminApiRequestError } from "@/lib/commerce/admin-api-client";
import { type SizeChartKind, type SizeChartValues } from "@/lib/size-chart";
import type { DeckSpec } from "@/types/store";
import { type RefObject } from "react";
import { emptyProductDraft, Notice } from "./admin-shared";

export function useAdminProductSizeInfo({
  productEditor,
  refreshCatalogProducts,
  setProductNotice,
  catalogMutationGenerationRef,
  setLocalProducts,
  productEditors,
  actions,
  removePendingProductActivity,
  localProducts,
}: Readonly<{
  productEditor: ReturnType<ProductEditorSessions["getSnapshot"]>;
  refreshCatalogProducts: () => Promise<readonly AdminCatalogListItem[] | null>;
  setProductNotice: React.Dispatch<React.SetStateAction<Notice>>;
  catalogMutationGenerationRef: RefObject<number>;
  setLocalProducts: React.Dispatch<
    React.SetStateAction<readonly AdminCatalogListItem[]>
  >;
  productEditors: ProductEditorSessions;
  actions: AdminDashboardActions | undefined;
  removePendingProductActivity: (editorId: string) => void;
  localProducts: readonly AdminCatalogListItem[];
}>) {
  /**
   * 상세사이즈 모달 저장: 상품 저장과 별도로 즉시 서버에 반영합니다.
   * 폼이 기준으로 삼은 version으로만 보내므로, 그 사이 다른 곳에서 바뀌었으면 409로 멈추고 덮어쓰지 않습니다.
   * 직접 받은 성공 응답일 때만 폼 version을 올려 이후 상품 저장이 409가 나지 않게 합니다.
   */
  const patchProductSizeInfo = async (
    send: ((id: string, version: number) => Promise<AdminCatalogListItem>) | undefined,
    size?: string,
    sizeName?: string,
  ) => {
    const editor = productEditor;
    const productId = editor?.draft.productId;
    const version = editor?.draft.version;

    if (!send || !editor || !productId || !version) {
      throw new Error("SIZE_INFO_UNAVAILABLE");
    }

    let updated: AdminCatalogListItem;
    try {
      updated = await send(productId, version);
    } catch (error) {
      const code =
        error instanceof AdminApiRequestError ? error.responseCode : undefined;
      // A rename refused for reserved stock or a duplicate leaves the product unchanged; the modal explains it.
      if (code === "CATALOG_PRODUCT_RESERVED" || code === "CATALOG_PRODUCT_DUPLICATE")
        throw error;
      // Success is never guessed from a re-read; a conflict only refreshes the list and asks to reopen.
      if (error instanceof AdminApiRequestError && error.status === 409) {
        void refreshCatalogProducts();
        if (getAdminProductEditorId() === editor.id)
          setProductNotice({
            kind: "error",
            message: {
              ko: "다른 곳에서 이 상품이 바뀌었거나 이전 상세사이즈 저장이 이미 반영됐습니다. 편집을 닫고 다시 열어 최신 값을 확인한 뒤 저장해 주세요.",
              en: "This product changed elsewhere, or an earlier size spec save was already applied. Close and reopen the editor, check the latest values, then save.",
            },
          });
      }
      throw error;
    }
    catalogMutationGenerationRef.current += 1;
    setLocalProducts((current) =>
      current.map((item) =>
        item.id === updated.id && item.version <= updated.version ? updated : item,
      ),
    );
    // 버튼 옆 요약이 바뀌는 것으로 저장을 알립니다. 상품 저장 완료 알림(productSaved)과 섞지 않습니다.
    // A rename also renames the chip, so the next product save sends the new name instead of undoing it.
    productEditors.updateDraft(editor.id, (current) =>
      current.productId === updated.id && current.version === version
        ? {
            ...current,
            version: updated.version,
            ...(size !== undefined && sizeName !== undefined
              ? { sizes: renameProductOption(current.sizes, size, sizeName) }
              : {}),
          }
        : current,
    );
  };
  const saveProductDeckSpec = (
    deckSpec: DeckSpec | null,
    size?: string,
    sizeName?: string,
  ) => {
    const update = actions?.updateProductDeckSpec;
    return patchProductSizeInfo(
      update &&
        ((id, version) =>
          update({
            id,
            version,
            deckSpec,
            ...(size === undefined ? {} : { size }),
            ...(sizeName === undefined ? {} : { sizeName }),
          })),
      size,
      sizeName,
    );
  };
  /** 의류·휠 상세사이즈: 기본값은 도면 종류와 함께, 옵션 값은 옵션 전용 PATCH로 보냅니다. */
  const saveProductSizeChart = (
    kind: SizeChartKind,
    values: SizeChartValues | null,
    size?: string,
    sizeName?: string,
  ) => {
    const saveDefault = actions?.updateProductSizeChart;
    const saveOption = actions?.updateProductOptionSizeChart;
    return patchProductSizeInfo(
      size === undefined
        ? saveDefault &&
            ((id, version) =>
              saveDefault({ id, version, sizeChart: values && { kind, values } }))
        : saveOption &&
            ((id, version) =>
              saveOption({
                id,
                version,
                size,
                ...(sizeName === undefined ? {} : { sizeName }),
                sizeChartValues: values,
              })),
      size,
      sizeName,
    );
  };
  const changeProductSizeChartKind = (sizeChartKind: SizeChartKind) => {
    const change = actions?.updateProductSizeChartKind;
    return patchProductSizeInfo(
      change && ((id, version) => change({ id, version, sizeChartKind })),
    );
  };

  const resetProductDraft = () => {
    if (productEditor) {
      removePendingProductActivity(productEditor.id);
      const original = localProducts.find(
        (product) => product.id === productEditor.draft.productId,
      );
      productEditors.reset(productEditor.id, {
        ...emptyProductDraft,
        sku:
          productEditor.mode === "create"
            ? createProductSku()
            : productEditor.draft.sku,
        compareAtPrice:
          productEditor.mode === "edit"
            ? original
              ? typeof original.compareAtPrice === "number"
                ? String(original.compareAtPrice)
                : ""
              : productEditor.draft.compareAtPrice
            : "",
      });
    }
    setProductNotice(null);
  };
  return {
    saveProductDeckSpec,
    saveProductSizeChart,
    changeProductSizeChartKind,
    resetProductDraft,
  } as const;
}
