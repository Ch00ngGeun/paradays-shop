"use client";
import adminProductSectionStyles from "./admin-product-section.module.css";
import adminSharedStyles from "./admin-shared.module.css";
import type { Locale } from "@/types/store";
import styles from "./admin-dashboard.module.css";
import { AdminHelpButton } from "./admin-help-button";
import { AdminProductImage } from "./admin-product-image";
import { moneyFormatter } from "./admin-shared";

export function AdminProductPreview({
  isKorean,
  canSaveToServer,
  locale,
  view,
  draft,
  previewName,
  previewPrice,
  previewCompareAtPrice,
  previewSizes,
  previewDescriptionLines,
}: Readonly<{
  isKorean: boolean;
  canSaveToServer: boolean;
  locale: Locale;
  view: "create" | "edit" | "list";
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
  previewName: string;
  previewPrice: number;
  previewCompareAtPrice: number;
  previewSizes: readonly string[];
  previewDescriptionLines: string[];
}>) {
  return (
    <aside
      className={`${styles.previewPanel} ${styles.productPreview}`}
      aria-label={isKorean ? "고객 화면 미리보기" : "Customer preview"}
      data-admin-guide="products.preview"
    >
      <div className={styles.previewHeader}>
        <div className={adminProductSectionStyles.productPreviewTitle}>
          <h2>{isKorean ? "고객 화면 미리보기" : "Customer preview"}</h2>
          {canSaveToServer ? (
            <span className={adminSharedStyles.fieldHelp}>
              <AdminHelpButton
                locale={locale}
                target={isKorean ? "고객 화면 미리보기" : "Customer preview"}
              >
                <p>
                  {view === "edit"
                    ? isKorean
                      ? "입력한 변경 내용은 저장 후 반영됩니다."
                      : "Your changes apply after saving."
                    : isKorean
                      ? "아직 고객에게 보이지 않습니다."
                      : "Not visible to customers yet."}
                </p>
              </AdminHelpButton>
            </span>
          ) : null}
        </div>
        <span className={adminProductSectionStyles.productSaveState}>
          {canSaveToServer
            ? draft.isVisible
              ? isKorean
                ? "공개 예정"
                : "Will be public"
              : isKorean
                ? "비공개"
                : "Private"
            : isKorean
              ? "로컬 미리보기"
              : "Local preview"}
        </span>
      </div>
      <article className={adminSharedStyles.storeCardPreview}>
        <div className={styles.storeCardDetail}>
          <div className={styles.storeCardInfo}>
            <p className={adminProductSectionStyles.productPreviewBrand}>
              {draft.brand.trim() || (isKorean ? "브랜드" : "Brand")}
            </p>
            <h3>{previewName}</h3>
            <div className={adminProductSectionStyles.productPreviewPrice}>
              <span>
                {previewPrice > 0
                  ? moneyFormatter.format(previewPrice)
                  : isKorean
                    ? "판매가 입력"
                    : "Enter price"}
                {previewCompareAtPrice > previewPrice && previewPrice > 0 ? (
                  <s>{moneyFormatter.format(previewCompareAtPrice)}</s>
                ) : null}
              </span>
            </div>

            <div className={styles.storeCardOptions}>
              <fieldset>
                <legend>{isKorean ? "옵션" : "Options"}</legend>
                {previewSizes.length > 0 ? (
                  <div
                    className={styles.storeCardSizes}
                    aria-label={isKorean ? "선택 가능한 옵션" : "Available options"}
                  >
                    {previewSizes.map((size, index) => (
                      <span
                        className={index === 0 ? styles.storeCardSizeActive : undefined}
                        key={`${index}:${size}`}
                      >
                        {size}
                      </span>
                    ))}
                  </div>
                ) : (
                  <span className={styles.previewHint}>
                    {isKorean ? "옵션 미입력" : "No options"}
                  </span>
                )}
              </fieldset>
            </div>

            {previewDescriptionLines.length > 0 ? (
              <details className={styles.productPreviewDescription}>
                <summary>{isKorean ? "상품 설명 보기" : "View description"}</summary>
                <ul className={styles.storeCardDescription}>
                  {previewDescriptionLines.map((line, index) => (
                    <li key={`${index}:${line}`}>{line}</li>
                  ))}
                </ul>
              </details>
            ) : null}
          </div>

          <div className={styles.storeCardMedia}>
            {draft.isFeatured ? (
              <span className={adminProductSectionStyles.newBadge}>NEW</span>
            ) : null}
            {/* 파일 선택으로 생긴 blob URL은 정적 export의 이미지 최적화 경로를 거치지 않습니다. */}
            <AdminProductImage
              alt={
                isKorean
                  ? `${previewName} 상품 이미지 미리보기`
                  : `${previewName} product image preview`
              }
              src={draft.imageUrl}
            />
          </div>
        </div>
        <footer>
          <span>{draft.category}</span>
          <span className={draft.isVisible ? styles.publicStatus : styles.draftStatus}>
            {canSaveToServer
              ? draft.isVisible
                ? isKorean
                  ? "저장 후 공개"
                  : "Public after saving"
                : isKorean
                  ? "비공개 저장 예정"
                  : "Will be saved as private"
              : isKorean
                ? "서버 미저장"
                : "Not saved to server"}
          </span>
        </footer>
      </article>
      {canSaveToServer ? null : (
        <p className={styles.previewNote}>
          {isKorean
            ? "서버 연결 전에는 실제 저장·공개되지 않습니다."
            : "Nothing is actually saved or published until the server is connected."}
        </p>
      )}
    </aside>
  );
}
