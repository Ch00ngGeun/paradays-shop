"use client";
import adminProductSectionStyles from "./admin-product-section.module.css";
import adminSharedStyles from "./admin-shared.module.css";
import { useLocale } from "@/contexts/locale-context";
import { adminGuideSteps } from "@/lib/admin-ui/admin-guides";
import type { AdminCatalogListItem, AdminProductDraft } from "@/lib/admin-ui/types";
import { type SizeChartKind, type SizeChartValues } from "@/lib/size-chart";
import type { DeckSpec } from "@/types/store";
import { type ChangeEvent, type FormEvent } from "react";
import styles from "./admin-dashboard.module.css";
import { AdminGuideButton } from "./admin-guide";
import { AdminProductEditorForm } from "./admin-product-editor-form";
import { AdminProductList } from "./admin-product-list";
import { AdminProductPreview } from "./admin-product-preview";
import { Notice } from "./admin-shared";
import { AdminStepper, type AdminStep } from "./admin-stepper";
import { useAdminProductName } from "./admin-use-product-name";
import { useAdminProductSelection } from "./admin-use-product-selection";
import { useAdminProductSizeModal } from "./admin-use-product-size-modal";

export function ProductSection({
  brands,
  canSaveToServer,
  canUploadImages,
  deleting,
  draft,
  editorId,
  loading,
  lockInputs,
  notice,
  onCloseEditor,
  onDeleteProducts,
  onEditProduct,
  onImageChange,
  onOpenCreate,
  onReset,
  onSave,
  onSaveDeckSpec,
  onSaveSizeChart,
  onChangeSizeChartKind,
  onTextChange,
  onToggleChange,
  previewCompareAtPrice,
  previewName,
  previewPrice,
  previewSizes,
  products,
  saving,
  view,
}: Readonly<{
  brands: readonly string[];
  canSaveToServer: boolean;
  canUploadImages: boolean;
  deleting: boolean;
  draft: AdminProductDraft;
  editorId: string;
  loading: boolean;
  lockInputs: boolean;
  notice: Notice;
  onCloseEditor: () => void;
  onDeleteProducts: (
    items: ReadonlyArray<Readonly<{ id: string; version: number }>>,
  ) => void;
  onEditProduct: (product: AdminCatalogListItem) => void;
  onImageChange: (event: ChangeEvent<HTMLInputElement>) => void;
  onOpenCreate: () => void;
  onReset: () => void;
  onSave: (event: FormEvent<HTMLFormElement>) => void;
  onSaveDeckSpec?: (
    deckSpec: DeckSpec | null,
    size?: string,
    sizeName?: string,
  ) => Promise<void>;
  /** 의류·휠 상세사이즈 저장. 없으면 그 카테고리는 상세사이즈를 편집하지 않습니다. */
  onSaveSizeChart?: (
    kind: SizeChartKind,
    values: SizeChartValues | null,
    size?: string,
    sizeName?: string,
  ) => Promise<void>;
  onChangeSizeChartKind: (kind: SizeChartKind) => Promise<void>;
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
  onToggleChange: (field: "isVisible" | "isFeatured", value: boolean) => void;
  previewCompareAtPrice: number;
  previewName: string;
  previewPrice: number;
  previewSizes: readonly string[];
  products: readonly AdminCatalogListItem[];
  saving: boolean;
  view: "list" | "create" | "edit";
}>) {
  const { locale } = useLocale();
  const isKorean = locale === "ko";
  const { nameLineNotice, setNameLineNotice, attachNameInput, applyProductName } =
    useAdminProductName({ draft, onTextChange });
  const previewDescriptionLines = draft.description
    .split(/\n/)
    .map((line) => line.trim())
    .filter(Boolean);
  const {
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
  } = useAdminProductSizeModal({
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
  });
  const {
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
  } = useAdminProductSelection({ products, brands, draft });

  const productSaved = view !== "list" && notice?.kind === "success" && !saving;
  const productSteps: AdminStep[] = [
    {
      label: isKorean ? "상품 선택" : "Select product",
      state: view === "list" ? "current" : "complete",
    },
    {
      label: isKorean ? "정보 입력" : "Enter details",
      state:
        view === "list" ? "upcoming" : saving || productSaved ? "complete" : "current",
    },
    {
      label: canSaveToServer
        ? isKorean
          ? "서버 저장·공개"
          : "Save to server & publish"
        : isKorean
          ? "서버 저장"
          : "Save to server",
      state: !canSaveToServer
        ? "unavailable"
        : productSaved
          ? "complete"
          : saving
            ? "current"
            : "upcoming",
    },
  ];
  const productStepper = (
    <AdminStepper
      className={styles.screenStepper}
      label={isKorean ? "상품 작업 흐름" : "Product workflow"}
      locale={locale}
      steps={productSteps}
    />
  );

  if (view === "list") {
    return (
      <AdminProductList
        productStepper={productStepper}
        isKorean={isKorean}
        locale={locale}
        onOpenCreate={onOpenCreate}
        notice={notice}
        setFilterQuery={setFilterQuery}
        filterQuery={filterQuery}
        setStatusFilter={setStatusFilter}
        statusFilter={statusFilter}
        setStockFilter={setStockFilter}
        stockFilter={stockFilter}
        allFilteredSelected={allFilteredSelected}
        toggleSelectAllFiltered={toggleSelectAllFiltered}
        deleting={deleting}
        selectedProducts={selectedProducts}
        onDeleteProducts={onDeleteProducts}
        loading={loading}
        filteredProducts={filteredProducts}
        products={products}
        selectedIds={selectedIds}
        applySelection={applySelection}
        handleSelectPointerDown={handleSelectPointerDown}
        handleSelectPointerEnter={handleSelectPointerEnter}
        onEditProduct={onEditProduct}
      />
    );
  }

  const editorTitle =
    view === "edit"
      ? isKorean
        ? "상품 수정"
        : "Edit product"
      : isKorean
        ? "새 상품"
        : "New product";

  return (
    <div className={`${styles.sectionStack} ${styles.productScreen}`}>
      {productStepper}
      <div className={adminProductSectionStyles.productEditorToolbar}>
        <button
          className={styles.backToListButton}
          onClick={onCloseEditor}
          type="button"
        >
          {isKorean ? "← 목록으로" : "← Back to list"}
        </button>
        <span className={adminSharedStyles.pushEnd}>
          <AdminGuideButton
            locale={locale}
            steps={adminGuideSteps("products", locale)}
          />
        </span>
      </div>
      <div
        className={`${adminProductSectionStyles.productPageHeading} ${adminProductSectionStyles.productCompactHeading}`}
      >
        <div>
          <div className={adminProductSectionStyles.productEditorTitle}>
            <h2>{editorTitle}</h2>
            <span className={adminProductSectionStyles.productSaveState}>
              {canSaveToServer
                ? draft.isVisible
                  ? isKorean
                    ? "공개 설정 · 저장 전"
                    : "Public · Not saved"
                  : isKorean
                    ? "비공개 · 저장 전"
                    : "Private · Not saved"
                : isKorean
                  ? "로컬 초안 · 서버 미연결"
                  : "Local draft · No server"}
            </span>
          </div>
          {view === "edit" && currentProduct?.version ? (
            <p>
              {isKorean ? "현재" : "Now"}{" "}
              {isCurrentlyPublic
                ? isKorean
                  ? "공개"
                  : "Public"
                : isKorean
                  ? "비공개"
                  : "Private"}{" "}
              → {isKorean ? "저장 후" : "after saving"}{" "}
              {draft.isVisible
                ? isKorean
                  ? "공개"
                  : "Public"
                : isKorean
                  ? "비공개"
                  : "Private"}
            </p>
          ) : null}
        </div>
        <label className={adminProductSectionStyles.productManagementCode}>
          <span>{isKorean ? "SKU / 관리 코드" : "SKU / code"}</span>
          <input
            readOnly
            value={draft.sku}
            placeholder={isKorean ? "기존 관리 코드 없음" : "No existing code"}
          />
        </label>
      </div>
      <div className={styles.productEditor}>
        <AdminProductEditorForm
          onSave={onSave}
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
          view={view}
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
          onImageChange={onImageChange}
          canUploadImages={canUploadImages}
          canSaveToServer={canSaveToServer}
          onToggleChange={onToggleChange}
          notice={notice}
          setOptionResetKey={setOptionResetKey}
          onReset={onReset}
          saving={saving}
          saveLabel={saveLabel}
        />

        <AdminProductPreview
          isKorean={isKorean}
          canSaveToServer={canSaveToServer}
          locale={locale}
          view={view}
          draft={draft}
          previewName={previewName}
          previewPrice={previewPrice}
          previewCompareAtPrice={previewCompareAtPrice}
          previewSizes={previewSizes}
          previewDescriptionLines={previewDescriptionLines}
        />
      </div>
    </div>
  );
}
