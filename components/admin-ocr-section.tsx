// 역할: 관리자 입고 OCR 메뉴 화면. 원본 이미지 선택·OCR 인식·검토 행 편집·검토본 저장 단계를 그리고, 영역 지정 패널과 입고 반영 패널을 주입받아 붙입니다.
"use client";
import adminOcrSectionStyles from "./admin-ocr-section.module.css";
import adminProductSectionStyles from "./admin-product-section.module.css";
import adminSharedStyles from "./admin-shared.module.css";
import { useLocale } from "@/contexts/locale-context";
import { adminGuideSteps } from "@/lib/admin-ui/admin-guides";
import type { AdminOcrReviewRow } from "@/lib/admin-ui/types";
import {
  isLocalOcrDevelopmentMode,
  isRemoteOcrDemoMode,
} from "@/lib/commerce/admin-api-client-environment";
import { useSyncExternalStore, type ChangeEvent, type ReactNode } from "react";
import styles from "./admin-dashboard.module.css";
import { AdminGuideButton } from "./admin-guide";
import { AdminHelpButton } from "./admin-help-button";
import { serverLocalOcrMode, subscribeToLocalOcrMode } from "./admin-navigation";
import { AdminOcrReviewPanel } from "./admin-ocr-review-panel";
import { OcrSourcePreview } from "./admin-ocr-source-preview";
import { Notice, NoticeMessage, OcrState } from "./admin-shared";
import { AdminStepper, type AdminStep } from "./admin-stepper";

export function OcrSection({
  canAddRow,
  canSave,
  file,
  isSaving,
  jobVersion,
  reviewSaved,
  notice,
  onAddRow,
  onFileChange,
  onRecognize,
  onRemoveRow,
  onRowChange,
  onSave,
  rows,
  rawText,
  mappingPanel,
  inventoryPanel,
  state,
}: Readonly<{
  canAddRow: boolean;
  canSave: boolean;
  file: File | null;
  isSaving: boolean;
  jobVersion: number | null;
  reviewSaved: boolean;
  notice: Notice;
  onAddRow: () => void;
  onFileChange: (event: ChangeEvent<HTMLInputElement>) => void;
  onRecognize: () => void;
  onRemoveRow: (id: string) => void;
  onRowChange: (
    id: string,
    field: Exclude<keyof AdminOcrReviewRow, "id">,
    value: string,
  ) => void;
  onSave: () => void;
  rows: readonly AdminOcrReviewRow[];
  rawText: string;
  mappingPanel?: ReactNode;
  inventoryPanel?: ReactNode;
  state: OcrState;
}>) {
  const { locale } = useLocale();
  const isKorean = locale === "ko";
  const localOcr = useSyncExternalStore(
    subscribeToLocalOcrMode,
    isLocalOcrDevelopmentMode,
    serverLocalOcrMode,
  );
  const remoteOcrDemo = useSyncExternalStore(
    subscribeToLocalOcrMode,
    isRemoteOcrDemoMode,
    serverLocalOcrMode,
  );
  const recognizing = state === "recognizing";
  const statusLabel = recognizing
    ? isKorean
      ? "인식 중"
      : "Recognizing"
    : reviewSaved
      ? isKorean
        ? "검토본 저장됨"
        : "Review saved"
      : state === "review"
        ? isKorean
          ? "검토 중 · 저장 필요"
          : "Reviewing · Needs saving"
        : state === "connection-needed"
          ? isKorean
            ? "API 연결 필요"
            : "API connection needed"
          : isKorean
            ? "이미지 선택"
            : "Choose image";
  const quantityValid = (value: string) => /^[0-9]{1,9}$/.test(value);
  const invalidQuantities = rows.filter(
    (row) => row.quantity !== "" && !quantityValid(row.quantity),
  ).length;
  const totalQuantity = rows.reduce(
    (total, row) => total + (quantityValid(row.quantity) ? Number(row.quantity) : 0),
    0,
  );
  const incompleteRows = rows.filter(
    (row) =>
      !row.productName.trim() ||
      !row.brand.trim() ||
      !row.option.trim() ||
      !row.quantity.trim(),
  ).length;
  const reviewing = state === "review";
  // 입고 반영 결과는 아래 반영 패널이 직접 표시하므로 이 흐름에서 완료로 표시하지 않습니다.
  const ocrSteps: AdminStep[] = [
    {
      label: isKorean ? "이미지 선택" : "Choose image",
      state: recognizing || reviewing ? "complete" : "current",
    },
    {
      label: isKorean ? "OCR 인식" : "OCR recognition",
      state:
        state === "connection-needed"
          ? "unavailable"
          : recognizing
            ? "current"
            : reviewing
              ? "complete"
              : "upcoming",
    },
    {
      label: isKorean ? "내용 검토" : "Review content",
      state: !reviewing ? "upcoming" : reviewSaved ? "complete" : "current",
    },
    {
      label: isKorean ? "검토본 저장" : "Save review",
      state: reviewing && reviewSaved ? "complete" : "upcoming",
    },
    {
      label: isKorean ? "입고 반영" : "Apply stock-in",
      state: reviewing && reviewSaved && inventoryPanel ? "current" : "upcoming",
    },
  ];
  return (
    <div
      className={`${styles.sectionStack} ${styles.ocrSectionStack} ${styles.ocrScreen}`}
    >
      <header className={adminOcrSectionStyles.ocrHeader}>
        <div>
          <p>{isKorean ? "재고 / 입고 OCR" : "Inventory / Stock-in OCR"}</p>
          <h2>{isKorean ? "입고 검토" : "Stock-in review"}</h2>
          <p>
            {locale === "ko"
              ? "이미지와 인식 결과를 비교하고 상품 정보를 확인하세요."
              : "Compare the image with recognition results and review the product information."}
          </p>
        </div>
        <div
          className={`${adminProductSectionStyles.productListHeaderActions} ${adminSharedStyles.wrapRow}`}
        >
          <span className={adminOcrSectionStyles.ocrReviewBadge} role="status">
            {statusLabel}
          </span>
          <AdminGuideButton locale={locale} steps={adminGuideSteps("ocr", locale)} />
        </div>
      </header>
      <AdminStepper
        label={isKorean ? "OCR 등록 흐름" : "OCR intake workflow"}
        locale={locale}
        steps={ocrSteps}
      />
      <div
        className={adminOcrSectionStyles.ocrSummary}
        aria-label={isKorean ? "현재 검토 행 요약" : "Current review row summary"}
      >
        <article>
          <span>{isKorean ? "검토 행" : "Review rows"}</span>
          <strong>
            {isKorean
              ? `${rows.length.toLocaleString("ko-KR")}행`
              : rows.length.toLocaleString("en-US")}
          </strong>
        </article>
        <article>
          <span>{isKorean ? "입력 수량 합계" : "Total entered quantity"}</span>
          <strong>
            {invalidQuantities
              ? isKorean
                ? "수량 확인 필요"
                : "Check quantities"
              : isKorean
                ? `${totalQuantity.toLocaleString("ko-KR")}개`
                : totalQuantity.toLocaleString("en-US")}
          </strong>
          <small>
            {isKorean
              ? "빈 수량 제외 · 실제 재고와 무관"
              : "Excludes empty quantities · Unrelated to actual stock"}
          </small>
        </article>
        <article>
          <span>{isKorean ? "빈 항목 포함 행" : "Rows with empty fields"}</span>
          <strong>
            {isKorean
              ? `${incompleteRows.toLocaleString("ko-KR")}행`
              : incompleteRows.toLocaleString("en-US")}
          </strong>
          <small>
            {isKorean
              ? "상품명·브랜드·옵션·수량 기준"
              : "By name, brand, option and quantity"}
          </small>
        </article>
      </div>
      {notice ? <NoticeMessage notice={notice} /> : null}
      <div className={adminOcrSectionStyles.ocrWorkspace}>
        <section className={styles.ocrSourcePanel} aria-labelledby="ocr-source-title">
          <div className={adminSharedStyles.titleWithHelp}>
            <h3 id="ocr-source-title">{isKorean ? "원본 이미지" : "Source image"}</h3>
            <span className={adminSharedStyles.fieldHelp}>
              <AdminHelpButton
                locale={locale}
                target={isKorean ? "원본 이미지" : "Source image"}
              >
                <p>
                  {isKorean
                    ? "PNG·JPG·WEBP · 4MiB 이하 · 표 전체가 보이는 이미지"
                    : "PNG, JPG or WEBP · Up to 4 MiB · Include the complete table"}
                </p>
              </AdminHelpButton>
            </span>
          </div>
          {remoteOcrDemo ? (
            <div
              className={adminOcrSectionStyles.ocrTransferNote}
              role="note"
              aria-label={
                locale === "ko" ? "PC OCR 임시 테스트" : "Temporary PC OCR test"
              }
            >
              <strong>
                {locale === "ko" ? "PC OCR 임시 테스트" : "Temporary PC OCR test"}
              </strong>
              <p>
                {locale === "ko"
                  ? "이미지는 제3자 HTTPS 중계망을 거쳐 운영자 PC로 전송됩니다. 개인정보 포함 여부를 전송 전에 확인하세요."
                  : "Images travel through a temporary third-party HTTPS relay to the operator’s PC. Check images for personal information before sending them."}
              </p>
              <p>
                {locale === "ko"
                  ? "검토본은 PC 메모리에 임시 보관되며 서버 재시작 시 삭제됩니다. 검토본 저장만으로 상품·재고·AWS에는 저장하지 않습니다. 별도로 확인한 입고 반영은 실제 재고를 변경합니다."
                  : "Text reviews are kept only in the operator’s PC memory and are deleted when the server restarts. Review saving does not save products, inventory or AWS data, or publish products. Separately confirming inventory application changes real product inventory."}
              </p>
            </div>
          ) : localOcr ? (
            <div
              className={adminOcrSectionStyles.ocrTransferNote}
              role="note"
              aria-label={locale === "ko" ? "로컬 OCR 테스트" : "Local OCR test"}
            >
              <strong>{locale === "ko" ? "로컬 OCR 테스트" : "Local OCR test"}</strong>
              <p>
                {locale === "ko"
                  ? "이미지는 현재 컴퓨터의 로컬 중계 서버로 전송합니다. 검토본은 PC 메모리에만 보관되며 재시작 시 삭제됩니다. 검토본 저장만으로 상품·재고·AWS에는 저장하지 않습니다. 별도로 확인한 입고 반영은 실제 재고를 변경합니다."
                  : "Images are sent to this computer’s local relay. Only text reviews are stored in this computer’s memory and are deleted when the server restarts. Review saving does not save products, inventory or AWS data, or publish products. Separately confirming inventory application changes real product inventory."}
              </p>
            </div>
          ) : (
            <p className={adminOcrSectionStyles.ocrTransferNote}>
              {locale === "ko"
                ? "이미지는 관리자 API로 전송합니다. 개인정보 포함 여부를 확인하세요. 검토본 저장만으로 재고나 상품 공개 상태는 바뀌지 않습니다."
                : "Images are sent to the administrator API. Check for personal information before sending. Saving a review does not change inventory or publish products."}
            </p>
          )}
          <label
            className={adminOcrSectionStyles.ocrFileControl}
            data-admin-guide="ocr.image"
          >
            <span>{isKorean ? "이미지 파일 선택" : "Choose image file"}</span>
            <input
              accept="image/png,image/jpeg,image/webp"
              onChange={onFileChange}
              type="file"
            />
          </label>
          <button
            className={styles.primaryButton}
            data-admin-guide="ocr.recognize"
            disabled={!file || recognizing}
            onClick={onRecognize}
            type="button"
          >
            {recognizing
              ? isKorean
                ? "OCR 인식 중…"
                : "Recognizing…"
              : isKorean
                ? "OCR로 텍스트 추출"
                : "Extract text with OCR"}
          </button>
          {file ? (
            <OcrSourcePreview file={file} />
          ) : (
            <div className={adminOcrSectionStyles.ocrSourceEmpty}>
              <span aria-hidden="true">▧</span>
              <p>
                {isKorean
                  ? "이미지를 선택하면 여기에 표시됩니다."
                  : "The selected image appears here."}
              </p>
            </div>
          )}
          <details className={styles.ocrProcessingHelp}>
            <summary>
              {locale === "ko"
                ? "처리 경로·용량·연결 안내"
                : "Processing route, limits and connection help"}
            </summary>
            <p>
              {locale !== "ko"
                ? remoteOcrDemo
                  ? "The operator’s PC OCR server does not store image files. The PaddleOCR shared secret stays only on the operator’s PC. Administrator sign-in is required. Requests are rejected (403) if the signed authentication token lacks the admin group, even when signed in."
                  : localOcr
                    ? "Images are sent only to this computer’s local relay and are not stored. The PaddleOCR shared secret stays on the local server."
                    : "The browser sends images only to the administrator API. Keep the PaddleOCR address and shared secret in AWS Secrets Manager, not in public browser environment variables."
                : remoteOcrDemo
                  ? "운영자 PC의 OCR 서버는 이미지 파일을 저장하지 않습니다. PaddleOCR 공유 비밀값은 운영자 PC에만 보관합니다. 관리자 토큰에 admin 권한이 없으면 요청이 거부됩니다(403)."
                  : localOcr
                    ? "이미지 파일은 로컬 중계 서버에서 보관하지 않으며 PaddleOCR 공유 비밀값은 로컬 서버에만 둡니다."
                    : "브라우저는 관리자 API에만 이미지를 전달합니다. PaddleOCR 주소·공유 비밀값은 AWS Secrets Manager에만 두고 브라우저 공개 환경변수에 넣지 않습니다."}
            </p>
            <p>
              {locale === "ko"
                ? "인식에 최대 2분 정도 걸릴 수 있습니다. 시간 초과·연결 오류가 나면 관리자 권한과 OCR 서버·중계 연결을 확인한 뒤 다시 시도하세요."
                : "Recognition may take up to about 2 minutes. If it times out or the connection fails, check administrator permissions and that the OCR server and HTTPS relay are running before retrying."}
            </p>
            <p>
              {locale === "ko"
                ? "현재 직접 전송 한도는 4MiB입니다. 4~6MiB private S3 경로는 배포 전이므로 더 작은 파일을 선택하세요."
                : "Direct transmission is limited to 4 MiB. The private S3 route for 4–6 MiB files is not deployed; choose a smaller image."}
            </p>
          </details>
        </section>
        <AdminOcrReviewPanel
          isKorean={isKorean}
          canAddRow={canAddRow}
          onAddRow={onAddRow}
          rows={rows}
          onRemoveRow={onRemoveRow}
          onRowChange={onRowChange}
          locale={locale}
          reviewSaved={reviewSaved}
          jobVersion={jobVersion}
          canSave={canSave}
          isSaving={isSaving}
          recognizing={recognizing}
          onSave={onSave}
        />
      </div>
      {mappingPanel ? (
        <details className={styles.ocrAdvanced}>
          <summary>
            {isKorean
              ? "표 인식이 다르면 · 열·이미지 영역 직접 지정"
              : "If the table is misread · Set columns or image areas"}
          </summary>
          <p>
            {isKorean
              ? "상품명·브랜드·옵션·수량의 위치를 지정하고 미리보기로 확인한 뒤 적용하세요. 적용하면 검토 내용을 다시 확인하고 저장해야 합니다."
              : "Set where the product name, brand, option and quantity are, check the preview, then apply. After applying, review the content again and save."}
          </p>
          {mappingPanel}
        </details>
      ) : null}
      {rawText ? (
        <details className={styles.ocrRawReadOnly}>
          <summary>
            {isKorean ? "인식 원문 보기 · 읽기 전용" : "View source text · Read-only"}
          </summary>
          <pre>{rawText}</pre>
        </details>
      ) : null}
      {inventoryPanel ? (
        <section
          className={styles.ocrInventoryStage}
          aria-label={isKorean ? "검토본 입고 반영" : "Apply review to stock"}
          data-admin-guide="ocr.apply"
        >
          <h3>{isKorean ? "5. 입고 반영" : "5. Apply stock-in"}</h3>
          <p>
            {isKorean
              ? "아래에서 상품과 수량을 별도로 확인합니다. 이 화면의 검토본 저장 상태는 입고 완료를 뜻하지 않습니다."
              : "Check the products and quantities separately below. A saved review on this screen does not mean the stock-in is done."}
          </p>
          {inventoryPanel}
        </section>
      ) : null}
    </div>
  );
}
