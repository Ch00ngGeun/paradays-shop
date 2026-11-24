"use client";
import type { AdminProductDraft } from "@/lib/admin-ui/types";
import {
  formatSizeChartValue,
  SIZE_CHART_KIND_INFO,
  type SizeChartKind,
  type SizeChartValues,
} from "@/lib/size-chart";
import type { DeckSpec, Locale } from "@/types/store";
import { type RefObject } from "react";
import styles from "./admin-dashboard.module.css";
import { AdminDeckSpecModal } from "./admin-deck-spec-modal";
import { ProductOptionControls } from "./admin-product-option-controls";
import { moneyFormatter } from "./admin-shared";
import { AdminSizeChartModal } from "./admin-size-chart-modal";
import { formatDeckInches } from "./deck-size-diagram";

export function AdminProductPricingFields({
  lockInputs,
  isKorean,
  onTextChange,
  draft,
  view,
  editorId,
  optionResetKey,
  usesDeckSpec,
  deckSpecsBySize,
  sizeChartsBySize,
  onSaveDeckSpec,
  sizeChartKinds,
  onSaveSizeChart,
  canEditSizeInfo,
  savedSizes,
  setDeckSpecModal,
  deckSpecSessionRef,
  optionDeckSpecCount,
  deckSpec,
  sizeInfoHelp,
  canEditDeckSpec,
  deckSpecModal,
  editorKey,
  modalSize,
  locale,
  describeSizeInfoError,
  modalNotice,
  modalOtherOptions,
  previewName,
  sizeChartKind,
  optionSizeChartCount,
  sizeChart,
  canEditSizeChart,
  currentProduct,
  onChangeSizeChartKind,
  previewCompareAtPrice,
}: Readonly<{
  lockInputs: boolean;
  isKorean: boolean;
  onTextChange: (
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
  ) => void;
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
  optionResetKey: number;
  usesDeckSpec: boolean;
  deckSpecsBySize: Readonly<Record<string, DeckSpec>> | undefined;
  sizeChartsBySize: Readonly<Record<string, SizeChartValues>> | undefined;
  onSaveDeckSpec:
    | ((deckSpec: DeckSpec | null, size?: string, sizeName?: string) => Promise<void>)
    | undefined;
  sizeChartKinds: readonly (
    | "shortSleeve"
    | "raglanLongSleeve"
    | "longPants"
    | "shorts"
    | "wheel"
  )[];
  onSaveSizeChart:
    | ((
        kind: SizeChartKind,
        values: SizeChartValues | null,
        size?: string,
        sizeName?: string,
      ) => Promise<void>)
    | undefined;
  canEditSizeInfo: boolean;
  savedSizes: string[];
  setDeckSpecModal: React.Dispatch<
    React.SetStateAction<{ editorKey: string; session: number; size?: string } | null>
  >;
  deckSpecSessionRef: RefObject<number>;
  optionDeckSpecCount: number;
  deckSpec: DeckSpec | undefined;
  sizeInfoHelp: import("@/node_modules/@types/react/jsx-runtime").JSX.Element;
  canEditDeckSpec: boolean;
  deckSpecModal: { editorKey: string; session: number; size?: string } | null;
  editorKey: string;
  modalSize: string | undefined;
  locale: Locale;
  describeSizeInfoError: (
    error: unknown,
  ) =>
    | "결제 대기 중인 주문이 있어 지금은 옵션 이름을 바꿀 수 없습니다. 주문이 결제되거나 취소된 뒤 다시 시도하거나, 이름은 그대로 두고 상세사이즈만 저장해 주세요."
    | "An order awaiting payment holds this product, so the option name cannot change now. Try again after the order is paid or canceled, or keep the name and save only the size chart."
    | "같은 이름·브랜드의 다른 상품에 이 옵션이 있어 이 이름으로 바꿀 수 없습니다."
    | "Another product with the same name and brand already has this option, so this name cannot be used."
    | undefined;
  modalNotice:
    | "같은 이름의 옵션이 여러 개 저장돼 있어 이름은 바꿀 수 없고 상세사이즈만 편집합니다. 중복 칩을 지우고 상품을 저장하면 이름도 바꿀 수 있습니다."
    | "Several saved options share this name, so only the size chart can be edited. Remove the duplicate chip and save the product to rename it."
    | undefined;
  modalOtherOptions: string[] | undefined;
  previewName: string;
  sizeChartKind:
    | "shortSleeve"
    | "raglanLongSleeve"
    | "longPants"
    | "shorts"
    | "wheel"
    | null;
  optionSizeChartCount: number;
  sizeChart: Readonly<{ kind: SizeChartKind; values: SizeChartValues }> | undefined;
  canEditSizeChart: boolean;
  currentProduct:
    | Readonly<{
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
      }>
    | undefined;
  onChangeSizeChartKind: (kind: SizeChartKind) => Promise<void>;
  previewCompareAtPrice: number;
}>) {
  return (
    <fieldset
      className={`${styles.formGroup} ${styles.productFormGrid}`}
      disabled={lockInputs}
    >
      <legend>{isKorean ? "판매 정보" : "Pricing"}</legend>
      <label>
        <span>
          {isKorean ? "판매가" : "Price"} <em>*</em>
        </span>
        <input
          inputMode="numeric"
          min="0"
          onChange={(event) => onTextChange("price", event.target.value)}
          placeholder="108000"
          required
          type="number"
          value={draft.price}
        />
      </label>
      <label>
        <span>
          {view === "edit"
            ? isKorean
              ? "재고 수량"
              : "Stock"
            : isKorean
              ? "최초 재고"
              : "Initial stock"}
        </span>
        <input
          inputMode="numeric"
          min="0"
          onChange={(event) => onTextChange("stock", event.target.value)}
          placeholder="0"
          type="number"
          value={draft.stock}
        />
      </label>
      <ProductOptionControls
        category={draft.category}
        editorId={editorId}
        key={`${editorId}:${draft.category}:${optionResetKey}`}
        chartOptions={Object.keys(
          (usesDeckSpec ? deckSpecsBySize : sizeChartsBySize) ?? {},
        )}
        onChange={(value) => onTextChange("sizes", value)}
        onOpenOption={
          (usesDeckSpec ? onSaveDeckSpec : sizeChartKinds.length && onSaveSizeChart)
            ? (option) => {
                if (!canEditSizeInfo || !savedSizes.includes(option)) return false;
                setDeckSpecModal({
                  editorKey,
                  session: ++deckSpecSessionRef.current,
                  size: option,
                });
                return true;
              }
            : undefined
        }
        value={draft.sizes}
      />
      {draft.category === "Deck" ? (
        <div className={styles.productLegacyPrice}>
          <span>
            {isKorean ? "상세사이즈" : "Size chart"}
            <strong>
              {optionDeckSpecCount ? (isKorean ? "기본 " : "Default ") : ""}
              {deckSpec
                ? `${formatDeckInches(deckSpec.width)} × ${formatDeckInches(deckSpec.length)} · WB ${formatDeckInches(deckSpec.wheelbase)}`
                : isKorean
                  ? "미등록"
                  : optionDeckSpecCount
                    ? "not set"
                    : "Not set"}
              {optionDeckSpecCount
                ? isKorean
                  ? ` · 옵션별 ${optionDeckSpecCount}개`
                  : ` · ${optionDeckSpecCount} per option`
                : ""}
            </strong>
          </span>
          {onSaveDeckSpec ? sizeInfoHelp : null}
          <button
            className={styles.secondaryButton}
            disabled={!canEditDeckSpec}
            onClick={() =>
              setDeckSpecModal({
                editorKey,
                session: ++deckSpecSessionRef.current,
              })
            }
            type="button"
          >
            {deckSpec || optionDeckSpecCount
              ? isKorean
                ? "상세사이즈 수정"
                : "Edit size chart"
              : isKorean
                ? "+ 상세사이즈 등록"
                : "+ Add size chart"}
          </button>
          {onSaveDeckSpec && deckSpecModal?.editorKey === editorKey ? (
            <AdminDeckSpecModal
              initialSpec={
                modalSize === undefined
                  ? deckSpec
                  : deckSpecsBySize && Object.hasOwn(deckSpecsBySize, modalSize)
                    ? deckSpecsBySize[modalSize]
                    : undefined
              }
              isOpen
              key={deckSpecModal.session}
              locale={locale}
              onCancel={() => setDeckSpecModal(null)}
              onSave={async (next, size, sizeName) => {
                const { session } = deckSpecModal;
                await onSaveDeckSpec(next, size, sizeName);
                setDeckSpecModal((current) =>
                  current?.session === session ? null : current,
                );
              }}
              describeError={describeSizeInfoError}
              notice={modalNotice}
              otherOptions={modalOtherOptions}
              productName={previewName}
              size={modalSize}
            />
          ) : null}

          {optionDeckSpecCount ? (
            <small>
              {isKorean
                ? "옵션 칩을 지우고 상품을 저장하면 그 옵션의 상세사이즈도 지워집니다."
                : "Removing an option chip and saving the product deletes that option's size chart."}
            </small>
          ) : null}
          {canEditDeckSpec ? null : (
            <small>
              {onSaveDeckSpec
                ? isKorean
                  ? "상품을 먼저 저장하면 등록할 수 있습니다."
                  : "Save the product first to add it."
                : isKorean
                  ? "서버에 연결된 관리자 화면에서만 등록할 수 있습니다."
                  : "Available only on an admin screen connected to the server."}
            </small>
          )}
        </div>
      ) : null}
      {!usesDeckSpec && sizeChartKind ? (
        <div className={styles.productLegacyPrice}>
          <span>
            {isKorean ? "상세사이즈" : "Size chart"}
            <strong>
              {SIZE_CHART_KIND_INFO[sizeChartKind].label[locale]} ·{" "}
              {optionSizeChartCount ? (isKorean ? "기본 " : "Default ") : ""}
              {sizeChart
                ? (() => {
                    // The first measurement stands for the default, like a deck's width.
                    const [first] = SIZE_CHART_KIND_INFO[sizeChart.kind].fields;
                    return `${first.label[locale]} ${formatSizeChartValue(sizeChart.kind, sizeChart.values[first.key])}`;
                  })()
                : isKorean
                  ? "미등록"
                  : optionSizeChartCount
                    ? "not set"
                    : "Not set"}
              {optionSizeChartCount
                ? isKorean
                  ? ` · 옵션별 ${optionSizeChartCount}개`
                  : ` · ${optionSizeChartCount} per option`
                : ""}
            </strong>
          </span>
          {onSaveSizeChart ? sizeInfoHelp : null}
          <button
            className={styles.secondaryButton}
            disabled={!canEditSizeChart}
            onClick={() =>
              setDeckSpecModal({
                editorKey,
                session: ++deckSpecSessionRef.current,
              })
            }
            type="button"
          >
            {sizeChart || optionSizeChartCount
              ? isKorean
                ? "상세사이즈 수정"
                : "Edit size chart"
              : isKorean
                ? "+ 상세사이즈 등록"
                : "+ Add size chart"}
          </button>
          {onSaveSizeChart &&
          currentProduct &&
          deckSpecModal?.editorKey === editorKey ? (
            <AdminSizeChartModal
              category={currentProduct.category}
              describeError={describeSizeInfoError}
              initialValues={
                modalSize === undefined
                  ? sizeChart?.values
                  : sizeChartsBySize && Object.hasOwn(sizeChartsBySize, modalSize)
                    ? sizeChartsBySize[modalSize]
                    : undefined
              }
              isOpen
              key={deckSpecModal.session}
              kind={sizeChartKind}
              locale={locale}
              notice={modalNotice}
              onCancel={() => setDeckSpecModal(null)}
              onChangeKind={onChangeSizeChartKind}
              onSave={async (next, size, sizeName) => {
                const { session } = deckSpecModal;
                await onSaveSizeChart(sizeChartKind, next, size, sizeName);
                setDeckSpecModal((current) =>
                  current?.session === session ? null : current,
                );
              }}
              otherOptions={modalOtherOptions}
              productName={previewName}
              size={modalSize}
            />
          ) : null}
          {optionSizeChartCount ? (
            <small>
              {isKorean
                ? "옵션 칩을 지우고 상품을 저장하면 그 옵션의 상세사이즈도 지워집니다."
                : "Removing an option chip and saving the product deletes that option's size chart."}
            </small>
          ) : null}
          {canEditSizeChart ? null : (
            <small>
              {!onSaveSizeChart
                ? isKorean
                  ? "서버에 연결된 관리자 화면에서만 등록할 수 있습니다."
                  : "Available only on an admin screen connected to the server."
                : currentProduct && currentProduct.category !== draft.category
                  ? isKorean
                    ? "카테고리를 바꿨다면 상품을 먼저 저장해야 상세사이즈를 등록할 수 있습니다."
                    : "After changing the category, save the product before adding a size chart."
                  : isKorean
                    ? "상품을 먼저 저장하면 등록할 수 있습니다."
                    : "Save the product first to add it."}
            </small>
          )}
        </div>
      ) : null}
      {view === "edit" && draft.compareAtPrice ? (
        <div className={styles.productLegacyPrice}>
          <span>
            {isKorean ? "기존 정가" : "Original price"}{" "}
            <strong>{moneyFormatter.format(previewCompareAtPrice)}</strong>
          </span>
          <button
            className={styles.secondaryButton}
            onClick={() => {
              if (
                window.confirm(
                  isKorean
                    ? "기존 정가를 제거할까요? 저장하면 할인 전 가격 표시가 사라집니다."
                    : "Remove the original price? Once saved, the pre-discount price is no longer shown.",
                )
              )
                onTextChange("compareAtPrice", "");
            }}
            type="button"
          >
            {isKorean ? "기존 정가 제거" : "Remove original price"}
          </button>
          <small>
            {isKorean
              ? "기존 값 유지 중 · 제거는 저장 후 반영"
              : "Keeping the current value · Removal applies after saving"}
          </small>
        </div>
      ) : view === "edit" && currentProduct?.compareAtPrice ? (
        <p className={styles.productLegacyPrice} role="status">
          {isKorean
            ? "기존 정가 제거 예정 · 저장 전"
            : "Original price will be removed · Not saved"}
        </p>
      ) : null}
    </fieldset>
  );
}
