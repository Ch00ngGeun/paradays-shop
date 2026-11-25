// 역할: 입고 OCR 검토 행 목록. 인식된 행마다 원문·신뢰도·좌표와 상품명·브랜드·옵션·수량 입력칸을 보여 주고, 행 추가·삭제와 검토본 저장 버튼을 제공합니다.
"use client";
import adminOcrSectionStyles from "./admin-ocr-section.module.css";
import { OCR_INPUT_LIMITS } from "@/lib/admin-ui/ocr-input-validation";
import type { AdminOcrReviewRow } from "@/lib/admin-ui/types";
import type { Locale } from "@/types/store";
import styles from "./admin-dashboard.module.css";
import { formatOcrBoundingBox, formatOcrConfidence } from "./admin-ocr-source-preview";
import { GrowingLineInput } from "./admin-product-name-input";
import { EmptyState } from "./admin-shared";

export function AdminOcrReviewPanel({
  isKorean,
  canAddRow,
  onAddRow,
  rows,
  onRemoveRow,
  onRowChange,
  locale,
  reviewSaved,
  jobVersion,
  canSave,
  isSaving,
  recognizing,
  onSave,
}: Readonly<{
  isKorean: boolean;
  canAddRow: boolean;
  onAddRow: () => void;
  rows: readonly Readonly<{
    id: string;
    sourceText: string;
    confidence?: number;
    box?: import("@/lib/admin-ui/types").AdminOcrBoundingBox;
    productName: string;
    brand: string;
    option: string;
    quantity: string;
  }>[];
  onRemoveRow: (id: string) => void;
  onRowChange: (
    id: string,
    field: Exclude<keyof AdminOcrReviewRow, "id">,
    value: string,
  ) => void;
  locale: Locale;
  reviewSaved: boolean;
  jobVersion: number | null;
  canSave: boolean;
  isSaving: boolean;
  recognizing: boolean;
  onSave: () => void;
}>) {
  return (
    <section className={styles.ocrReviewPanel} aria-labelledby="ocr-review-title">
      <div className={styles.ocrReviewHeading}>
        <div>
          <h3 id="ocr-review-title">
            {isKorean ? "인식 결과" : "Recognition results"}
          </h3>
          <p>
            {isKorean
              ? "상품명·브랜드·옵션·수량을 직접 확인하고 수정하세요."
              : "Check and correct the product name, brand, option and quantity."}
          </p>
        </div>
        <button
          className={styles.secondaryButton}
          disabled={!canAddRow}
          onClick={onAddRow}
          type="button"
        >
          {isKorean ? "행 추가" : "Add row"}
        </button>
      </div>
      {rows.length === 0 ? (
        <EmptyState
          title={isKorean ? "검토할 입고 행이 없습니다" : "No stock-in rows to review"}
          description={
            isKorean
              ? "이미지를 선택해 OCR 인식을 실행하면 수정 가능한 행이 표시됩니다. 누락된 항목은 행 추가로 입력하세요."
              : "Choose an image and run OCR to see editable rows. Add rows for anything missing."
          }
        />
      ) : (
        <ol
          className={adminOcrSectionStyles.ocrReviewRows}
          data-admin-guide="ocr.review"
        >
          {rows.map((row, index) => (
            <li key={row.id}>
              <article
                aria-label={
                  isKorean ? `${index + 1}번째 입고 행` : `Stock-in row ${index + 1}`
                }
                className={adminOcrSectionStyles.ocrReviewRow}
              >
                <div className={adminOcrSectionStyles.ocrRowHeading}>
                  <strong>{isKorean ? `${index + 1}번 행` : `Row ${index + 1}`}</strong>
                  <button
                    aria-label={
                      isKorean
                        ? `${index + 1}번 입고 행 삭제`
                        : `Delete stock-in row ${index + 1}`
                    }
                    className={styles.secondaryButton}
                    onClick={() => onRemoveRow(row.id)}
                    type="button"
                  >
                    {isKorean ? "행 삭제" : "Delete row"}
                  </button>
                </div>
                <div className={adminOcrSectionStyles.ocrMainFields}>
                  <label>
                    <span>{isKorean ? "상품명" : "Product name"}</span>
                    <GrowingLineInput
                      aria-label={isKorean ? "상품명" : "Product name"}
                      aria-describedby="ocr-row-edit-limits"
                      maxLength={OCR_INPUT_LIMITS.maxProductNameLength}
                      onValueChange={(value) =>
                        onRowChange(row.id, "productName", value)
                      }
                      value={row.productName}
                    />
                  </label>
                  <label>
                    <span>{isKorean ? "브랜드" : "Brand"}</span>
                    <GrowingLineInput
                      aria-label={isKorean ? "브랜드" : "Brand"}
                      aria-describedby="ocr-row-edit-limits"
                      maxLength={OCR_INPUT_LIMITS.maxBrandLength}
                      onValueChange={(value) => onRowChange(row.id, "brand", value)}
                      value={row.brand}
                    />
                  </label>
                  <label>
                    <span>{isKorean ? "옵션" : "Option"}</span>
                    <input
                      aria-label={isKorean ? "옵션" : "Option"}
                      aria-describedby="ocr-row-edit-limits"
                      maxLength={OCR_INPUT_LIMITS.maxOptionLength}
                      onChange={(event) =>
                        onRowChange(row.id, "option", event.target.value)
                      }
                      value={row.option}
                    />
                  </label>
                  <label>
                    <span>{isKorean ? "수량" : "Quantity"}</span>
                    <input
                      aria-label={isKorean ? "수량" : "Quantity"}
                      aria-describedby="ocr-row-edit-limits"
                      inputMode="numeric"
                      maxLength={OCR_INPUT_LIMITS.maxQuantityDigits}
                      onChange={(event) =>
                        onRowChange(row.id, "quantity", event.target.value)
                      }
                      pattern="[0-9]*"
                      value={row.quantity}
                    />
                  </label>
                </div>
                <details className={adminOcrSectionStyles.ocrRowDetails}>
                  <summary>
                    {isKorean ? "인식 원문·상세 보기" : "View source text and details"}
                  </summary>
                  <label>
                    <span>
                      {isKorean ? "OCR 원문 (수정 가능)" : "OCR source text (editable)"}
                    </span>
                    <GrowingLineInput
                      aria-label={
                        isKorean ? "OCR 원문 (수정 가능)" : "OCR source text (editable)"
                      }
                      aria-describedby="ocr-row-edit-limits"
                      maxLength={OCR_INPUT_LIMITS.maxSourceTextLength}
                      onValueChange={(value) =>
                        onRowChange(row.id, "sourceText", value)
                      }
                      value={row.sourceText}
                    />
                  </label>
                  <dl>
                    <div>
                      <dt>
                        {isKorean ? "신뢰도 (읽기 전용)" : "Confidence (read-only)"}
                      </dt>
                      <dd>{formatOcrConfidence(row.confidence)}</dd>
                    </div>
                    <div>
                      <dt>
                        {isKorean ? "좌표 (읽기 전용)" : "Coordinates (read-only)"}
                      </dt>
                      <dd>{formatOcrBoundingBox(row.box)}</dd>
                    </div>
                  </dl>
                </details>
              </article>
            </li>
          ))}
        </ol>
      )}
      <details className={styles.ocrEditHelp}>
        <summary>
          {isKorean ? "입력 제한·빈 항목 안내" : "Input limits and empty fields"}
        </summary>
        <p id="ocr-row-edit-limits">
          {isKorean
            ? `원문 ${OCR_INPUT_LIMITS.maxSourceTextLength.toLocaleString("ko-KR")}자, 상품명 ${OCR_INPUT_LIMITS.maxProductNameLength}자, 브랜드 ${OCR_INPUT_LIMITS.maxBrandLength}자, 옵션 ${OCR_INPUT_LIMITS.maxOptionLength}자까지 입력할 수 있습니다. 검토 행은 최대 ${OCR_INPUT_LIMITS.maxReviewRows}개이며 수량은 비우거나 0~999,999,999 정수만 허용됩니다. 빈 항목은 검토본에 보관할 수 있으나 실제 입고 전에 상품과 수량을 별도로 확인해야 합니다.`
            : `Source text up to ${OCR_INPUT_LIMITS.maxSourceTextLength.toLocaleString("en-US")} characters, product name ${OCR_INPUT_LIMITS.maxProductNameLength}, brand ${OCR_INPUT_LIMITS.maxBrandLength}, option ${OCR_INPUT_LIMITS.maxOptionLength}. Up to ${OCR_INPUT_LIMITS.maxReviewRows} review rows; quantity is empty or a whole number from 0 to 999,999,999. Empty fields can stay in the review, but check the product and quantity separately before stock-in.`}
        </p>
      </details>
      <div className={styles.ocrReviewSave}>
        <p className={adminOcrSectionStyles.ocrSaveBoundary}>
          {locale === "ko"
            ? "검토본을 저장해도 재고는 변경되지 않습니다. 입고 반영은 저장 후 별도로 확인하며 신규 상품은 비공개 초안으로 생성됩니다."
            : "Saving a review does not change inventory. Inventory application requires separate confirmation after saving; new products are created as private drafts."}
        </p>
        <div>
          <span>
            {reviewSaved
              ? isKorean
                ? `검토본 저장됨 · 서버 버전 ${jobVersion}`
                : `Review saved · Server version ${jobVersion}`
              : rows.length
                ? isKorean
                  ? "검토본 저장 필요"
                  : "Review needs saving"
                : isKorean
                  ? "인식 결과 대기"
                  : "Waiting for results"}
          </span>
          <button
            className={styles.primaryButton}
            data-admin-guide="ocr.save"
            disabled={!canSave || isSaving || recognizing || rows.length === 0}
            onClick={onSave}
            type="button"
          >
            {isSaving
              ? isKorean
                ? "처리 중…"
                : "Processing…"
              : isKorean
                ? "검토본 저장"
                : "Save review"}
          </button>
        </div>
      </div>
    </section>
  );
}
