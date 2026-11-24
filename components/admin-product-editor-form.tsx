"use client";
import adminProductSectionStyles from "./admin-product-section.module.css";
import adminSharedStyles from "./admin-shared.module.css";
import type { AdminProductDraft } from "@/lib/admin-ui/types";
import { type SizeChartKind, type SizeChartValues } from "@/lib/size-chart";
import type { DeckSpec, Locale } from "@/types/store";
import { type ChangeEvent, type FormEvent, type RefObject } from "react";
import styles from "./admin-dashboard.module.css";
import { AdminHelpButton } from "./admin-help-button";
import { AdminProductBasicFields } from "./admin-product-basic-fields";
import { AdminProductImage } from "./admin-product-image";
import { AdminProductPricingFields } from "./admin-product-pricing-fields";
import { Notice, NoticeMessage } from "./admin-shared";

export function AdminProductEditorForm({
  onSave,
  lockInputs,
  isKorean,
  onTextChange,
  applyProductName,
  setNameLineNotice,
  attachNameInput,
  draft,
  nameLineNotice,
  editorId,
  brandInputRef,
  setManualBrandEditor,
  brandChoices,
  manualBrandEditor,
  selectedBrandIndex,
  view,
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
  onImageChange,
  canUploadImages,
  canSaveToServer,
  onToggleChange,
  notice,
  setOptionResetKey,
  onReset,
  saving,
  saveLabel,
}: Readonly<{
  onSave: (event: FormEvent<HTMLFormElement>) => void;
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
  applyProductName: (input: HTMLTextAreaElement) => void;
  setNameLineNotice: React.Dispatch<React.SetStateAction<"blocked" | "merged" | null>>;
  attachNameInput: (input: HTMLTextAreaElement | null) => void;
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
  nameLineNotice: "blocked" | "merged" | null;
  editorId: string;
  brandInputRef: RefObject<HTMLTextAreaElement | null>;
  setManualBrandEditor: React.Dispatch<React.SetStateAction<string | null>>;
  brandChoices: readonly string[];
  manualBrandEditor: string | null;
  selectedBrandIndex: number;
  view: "create" | "edit" | "list";
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
  onImageChange: (event: ChangeEvent<HTMLInputElement>) => void;
  canUploadImages: boolean;
  canSaveToServer: boolean;
  onToggleChange: (field: "isVisible" | "isFeatured", value: boolean) => void;
  notice: Notice;
  setOptionResetKey: React.Dispatch<React.SetStateAction<number>>;
  onReset: () => void;
  saving: boolean;
  saveLabel:
    | "이 브라우저에 초안 보관"
    | "Keep draft in this browser"
    | "공개 상태로 수정 저장"
    | "Save changes as public"
    | "저장 후 스토어 공개"
    | "Save and publish to store"
    | "비공개 수정 저장"
    | "Save changes as private"
    | "비공개로 저장"
    | "Save as private";
}>) {
  return (
    <form
      className={styles.editorForm}
      noValidate
      onSubmit={onSave}
      aria-busy={lockInputs}
    >
      <AdminProductBasicFields
        lockInputs={lockInputs}
        isKorean={isKorean}
        onTextChange={onTextChange}
        applyProductName={applyProductName}
        setNameLineNotice={setNameLineNotice}
        attachNameInput={attachNameInput}
        draft={draft}
        nameLineNotice={nameLineNotice}
        editorId={editorId}
        brandInputRef={brandInputRef}
        setManualBrandEditor={setManualBrandEditor}
        brandChoices={brandChoices}
        manualBrandEditor={manualBrandEditor}
        selectedBrandIndex={selectedBrandIndex}
      />

      <AdminProductPricingFields
        lockInputs={lockInputs}
        isKorean={isKorean}
        onTextChange={onTextChange}
        draft={draft}
        view={view}
        editorId={editorId}
        optionResetKey={optionResetKey}
        usesDeckSpec={usesDeckSpec}
        deckSpecsBySize={deckSpecsBySize}
        sizeChartsBySize={sizeChartsBySize}
        onSaveDeckSpec={onSaveDeckSpec}
        sizeChartKinds={sizeChartKinds}
        onSaveSizeChart={onSaveSizeChart}
        canEditSizeInfo={canEditSizeInfo}
        savedSizes={savedSizes}
        setDeckSpecModal={setDeckSpecModal}
        deckSpecSessionRef={deckSpecSessionRef}
        optionDeckSpecCount={optionDeckSpecCount}
        deckSpec={deckSpec}
        sizeInfoHelp={sizeInfoHelp}
        canEditDeckSpec={canEditDeckSpec}
        deckSpecModal={deckSpecModal}
        editorKey={editorKey}
        modalSize={modalSize}
        locale={locale}
        describeSizeInfoError={describeSizeInfoError}
        modalNotice={modalNotice}
        modalOtherOptions={modalOtherOptions}
        previewName={previewName}
        sizeChartKind={sizeChartKind}
        optionSizeChartCount={optionSizeChartCount}
        sizeChart={sizeChart}
        canEditSizeChart={canEditSizeChart}
        currentProduct={currentProduct}
        onChangeSizeChartKind={onChangeSizeChartKind}
        previewCompareAtPrice={previewCompareAtPrice}
      />

      <fieldset
        className={`${styles.formGroup} ${styles.productImageGroup}`}
        disabled={lockInputs}
      >
        <legend>{isKorean ? "대표 이미지" : "Main image"}</legend>
        <div className={styles.productImageUpload}>
          {/* 선택한 파일의 blob URL은 기존 편집 세션이 해제합니다. 추가 URL을 만들지 않습니다. */}
          <AdminProductImage
            alt={isKorean ? "선택한 대표 이미지" : "Selected main image"}
            className={styles.productImageThumb}
            compact
            src={draft.imageUrl}
          />
          <div className={styles.productImageField}>
            <label className={styles.uploadField}>
              <span>{isKorean ? "대표 이미지" : "Main image"}</span>
              <input
                accept="image/jpeg,image/png,image/webp,image/gif"
                onChange={onImageChange}
                type="file"
              />
              {canUploadImages ? null : (
                <small>
                  {isKorean ? "업로드 연결 필요" : "Upload needs a connection"}
                </small>
              )}
            </label>
            <span className={styles.fieldHelpCorner}>
              <AdminHelpButton
                locale={locale}
                target={isKorean ? "대표 이미지" : "Main image"}
              >
                <p>
                  {isKorean
                    ? "JPEG·PNG·WebP·GIF · 최대 6MB"
                    : "JPEG·PNG·WebP·GIF · Up to 6MB"}
                </p>
                {canUploadImages ? (
                  <p>
                    {isKorean
                      ? "고른 이미지는 상품을 저장할 때 업로드됩니다."
                      : "The chosen image uploads when the product is saved."}
                  </p>
                ) : null}
              </AdminHelpButton>
            </span>
          </div>
        </div>
      </fieldset>
      <fieldset className={styles.formGroup} disabled={lockInputs}>
        <legend>{isKorean ? "상품 설명" : "Description"}</legend>
        <label className={styles.fieldWide}>
          <span>{isKorean ? "상품 설명" : "Description"}</span>
          <textarea
            onChange={(event) => onTextChange("description", event.target.value)}
            placeholder={
              isKorean
                ? "소재·특징·관리 방법 등을 입력하세요.\n줄바꿈으로 항목을 구분합니다."
                : "Enter materials, features, care and so on.\nSeparate items with line breaks."
            }
            rows={4}
            value={draft.description}
          />
        </label>
      </fieldset>
      <fieldset className={styles.formGroup} disabled={lockInputs}>
        <legend>{isKorean ? "공개 설정" : "Visibility"}</legend>
        <div className={styles.toggleRows}>
          <label className={styles.checkRow}>
            <input
              checked={draft.isVisible}
              disabled={!canSaveToServer}
              onChange={(event) => onToggleChange("isVisible", event.target.checked)}
              type="checkbox"
            />
            <span>
              {isKorean ? "저장 후 스토어에 공개" : "Publish to store after saving"}
            </span>
          </label>
          <label className={styles.checkRow}>
            <input
              checked={draft.isFeatured}
              onChange={(event) => onToggleChange("isFeatured", event.target.checked)}
              type="checkbox"
            />
            <span>{isKorean ? "신상품 배지 표시" : "Show New badge"}</span>
          </label>
        </div>
        {!canSaveToServer ? (
          <small>
            {isKorean
              ? "관리자 API 연결 후 공개할 수 있습니다."
              : "You can publish once the admin API is connected."}
          </small>
        ) : null}
      </fieldset>

      {notice ? <NoticeMessage notice={notice} /> : null}
      {!canSaveToServer ? (
        <p className={adminProductSectionStyles.productStorageNote} role="status">
          {isKorean
            ? "서버 미연결 · 이 브라우저에만 보관되며 새로고침하면 사라집니다. 스토어에는 공개되지 않습니다."
            : "No server connection · Kept only in this browser and lost on refresh. Not published to the store."}
        </p>
      ) : null}
      <div className={styles.formActions}>
        {canSaveToServer ? (
          <span className={adminSharedStyles.fieldHelp}>
            <AdminHelpButton
              locale={locale}
              target={isKorean ? "상품 저장" : "Saving the product"}
            >
              <p>
                {draft.isVisible
                  ? isKorean
                    ? "저장 직전에 공개 내용을 한 번 더 확인합니다."
                    : "You will confirm the public content once more before saving."
                  : isKorean
                    ? "비공개 상품은 고객에게 표시되지 않습니다."
                    : "Private products are not shown to customers."}
              </p>
            </AdminHelpButton>
          </span>
        ) : null}
        <button
          className={styles.secondaryButton}
          disabled={lockInputs}
          onClick={() => {
            setOptionResetKey((current) => current + 1);
            setManualBrandEditor(null);
            onReset();
          }}
          type="button"
        >
          {view === "edit"
            ? isKorean
              ? "입력 초기화"
              : "Reset input"
            : isKorean
              ? "새 초안"
              : "New draft"}
        </button>
        <button
          className={styles.primaryButton}
          data-admin-guide="products.save"
          disabled={saving}
          type="submit"
        >
          {saving
            ? lockInputs
              ? isKorean
                ? "저장 중…"
                : "Saving…"
              : isKorean
                ? "다른 상품 저장 중…"
                : "Saving another product…"
            : saveLabel}
        </button>
      </div>
      {canSaveToServer ? null : (
        <p className={adminProductSectionStyles.productSaveHint}>
          {isKorean
            ? "서버 저장·공개는 관리자 API 연결 후 가능합니다."
            : "Saving to the server and publishing need the admin API connection."}
        </p>
      )}
    </form>
  );
}
