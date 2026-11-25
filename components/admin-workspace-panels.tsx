// 역할: 현재 메뉴에 맞는 관리자 본문 패널을 고릅니다. 운영 홈에는 주문 재고·모의 주문 패널을 함께 두고, 매출 패널은 숨김 상태로 계속 마운트합니다.
"use client";
import adminSharedStyles from "./admin-shared.module.css";
import { navigateToAdminProductEditor } from "@/lib/admin-ui/navigation";
import { BrandSection } from "./admin-brand-section";
import { CouponSection } from "./admin-coupon-section";
import { InventorySection } from "./admin-inventory-section";
import { MarketingSection } from "./admin-marketing-section";
import { MembersSection } from "./admin-members-section";
import { AdminOrderInventoryPanel } from "./admin-order-inventory";
import { AdminOrderSimulationPanel } from "./admin-order-simulation";
import { OverviewSection } from "./admin-overview-section";
import { ProductSection } from "./admin-product-section";
import requiredStyles from "./admin-required.module.css";
import { AdminSalesLedgerPanel } from "./admin-sales-ledger";
import { AdminWorkspaceContext } from "./admin-workspace-context";
import { AdminWorkspaceOcrPanel } from "./admin-workspace-ocr-panel";

export function AdminWorkspacePanels({
  context,
}: Readonly<{ context: AdminWorkspaceContext }>) {
  const {
    activeSection,
    operationActivities,
    productEditors,
    actions,
    setIsOpsMenuOpen,
    selectSection,
    locale,
    localBrands,
    isDeletingProducts,
    productDraft,
    productEditor,
    isLoadingProducts,
    isSavingProduct,
    savingProductEditorId,
    productNotice,
    removePendingProductActivity,
    finishProductEditor,
    setProductNotice,
    handleDeleteProducts,
    openProductEditor,
    handleProductImageChange,
    openNewProductEditor,
    resetProductDraft,
    handleProductSave,
    saveProductDeckSpec,
    saveProductSizeChart,
    changeProductSizeChartKind,
    updateProductText,
    updateProductToggle,
    previewCompareAtPrice,
    previewName,
    previewPrice,
    previewSizes,
    localProducts,
    productView,
    catalogLoadFailed,
    inventoryNotice,
    handleInventoryStockChange,
    refreshInventoryProducts,
    inventorySavingIds,
    brandMemo,
    brandName,
    brandNotice,
    setBrandMemo,
    markActivityWorking,
    setBrandName,
    handleBrandSubmit,
    isSavingBrand,
    currentAdmin,
    membersLoaded,
    memberLoadFailed,
    isLoadingMembers,
    members,
    memberNotice,
    handleLoadMembers,
    memberNeedsRefresh,
    handleMemberGroupUpdate,
    memberRevision,
    isSavingMemberGroup,
    couponCode,
    couponExpiresAt,
    couponName,
    couponType,
    couponValue,
    couponNotice,
    setCouponCode,
    setCouponNotice,
    setCouponExpiresAt,
    setCouponName,
    handleCouponSubmit,
    setCouponType,
    setCouponValue,
    isSavingCoupon,
    campaignBody,
    campaignChannels,
    campaignNotice,
    setCampaignBody,
    setCampaignNotice,
    setCampaignChannels,
    handleCampaignSubmit,
    setCampaignTitle,
    isSavingCampaign,
    campaignTitle,
  } = context;
  return (
    <section
      aria-labelledby={`admin-tab-${activeSection}`}
      className={`${adminSharedStyles.workspace} ${requiredStyles.requiredScope}`}
      id={`admin-panel-${activeSection}`}
      role="tabpanel"
      tabIndex={-1}
    >
      {activeSection === "overview" ? (
        <>
          <OverviewSection
            activities={operationActivities}
            canResumeActivity={(activity) =>
              Boolean(activity.editorId && productEditors.has(activity.editorId))
            }
            loadOverviewMetrics={actions?.loadOverviewMetrics}
            onOpenActivity={(activity) => {
              if (activity.editorId && productEditors.has(activity.editorId)) {
                navigateToAdminProductEditor(activity.editorId);
                setIsOpsMenuOpen(false);
              } else selectSection(activity.section);
            }}
            onGoTo={selectSection}
            onOpenCreate={() => selectSection("products", { productView: "create" })}
          />
          <AdminOrderInventoryPanel />
          <AdminOrderSimulationPanel locale={locale} />
        </>
      ) : null}
      {activeSection === "products" ? (
        <ProductSection
          brands={localBrands}
          canSaveToServer={Boolean(actions?.saveProductDraft)}
          canUploadImages={Boolean(actions?.uploadProductImage)}
          deleting={isDeletingProducts}
          draft={productDraft}
          editorId={productEditor?.id ?? ""}
          loading={isLoadingProducts}
          lockInputs={isSavingProduct && savingProductEditorId === productEditor?.id}
          notice={productNotice}
          onCloseEditor={() => {
            if (productEditor) {
              removePendingProductActivity(productEditor.id);
              finishProductEditor(productEditor.id);
            }
            setProductNotice(null);
          }}
          onDeleteProducts={(items) => void handleDeleteProducts(items)}
          onEditProduct={(product) => openProductEditor(product, "edit")}
          onImageChange={handleProductImageChange}
          onOpenCreate={openNewProductEditor}
          onReset={resetProductDraft}
          onSave={(event) => void handleProductSave(event)}
          onSaveDeckSpec={
            actions?.updateProductDeckSpec ? saveProductDeckSpec : undefined
          }
          onSaveSizeChart={
            actions?.updateProductSizeChart &&
            actions.updateProductOptionSizeChart &&
            actions.updateProductSizeChartKind
              ? saveProductSizeChart
              : undefined
          }
          onChangeSizeChartKind={changeProductSizeChartKind}
          onTextChange={updateProductText}
          onToggleChange={updateProductToggle}
          previewCompareAtPrice={previewCompareAtPrice}
          previewName={previewName}
          previewPrice={previewPrice}
          previewSizes={previewSizes}
          products={localProducts}
          saving={isSavingProduct}
          view={productView}
        />
      ) : null}
      <div hidden={activeSection !== "sales"}>
        <AdminSalesLedgerPanel products={localProducts} locale={locale} />
      </div>
      {activeSection === "inventory" ? (
        <InventorySection
          canUpdateStock={Boolean(actions?.updateProductStock)}
          loadFailed={catalogLoadFailed}
          loading={isLoadingProducts}
          notice={inventoryNotice}
          onChangeStock={handleInventoryStockChange}
          onRefresh={refreshInventoryProducts}
          products={localProducts}
          savingIds={inventorySavingIds}
        />
      ) : null}
      {activeSection === "brands" ? (
        <BrandSection
          brandMemo={brandMemo}
          brandName={brandName}
          brands={localBrands}
          canSaveToServer={Boolean(actions?.saveBrandDraft)}
          loadFailed={catalogLoadFailed}
          loading={isLoadingProducts}
          notice={brandNotice}
          onMemoChange={(value) => {
            setBrandMemo(value);
            markActivityWorking("brands");
          }}
          onNameChange={(value) => {
            setBrandName(value);
            markActivityWorking("brands");
          }}
          onSubmit={(event) => void handleBrandSubmit(event)}
          products={localProducts}
          saving={isSavingBrand}
        />
      ) : null}
      {activeSection === "members" ? (
        <MembersSection
          canLoad={Boolean(actions?.listMembers)}
          canUpdate={Boolean(actions?.updateMemberGroup)}
          currentUserSub={currentAdmin?.sub}
          loaded={membersLoaded}
          loadFailed={memberLoadFailed}
          loading={isLoadingMembers}
          members={members}
          notice={memberNotice}
          onLoad={() => void handleLoadMembers()}
          needsRefresh={memberNeedsRefresh}
          onUpdateGroup={(username, group, add, expectedGroups) =>
            void handleMemberGroupUpdate(username, group, add, expectedGroups)
          }
          revision={memberRevision}
          saving={isSavingMemberGroup}
        />
      ) : null}
      {activeSection === "coupons" ? (
        <CouponSection
          canSaveToServer={Boolean(actions?.saveCouponDraft)}
          couponCode={couponCode}
          couponExpiresAt={couponExpiresAt}
          couponName={couponName}
          couponType={couponType}
          couponValue={couponValue}
          notice={couponNotice}
          onCodeChange={(value) => {
            setCouponCode(value);
            setCouponNotice(null);
            markActivityWorking("coupons");
          }}
          onExpiresAtChange={(value) => {
            setCouponExpiresAt(value);
            setCouponNotice(null);
            markActivityWorking("coupons");
          }}
          onNameChange={(value) => {
            setCouponName(value);
            setCouponNotice(null);
            markActivityWorking("coupons");
          }}
          onSubmit={(event) => void handleCouponSubmit(event)}
          onTypeChange={(value) => {
            setCouponType(value);
            setCouponNotice(null);
            markActivityWorking("coupons");
          }}
          onValueChange={(value) => {
            setCouponValue(value);
            setCouponNotice(null);
            markActivityWorking("coupons");
          }}
          saving={isSavingCoupon}
        />
      ) : null}
      {activeSection === "marketing" ? (
        <MarketingSection
          body={campaignBody}
          canSaveToServer={Boolean(actions?.saveCampaignDraft)}
          channels={campaignChannels}
          notice={campaignNotice}
          onBodyChange={(value) => {
            setCampaignBody(value);
            setCampaignNotice(null);
            markActivityWorking("marketing");
          }}
          onChannelChange={(channel, selected) => {
            setCampaignChannels((current) => ({ ...current, [channel]: selected }));
            setCampaignNotice(null);
            markActivityWorking("marketing");
          }}
          onSubmit={(event) => void handleCampaignSubmit(event)}
          onTitleChange={(value) => {
            setCampaignTitle(value);
            setCampaignNotice(null);
            markActivityWorking("marketing");
          }}
          saving={isSavingCampaign}
          title={campaignTitle}
        />
      ) : null}
      <AdminWorkspaceOcrPanel context={context} />
    </section>
  );
}
