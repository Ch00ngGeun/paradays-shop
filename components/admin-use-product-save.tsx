// 역할: 상품 저장 훅. 폼 입력과 옵션·가격을 검증하고 공개 저장은 확인받은 뒤, 상품명·설명 번역 필드를 만들어 서버에 저장하거나 이 화면에만 임시 반영하고 알림·운영 기록을 남깁니다.
"use client";
import {
  getAdminProductEditorId,
  ProductEditorSessions,
} from "@/lib/admin-ui/navigation";
import { validateProductOptions } from "@/lib/admin-ui/product-form";
import type {
  AdminCatalogListItem,
  AdminDashboardActions,
  AdminProductDraft,
} from "@/lib/admin-ui/types";
import { buildProductI18nFields, TranslateError } from "@/lib/commerce/translate-text";
import type { Locale } from "@/types/store";
import { type FormEvent, type RefObject } from "react";
import {
  LocalizedText,
  Notice,
  OperationActivity,
  parsePositiveNumber,
} from "./admin-shared";

export function useAdminProductSave({
  productEditors,
  isSavingProduct,
  productWorkspaceActiveRef,
  recordProductActivity,
  setProductNotice,
  actions,
  isKorean,
  setSavingProductEditorId,
  setIsSavingProduct,
  locale,
  rememberLocalProduct,
  finishProductEditor,
  refreshCatalogProducts,
}: Readonly<{
  productEditors: ProductEditorSessions;
  isSavingProduct: boolean;
  productWorkspaceActiveRef: RefObject<boolean>;
  recordProductActivity: (
    editorId: string,
    status: OperationActivity["status"],
    detail?: LocalizedText,
  ) => void;
  setProductNotice: React.Dispatch<React.SetStateAction<Notice>>;
  actions: AdminDashboardActions | undefined;
  isKorean: boolean;
  setSavingProductEditorId: React.Dispatch<React.SetStateAction<string | null>>;
  setIsSavingProduct: React.Dispatch<React.SetStateAction<boolean>>;
  locale: Locale;
  rememberLocalProduct: (productDraft: AdminProductDraft, name: string) => void;
  finishProductEditor: (id: string, productId?: string) => void;
  refreshCatalogProducts: () => Promise<readonly AdminCatalogListItem[] | null>;
}>) {
  const handleProductSave = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const savingEditor = productEditors.getSnapshot();
    if (!savingEditor || isSavingProduct) return;
    const setEditorNotice = (notice: Notice) => {
      if (
        notice?.kind === "error" &&
        productWorkspaceActiveRef.current &&
        productEditors.has(savingEditor.id)
      )
        recordProductActivity(savingEditor.id, "attention", {
          ko: "저장 결과 또는 입력 내용을 확인해야 합니다. 완료로 처리하지 않았습니다.",
          en: "Check the save result or your input. This was not marked as done.",
        });
      if (
        productWorkspaceActiveRef.current &&
        getAdminProductEditorId() === savingEditor.id &&
        productEditors.has(savingEditor.id)
      )
        setProductNotice(notice);
    };
    const productDraft = savingEditor.draft;
    const previewPrice = parsePositiveNumber(productDraft.price);
    const previewCompareAtPrice = parsePositiveNumber(productDraft.compareAtPrice);
    const previewSizes = productDraft.sizes
      .split(",")
      .map((size) => size.trim())
      .filter(Boolean);
    const name = productDraft.name.trim();

    if (!name || !productDraft.brand.trim() || previewPrice <= 0) {
      setEditorNotice({
        kind: "error",
        message: {
          ko: "상품명, 브랜드, 판매가를 입력한 뒤 저장해 주세요.",
          en: "Enter the product name, brand and price, then save.",
        },
      });
      return;
    }

    if (productDraft.isVisible && previewSizes.length === 0) {
      setEditorNotice({
        kind: "error",
        message: {
          ko: "스토어 공개 준비 상품은 최소 한 개의 옵션/사이즈가 필요합니다.",
          en: "A product ready for the store needs at least one option or size.",
        },
      });
      return;
    }

    const optionError = validateProductOptions(productDraft.sizes);
    if (optionError) {
      setEditorNotice({
        kind: "error",
        message:
          optionError === "too-many-options"
            ? {
                ko: "옵션은 최대 20개까지 저장할 수 있습니다.",
                en: "You can save up to 20 options.",
              }
            : {
                ko: "각 옵션은 50자 이하로 입력해 주세요.",
                en: "Keep each option to 50 characters or fewer.",
              },
      });
      return;
    }

    if (previewCompareAtPrice > 0 && previewCompareAtPrice <= previewPrice) {
      setEditorNotice({
        kind: "error",
        message: {
          ko: "기존 정가는 판매가보다 커야 합니다. 판매가를 낮추거나 ‘기존 정가 제거’로 삭제를 확인한 뒤 저장해 주세요.",
          en: "The original price must be higher than the sale price. Lower the sale price, or confirm removal with ‘Remove original price’, then save.",
        },
      });
      return;
    }

    if (productDraft.imageUrl.startsWith("blob:")) {
      if (!actions?.uploadProductImage || !savingEditor.imageFile) {
        setEditorNotice({
          kind: "error",
          message: {
            ko: "상품 이미지 저장소 API가 아직 연결되지 않았습니다. CDK 배포 후 다시 시도해 주세요.",
            en: "The product image storage API is not connected yet. Try again after the CDK deploy.",
          },
        });
        return;
      }
    }

    if (
      productDraft.isVisible &&
      actions?.saveProductDraft &&
      !window.confirm(
        isKorean
          ? `“${name}”을 공개 상태로 저장할까요? 저장하면 상품 정보가 스토어에 표시됩니다.`
          : `Save “${name}” as public? Once saved, the product appears in the store.`,
      )
    ) {
      return;
    }

    const descriptionLines = productDraft.description
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter(Boolean);

    setSavingProductEditorId(savingEditor.id);
    setIsSavingProduct(true);

    let imageUrlForSave = productDraft.imageUrl;

    try {
      if (imageUrlForSave.startsWith("blob:") && savingEditor.imageFile) {
        imageUrlForSave = await actions!.uploadProductImage!(savingEditor.imageFile);
        productEditors.finishImageUpload(savingEditor.id, imageUrlForSave);
      }
    } catch {
      setIsSavingProduct(false);
      setEditorNotice({
        kind: "error",
        message: {
          ko: "상품 이미지를 저장소에 올리지 못했습니다. 파일 형식(JPEG/PNG/WebP/GIF)과 6MB 이하인지 확인해 주세요.",
          en: "Could not upload the product image. Check that it is JPEG/PNG/WebP/GIF and 6MB or smaller.",
        },
      });
      return;
    }

    let translatedDraft: AdminProductDraft;

    if (!productEditors.has(savingEditor.id)) {
      setIsSavingProduct(false);
      return;
    }

    try {
      const i18nFields = await buildProductI18nFields({
        name,
        descriptionLines,
        sourceLocale: locale,
      });

      translatedDraft = {
        ...productDraft,
        name: i18nFields.name,
        description: i18nFields.description.join("\n"),
        imageUrl: imageUrlForSave,
        nameI18n: i18nFields.nameI18n,
        descriptionI18n: i18nFields.descriptionI18n,
        sourceLocale: locale,
      };
    } catch (error) {
      setIsSavingProduct(false);
      setEditorNotice({
        kind: "error",
        message:
          error instanceof TranslateError
            ? {
                ko: error.message,
                en:
                  error.code === "TRANSLATE_NETWORK"
                    ? "Could not reach the translation server. Try again shortly."
                    : "Could not auto-translate the product name and description. Try again shortly.",
              }
            : {
                ko: "상품명·설명을 자동 번역하지 못했습니다. 잠시 후 다시 시도해 주세요.",
                en: "Could not auto-translate the product name and description. Try again shortly.",
              },
      });
      return;
    }

    if (!productEditors.has(savingEditor.id)) {
      setIsSavingProduct(false);
      return;
    }

    if (!actions?.saveProductDraft) {
      rememberLocalProduct({ ...productDraft, imageUrl: imageUrlForSave }, name);
      recordProductActivity(savingEditor.id, "draft", {
        ko: "이 화면에만 임시 보관했습니다. 서버 미저장 · 스토어 미공개",
        en: "Kept on this screen only. Not saved to the server · Not in the store",
      });
      setEditorNotice({
        kind: "success",
        message: {
          ko: `“${name}”을 이 브라우저의 임시 목록에만 보관했습니다. 서버에 저장하거나 스토어에 공개하지 않았으며 새로고침하면 사라집니다.`,
          en: `Kept “${name}” only in this browser’s temporary list. It was not saved to the server or published, and it disappears on refresh.`,
        },
      });
      finishProductEditor(savingEditor.id, productDraft.productId);
      setIsSavingProduct(false);
      return;
    }

    try {
      await actions.saveProductDraft(translatedDraft);

      if (!productWorkspaceActiveRef.current) return;

      if (actions.listCatalogProducts) {
        await refreshCatalogProducts();
      } else {
        rememberLocalProduct({ ...productDraft, imageUrl: imageUrlForSave }, name);
      }

      if (!productWorkspaceActiveRef.current) return;

      recordProductActivity(
        savingEditor.id,
        productDraft.isVisible ? "complete" : "draft",
        productDraft.isVisible
          ? {
              ko: "서버가 상품 공개 저장을 확인했습니다.",
              en: "The server confirmed the public product save.",
            }
          : {
              ko: "상품을 비공개로 서버에 저장했습니다. 스토어 미공개",
              en: "Saved the product to the server as private. Not in the store",
            },
      );
      setEditorNotice({
        kind: "success",
        message: productDraft.isVisible
          ? {
              ko: "상품을 공개 상태로 저장했습니다. 이미지와 한/영 문구가 함께 반영되었습니다.",
              en: "Saved the product as public. The image and Korean/English text were applied.",
            }
          : {
              ko: "상품을 비공개로 저장했습니다. 고객에게는 표시되지 않습니다.",
              en: "Saved the product as private. Customers will not see it.",
            },
      });
      finishProductEditor(savingEditor.id, productDraft.productId);
    } catch {
      setEditorNotice({
        kind: "error",
        message: {
          ko: "상품을 저장하지 못했습니다. 네트워크와 관리자 권한을 확인해 주세요.",
          en: "Could not save the product. Check the network and admin access.",
        },
      });
    } finally {
      setIsSavingProduct(false);
    }
  };
  return { handleProductSave } as const;
}
