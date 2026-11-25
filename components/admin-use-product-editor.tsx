// 역할: 상품 편집 세션 훅. 새 상품·기존 상품 편집기 열기와 닫기, 이 화면 임시 상품 기억, 입력·공개 토글 변경, 대표 이미지 파일 선택을 처리합니다.
"use client";
import {
  getAdminProductEditorId,
  navigateToAdminProductEditor,
  navigateToAdminSection,
  ProductEditorSessions,
} from "@/lib/admin-ui/navigation";
import { createProductSku } from "@/lib/admin-ui/product-form";
import type { AdminCatalogListItem, AdminProductDraft } from "@/lib/admin-ui/types";
import { type ChangeEvent } from "react";
import {
  emptyProductDraft,
  LocalizedText,
  Notice,
  OperationActivity,
  operationEventTime,
  parsePositiveNumber,
} from "./admin-shared";

export function useAdminProductEditor({
  productEditors,
  setProductNotice,
  recordProductActivity,
  setLocalProducts,
  productEditor,
}: Readonly<{
  productEditors: ProductEditorSessions;
  setProductNotice: React.Dispatch<React.SetStateAction<Notice>>;
  recordProductActivity: (
    editorId: string,
    status: OperationActivity["status"],
    detail?: LocalizedText,
  ) => void;
  setLocalProducts: React.Dispatch<
    React.SetStateAction<readonly AdminCatalogListItem[]>
  >;
  productEditor: ReturnType<ProductEditorSessions["getSnapshot"]>;
}>) {
  const openNewProductEditor = () => {
    const id = productEditors.open("create", {
      ...emptyProductDraft,
      sku: createProductSku(),
    });
    setProductNotice(null);
    recordProductActivity(id, "working");
    navigateToAdminProductEditor(id);
  };

  const finishProductEditor = (id: string, productId?: string) => {
    const isCurrentEditor = getAdminProductEditorId() === id;
    if (productId) productEditors.invalidateProducts(new Set([productId]));
    productEditors.remove(id);
    if (isCurrentEditor) navigateToAdminSection("products", { replace: true });
  };

  const rememberLocalProduct = (productDraft: AdminProductDraft, name: string) => {
    const previewPrice = parsePositiveNumber(productDraft.price);
    const previewCompareAtPrice = parsePositiveNumber(productDraft.compareAtPrice);
    const stockValue = Number.parseInt(productDraft.stock, 10);
    const nextItem: AdminCatalogListItem = {
      id: productDraft.productId ?? `local_${operationEventTime()}`,
      name,
      brand: productDraft.brand.trim() || "—",
      category: productDraft.category,
      price: previewPrice,
      stock: Number.isFinite(stockValue) && stockValue >= 0 ? stockValue : 0,
      isVisible: productDraft.isVisible,
      version: productDraft.version ?? 0,
      sizes: productDraft.sizes,
      description: productDraft.description,
      isFeatured: productDraft.isFeatured,
      ...(productDraft.sku.trim() ? { sku: productDraft.sku.trim() } : {}),
      ...(productDraft.imageUrl ? { imageUrl: productDraft.imageUrl } : {}),
      ...(previewCompareAtPrice > 0 ? { compareAtPrice: previewCompareAtPrice } : {}),
      ...(productDraft.nameI18n ? { nameI18n: productDraft.nameI18n } : {}),
      ...(productDraft.descriptionI18n
        ? { descriptionI18n: productDraft.descriptionI18n }
        : {}),
    };

    setLocalProducts((current) => [
      nextItem,
      ...current.filter((product) => product.id !== nextItem.id),
    ]);
  };

  const openProductEditor = (
    product: AdminCatalogListItem,
    mode: "create" | "edit",
  ) => {
    const id = productEditors.open(mode, {
      name: product.name,
      brand: product.brand === "—" ? "" : product.brand,
      category: product.category,
      sku: product.sku ?? "",
      price: String(product.price || ""),
      compareAtPrice:
        typeof product.compareAtPrice === "number"
          ? String(product.compareAtPrice)
          : "",
      stock: String(product.stock),
      imageUrl: product.imageUrl ?? "/images/product-placeholder.svg",
      sizes: product.sizes,
      description: product.description,
      isVisible: product.isVisible,
      isFeatured: product.isFeatured,
      ...(mode === "edit" && product.version > 0
        ? { productId: product.id, version: product.version }
        : mode === "edit"
          ? { productId: product.id }
          : {}),
      ...(product.nameI18n ? { nameI18n: product.nameI18n } : {}),
      ...(product.descriptionI18n ? { descriptionI18n: product.descriptionI18n } : {}),
    });
    setProductNotice(null);
    navigateToAdminProductEditor(id);
  };

  const updateProductText = (
    field: Exclude<
      keyof AdminProductDraft,
      | "isVisible"
      | "isFeatured"
      | "nameI18n"
      | "descriptionI18n"
      | "sourceLocale"
      | "productId"
      | "version"
    >,
    value: string,
  ) => {
    if (productEditor) {
      productEditors.updateDraft(productEditor.id, (current) => ({
        ...current,
        [field]: value,
      }));
      recordProductActivity(productEditor.id, "working");
    }
  };

  const updateProductToggle = (field: "isVisible" | "isFeatured", value: boolean) => {
    if (productEditor) {
      productEditors.updateDraft(productEditor.id, (current) => ({
        ...current,
        [field]: value,
      }));
      recordProductActivity(productEditor.id, "working");
    }
  };

  const handleProductImageChange = (event: ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0];

    if (!file || !productEditor) {
      return;
    }

    const objectUrl = URL.createObjectURL(file);
    productEditors.setImage(productEditor.id, file, objectUrl);
    recordProductActivity(productEditor.id, "working");
    setProductNotice({
      kind: "success",
      message: {
        ko: "이미지가 미리보기에 반영되었습니다. 아직 저장되지 않았습니다.",
        en: "The image is shown in the preview. It is not saved yet.",
      },
    });
  };
  return {
    openNewProductEditor,
    finishProductEditor,
    rememberLocalProduct,
    openProductEditor,
    updateProductText,
    updateProductToggle,
    handleProductImageChange,
  } as const;
}
