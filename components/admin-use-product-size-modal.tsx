"use client";
import adminSharedStyles from "./admin-shared.module.css";
import { listProductOptions } from "@/lib/admin-ui/product-form";
import { AdminApiRequestError } from "@/lib/commerce/admin-api-client";
import {
  defaultSizeChartKind,
  sizeChartKindsFor,
  type SizeChartKind,
  type SizeChartValues,
} from "@/lib/size-chart";
import type { DeckSpec, Locale } from "@/types/store";
import { useRef, useState } from "react";
import { AdminHelpButton } from "./admin-help-button";

export function useAdminProductSizeModal({
  products,
  draft,
  view,
  editorId,
  setNameLineNotice,
  onSaveDeckSpec,
  onSaveSizeChart,
  isKorean,
  locale,
  canSaveToServer,
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
  view: "create" | "edit" | "list";
  editorId: string;
  setNameLineNotice: React.Dispatch<React.SetStateAction<"blocked" | "merged" | null>>;
  onSaveDeckSpec:
    | ((deckSpec: DeckSpec | null, size?: string, sizeName?: string) => Promise<void>)
    | undefined;
  onSaveSizeChart:
    | ((
        kind: SizeChartKind,
        values: SizeChartValues | null,
        size?: string,
        sizeName?: string,
      ) => Promise<void>)
    | undefined;
  isKorean: boolean;
  locale: Locale;
  canSaveToServer: boolean;
}>) {
  const currentProduct = products.find((product) => product.id === draft.productId);
  const deckSpec = currentProduct?.deckSpec;
  const deckSpecsBySize = currentProduct?.deckSpecsBySize;
  const optionDeckSpecCount = Object.keys(deckSpecsBySize ?? {}).length;
  // 옵션 모달은 서버가 검증하는 저장된 옵션만 엽니다. 새로 추가한 칩은 상품 저장 뒤에 열 수 있습니다.
  const savedSizes = listProductOptions(currentProduct?.sizes ?? "");
  // 모달은 열 때마다 새 번호를 받고, 저장 응답은 자기 번호의 모달만 닫습니다. 편집기를 벗어나면 모달을 비웁니다.
  const deckSpecSessionRef = useRef(0);
  const [deckSpecModal, setDeckSpecModal] = useState<{
    editorKey: string;
    session: number;
    /** 칩에서 연 옵션. 없으면 기본값(모든 옵션 공통) 모달입니다. */
    size?: string;
  } | null>(null);
  const modalSize = deckSpecModal?.size;
  // The server renames every equal entry, so a duplicated legacy name only edits its chart.
  const modalNameEditable =
    modalSize !== undefined &&
    savedSizes.filter((size) => size === modalSize).length === 1;
  const editorKey = `${view}:${editorId}`;
  const [deckSpecEditorKey, setDeckSpecEditorKey] = useState(editorKey);
  if (deckSpecEditorKey !== editorKey) {
    setDeckSpecEditorKey(editorKey);
    setDeckSpecModal(null);
    setNameLineNotice(null);
  }
  const canEditDeckSpec = Boolean(onSaveDeckSpec && draft.productId && draft.version);
  // Clothing and wheel size charts: the drawing follows the saved product, like the server.
  const sizeChartKinds = sizeChartKindsFor(draft.category);
  const sizeChart = currentProduct?.sizeChart;
  const sizeChartsBySize = currentProduct?.sizeChartsBySize;
  const sizeChartKind =
    sizeChart?.kind ??
    currentProduct?.sizeChartKind ??
    defaultSizeChartKind(draft.category);
  const optionSizeChartCount = Object.keys(sizeChartsBySize ?? {}).length;
  // The server checks the saved category, so a changed category is saved before its chart.
  const canEditSizeChart = Boolean(
    onSaveSizeChart &&
      draft.productId &&
      draft.version &&
      currentProduct?.category === draft.category,
  );
  const usesDeckSpec = draft.category === "Deck";
  const canEditSizeInfo = usesDeckSpec ? canEditDeckSpec : canEditSizeChart;
  const describeSizeInfoError = (error: unknown) => {
    const code = error instanceof AdminApiRequestError ? error.responseCode : undefined;
    return code === "CATALOG_PRODUCT_RESERVED"
      ? isKorean
        ? "결제 대기 중인 주문이 있어 지금은 옵션 이름을 바꿀 수 없습니다. 주문이 결제되거나 취소된 뒤 다시 시도하거나, 이름은 그대로 두고 상세사이즈만 저장해 주세요."
        : "An order awaiting payment holds this product, so the option name cannot change now. Try again after the order is paid or canceled, or keep the name and save only the size chart."
      : code === "CATALOG_PRODUCT_DUPLICATE"
        ? isKorean
          ? "같은 이름·브랜드의 다른 상품에 이 옵션이 있어 이 이름으로 바꿀 수 없습니다."
          : "Another product with the same name and brand already has this option, so this name cannot be used."
        : undefined;
  };
  const modalNotice =
    modalSize !== undefined && !modalNameEditable
      ? isKorean
        ? "같은 이름의 옵션이 여러 개 저장돼 있어 이름은 바꿀 수 없고 상세사이즈만 편집합니다. 중복 칩을 지우고 상품을 저장하면 이름도 바꿀 수 있습니다."
        : "Several saved options share this name, so only the size chart can be edited. Remove the duplicate chip and save the product to rename it."
      : undefined;
  const modalOtherOptions = modalNameEditable
    ? // Draft chips count too, so a rename cannot collide with an option added but not saved.
      [...new Set([...savedSizes, ...listProductOptions(draft.sizes)])].filter(
        (size) => size !== modalSize,
      )
    : undefined;
  const sizeInfoHelp = (
    <span className={adminSharedStyles.fieldHelp}>
      <AdminHelpButton locale={locale} target={isKorean ? "상세사이즈" : "Size chart"}>
        <p>
          {isKorean
            ? "옵션 칩을 누르면 그 옵션의 상세사이즈와 이름을 편집합니다. 이름을 바꾸면 상세사이즈도 함께 옮겨집니다."
            : "Press an option chip to edit its size chart and name. A renamed option keeps its size chart."}
        </p>
        <p>
          {isKorean
            ? "모달의 저장 버튼을 누르면 바로 반영됩니다."
            : "Saving in the dialog applies it right away."}
        </p>
        {usesDeckSpec ? null : (
          <p>
            {isKorean
              ? "도면 종류를 바꾸면 기본값과 옵션별 상세사이즈가 모두 지워집니다."
              : "Switching the drawing deletes the default and every option's size chart."}
          </p>
        )}
      </AdminHelpButton>
    </span>
  );
  const isCurrentlyPublic = Boolean(
    currentProduct?.version && currentProduct.isVisible,
  );
  const saveLabel = !canSaveToServer
    ? isKorean
      ? "이 브라우저에 초안 보관"
      : "Keep draft in this browser"
    : draft.isVisible
      ? view === "edit" && isCurrentlyPublic
        ? isKorean
          ? "공개 상태로 수정 저장"
          : "Save changes as public"
        : isKorean
          ? "저장 후 스토어 공개"
          : "Save and publish to store"
      : view === "edit"
        ? isKorean
          ? "비공개 수정 저장"
          : "Save changes as private"
        : isKorean
          ? "비공개로 저장"
          : "Save as private";
  return {
    currentProduct,
    deckSpec,
    deckSpecsBySize,
    optionDeckSpecCount,
    savedSizes,
    deckSpecSessionRef,
    deckSpecModal,
    setDeckSpecModal,
    modalSize,
    editorKey,
    canEditDeckSpec,
    sizeChartKinds,
    sizeChart,
    sizeChartsBySize,
    sizeChartKind,
    optionSizeChartCount,
    canEditSizeChart,
    usesDeckSpec,
    canEditSizeInfo,
    describeSizeInfoError,
    modalNotice,
    modalOtherOptions,
    sizeInfoHelp,
    isCurrentlyPublic,
    saveLabel,
  } as const;
}
