"use client";

import type { Dispatch, SetStateAction } from "react";
import type { Locale } from "@/types/store";
import type { AdminOcrRemapPreview } from "@/lib/admin-ui/types";
import type { OcrMappingTemplate } from "@/lib/admin-ui/ocr-mapping-templates";
import styles from "./ocr-region-mapping.module.css";
import {
  FIELD_LABELS,
  WARNING_LABELS,
  templateDisplayName,
  type Size,
} from "./ocr-region-mapping-model";

export function OcrRegionPreview({
  locale,
  isKorean,
  preview,
  previewTotal,
  previewUnknown,
}: Readonly<{
  locale: Locale;
  isKorean: boolean;
  preview: { key: string; result: AdminOcrRemapPreview };
  previewTotal: number;
  previewUnknown: number;
}>) {
  return (
    <div className={styles.preview}>
      <p className={styles.summary}>
        {isKorean
          ? `상품 ${preview.result.rows.length}개 · 수량 합계 ${previewTotal.toLocaleString("ko-KR")}개 · 수량 미확인 ${previewUnknown}행`
          : `${preview.result.rows.length} products · Total quantity ${previewTotal.toLocaleString("en-US")} · Unknown quantity ${previewUnknown} rows`}
      </p>
      {preview.result.analysis.region && (
        <p className={styles.help}>
          {isKorean
            ? `원본 인식 항목 ${preview.result.analysis.region.sourceTokenCount}개 중 포함 ${preview.result.analysis.region.includedTokenCount}개 · 제외 ${preview.result.analysis.region.excludedTokenCount}개`
            : `Included ${preview.result.analysis.region.includedTokenCount} of ${preview.result.analysis.region.sourceTokenCount} recognized items · Excluded ${preview.result.analysis.region.excludedTokenCount}`}
        </p>
      )}
      <p className={styles.warning}>
        {isKorean
          ? "미리보기의 상품 행과 수량을 원본 이미지와 비교해 주세요. 합계·금액·안내 문구가 상품으로 들어가지 않았는지 확인해야 합니다."
          : "Compare the preview's product rows and quantities with the source image. Make sure totals, prices and notes did not become products."}
      </p>
      {preview.result.analysis.region?.warnings.length ? (
        <ul className={styles.warnings}>
          {preview.result.analysis.region.warnings.map((warning, index) => (
            <li key={index}>
              {Object.hasOwn(WARNING_LABELS, warning)
                ? WARNING_LABELS[warning][locale]
                : isKorean
                  ? "영역 해석에 확인이 필요한 항목이 있습니다. 원본과 미리보기를 비교해 주세요."
                  : "Some parts of the area result need checking. Compare the source with the preview."}
            </li>
          ))}
        </ul>
      ) : null}
      <div
        className={styles.tableScroll}
        tabIndex={0}
        role="region"
        aria-label={isKorean ? "영역 지정 미리보기 표" : "Area mapping preview table"}
      >
        <table>
          <caption>
            {isKorean
              ? "영역 지정 미리보기 · 읽기 전용"
              : "Area mapping preview · Read only"}
          </caption>
          <thead>
            <tr>
              <th scope="col">{FIELD_LABELS[locale].productName}</th>
              <th scope="col">{FIELD_LABELS[locale].brand}</th>
              <th scope="col">{FIELD_LABELS[locale].option}</th>
              <th scope="col">{FIELD_LABELS[locale].quantity}</th>
            </tr>
          </thead>
          <tbody>
            {preview.result.rows.map((row) => (
              <tr key={row.id}>
                <td>{row.productName || "—"}</td>
                <td>{row.brand || "—"}</td>
                <td>{row.option || "—"}</td>
                <td>{row.quantity || (isKorean ? "미확인" : "Unknown")}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}
export function OcrRegionTemplates({
  locale,
  isKorean,
  id,
  templates,
  selectedTemplateId,
  setSelectedTemplateId,
  size,
  locked,
  ready,
  mappingValid,
  loadTemplates,
  saveTemplate,
  reuseTemplate,
  deleteTemplate,
  resetTemplates,
}: Readonly<{
  locale: Locale;
  isKorean: boolean;
  id: string;
  templates: readonly OcrMappingTemplate[];
  selectedTemplateId: string;
  setSelectedTemplateId: Dispatch<SetStateAction<string>>;
  size: Size | null;
  locked: boolean;
  ready: boolean;
  mappingValid: boolean;
  loadTemplates: () => void;
  saveTemplate: () => void;
  reuseTemplate: () => void;
  deleteTemplate: () => void;
  resetTemplates: () => void;
}>) {
  return (
    <fieldset className={styles.templates} disabled={locked}>
      <legend>{isKorean ? "저장 영역 양식" : "Saved area templates"}</legend>
      <p className={styles.help}>
        {isKorean
          ? "이 브라우저를 쓰는 계정들이 공유하는 설정입니다. 영역 좌표·이미지 크기·항목 역할만 저장하며 이미지·원문·개인정보·인증 정보는 저장하지 않습니다. 불러온 영역은 이미지에 맞게 확인하고 미리보기 후 직접 적용하세요."
          : "These settings are shared by every account using this browser. Only area coordinates, image size and field roles are saved, never images, source text, personal data or credentials. Check loaded areas against the image, preview them and apply them yourself."}
      </p>
      <div className={styles.actions}>
        <button type="button" className={styles.secondary} onClick={loadTemplates}>
          {isKorean ? "영역 양식 불러오기" : "Load area templates"}
        </button>
        <button
          type="button"
          className={styles.secondary}
          disabled={!mappingValid || !ready}
          onClick={saveTemplate}
        >
          {isKorean ? "현재 영역 양식 저장" : "Save current area template"}
        </button>
      </div>
      <div className={styles.templateSelection}>
        <label className={styles.field} htmlFor={`${id}-template`}>
          <span>{isKorean ? "저장 영역 양식" : "Saved area templates"}</span>
          <select
            id={`${id}-template`}
            value={selectedTemplateId}
            onChange={(event) => setSelectedTemplateId(event.target.value)}
          >
            <option value="">{isKorean ? "양식 선택" : "Select template"}</option>
            {templates.map((template) => (
              <option key={template.id} value={template.id}>
                {templateDisplayName(template.name, locale)}
              </option>
            ))}
          </select>
        </label>
        <button
          type="button"
          className={styles.secondary}
          disabled={!selectedTemplateId || !size}
          onClick={reuseTemplate}
        >
          {isKorean ? "영역 양식 재사용" : "Reuse area template"}
        </button>
        <button
          type="button"
          className={styles.secondary}
          disabled={!selectedTemplateId}
          onClick={deleteTemplate}
        >
          {isKorean ? "선택 영역 양식 삭제" : "Delete selected area template"}
        </button>
        <button type="button" className={styles.textButton} onClick={resetTemplates}>
          {isKorean ? "전체 양식 삭제" : "Delete all templates"}
        </button>
      </div>
    </fieldset>
  );
}
