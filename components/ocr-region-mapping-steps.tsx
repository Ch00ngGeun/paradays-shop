"use client";

import type { Dispatch, SetStateAction } from "react";
import type { Locale } from "@/types/store";
import { AdminHelpButton } from "./admin-help-button";
import styles from "./ocr-region-mapping.module.css";
import {
  FIELDS,
  FIELD_LABELS,
  MODE_LABELS,
  emptyDraft,
  type Draft,
  type Field,
  type Mode,
  type Notice,
} from "./ocr-region-mapping-model";

export function OcrRegionStepControls({
  locale,
  isKorean,
  id,
  draft,
  mode,
  setMode,
  setPan,
  locked,
  ready,
  updateDraft,
  chooseMode,
  skipField,
  cancelPointer,
}: Readonly<{
  locale: Locale;
  isKorean: boolean;
  id: string;
  draft: Draft;
  mode: Mode;
  setMode: Dispatch<SetStateAction<Mode>>;
  setPan: Dispatch<SetStateAction<boolean>>;
  locked: boolean;
  ready: boolean;
  updateDraft: (next: Draft, message?: Notice) => void;
  chooseMode: (next: Mode) => void;
  skipField: (field: Exclude<Field, "productName">) => void;
  cancelPointer: () => void;
}>) {
  return (
    <>
      <fieldset className={styles.steps} disabled={locked || !ready}>
        <legend className={styles.srOnly}>
          {isKorean ? "첫 상품 영역 지정 순서" : "First product area steps"}
        </legend>
        {FIELDS.map((field, index) => (
          <div className={styles.step} key={field}>
            <button
              type="button"
              className={`${styles.stepButton} ${styles[field]}`}
              aria-label={`${FIELD_LABELS[locale][field]} ${isKorean ? "영역" : "area"}`}
              aria-pressed={mode === field}
              onClick={() => chooseMode(field)}
            >
              <span>
                {index + 1}. {FIELD_LABELS[locale][field]} {isKorean ? "영역" : "area"}
              </span>
              <small>
                {draft.firstRow[field] === null
                  ? isKorean
                    ? "없음"
                    : "None"
                  : draft.firstRow[field]
                    ? isKorean
                      ? "지정됨 · 다시 선택"
                      : "Set · Select again"
                    : isKorean
                      ? "선택 필요"
                      : "Needs selection"}
              </small>
            </button>
            {field !== "productName" && (
              <button
                type="button"
                className={styles.noneButton}
                onClick={() => skipField(field)}
              >
                {FIELD_LABELS[locale][field]} {isKorean ? "없음" : "none"}
              </button>
            )}
          </div>
        ))}
      </fieldset>
      <div className={styles.actions}>
        <button
          type="button"
          className={styles.secondary}
          aria-label={isKorean ? "표 끝 지정" : "Set table end"}
          aria-pressed={mode === "tableBottom"}
          disabled={locked || !ready || !draft.firstRow.productName}
          onClick={() => chooseMode("tableBottom")}
        >
          {isKorean ? "표 끝 지정" : "Set table end"}
          {draft.tableBottom !== null ? (isKorean ? " · 지정됨" : " · Set") : ""}
        </button>
        <button
          type="button"
          className={styles.secondary}
          aria-label={isKorean ? "두 번째 상품 위치" : "Second product position"}
          aria-pressed={mode === "secondRow"}
          disabled={locked || !ready || !draft.firstRow.productName}
          onClick={() => chooseMode("secondRow")}
        >
          {isKorean ? "두 번째 상품 위치" : "Second product position"}
          {draft.secondRowY !== null ? (isKorean ? " · 지정됨" : " · Set") : ""}
        </button>
        {draft.secondRowY !== null && (
          <button
            type="button"
            className={styles.textButton}
            disabled={locked}
            onClick={() => updateDraft({ ...draft, secondRowY: null })}
          >
            {isKorean ? "두 번째 상품 위치 지우기" : "Clear second product position"}
          </button>
        )}
        <button
          type="button"
          className={styles.textButton}
          disabled={locked}
          onClick={() => {
            cancelPointer();
            updateDraft(emptyDraft());
            setMode("productName");
            setPan(false);
          }}
        >
          {isKorean ? "전체 영역 지우기" : "Clear all areas"}
        </button>
      </div>
      <p className={styles.instruction} id={`${id}-instruction`}>
        {isKorean ? "현재 선택:" : "Selected:"}{" "}
        <strong>{MODE_LABELS[locale][mode]}</strong>
        {mode === "tableBottom"
          ? isKorean
            ? " · 마지막 상품 바로 아래를 클릭하거나 드래그하세요."
            : " · Click or drag just below the last product."
          : mode === "secondRow"
            ? isKorean
              ? " · 두 번째 상품의 중심을 클릭하거나 드래그하세요."
              : " · Click or drag at the center of the second product."
            : isKorean
              ? " · 첫 상품의 해당 글자를 둘러싸도록 드래그하세요."
              : " · Drag around the matching text of the first product."}
      </p>
      {/* Still the image area's description; seen on screen through the help button below. */}
      <p className="srOnly" id={`${id}-keyboard`}>
        {isKorean
          ? "키보드로는 이미지에 초점을 둔 뒤 방향키로 이동하고 Space로 시작, Enter로 끝을 지정합니다. Shift와 방향키를 함께 누르면 더 크게 이동합니다."
          : "With a keyboard, focus the image, move with the arrow keys, press Space to start and Enter to finish. Hold Shift with the arrow keys to move further."}
      </p>
    </>
  );
}
export function OcrRegionConfirmation({
  locale,
  isKorean,
  draft,
  busy,
  locked,
  allFieldsChosen,
  mappingValid,
  previewCurrent,
  sourceUnavailable,
  updateDraft,
  remap,
}: Readonly<{
  locale: Locale;
  isKorean: boolean;
  draft: Draft;
  busy: boolean;
  locked: boolean;
  allFieldsChosen: boolean;
  mappingValid: boolean;
  previewCurrent: boolean;
  sourceUnavailable: boolean;
  updateDraft: (next: Draft, message?: Notice) => void;
  remap: (previewOnly: boolean) => Promise<void>;
}>) {
  return (
    <>
      <fieldset className={styles.confirmation} disabled={locked}>
        <legend className={styles.srOnly}>
          {isKorean ? "수량 영역 확인" : "Quantity area check"}
        </legend>
        <label>
          <input
            type="checkbox"
            checked={draft.quantityConfirmed}
            disabled={!draft.firstRow.quantity}
            onChange={(event) =>
              updateDraft({ ...draft, quantityConfirmed: event.target.checked })
            }
          />
          {isKorean
            ? "선택한 수량 영역은 금액이 아닌 실제 수량입니다"
            : "The selected quantity area is the actual quantity, not a price"}
        </label>
      </fieldset>
      {draft.firstRow.quantity === null && (
        <div className={styles.help}>
          <AdminHelpButton
            locale={locale}
            // Not the mode button's name, so a search for that button finds only the button.
            target={isKorean ? "반복 간격" : "Row spacing"}
          >
            <p>
              {isKorean
                ? "수량 영역이 없으면 두 번째 상품 위치를 지정해 반복 간격을 알려 주세요. 미리보기에서 모든 상품이 포함됐는지 확인하세요."
                : "Without a quantity area, set the second product position to show the row spacing. Check in the preview that every product is included."}
            </p>
          </AdminHelpButton>
        </div>
      )}
      {!allFieldsChosen && (
        <p className={styles.help}>
          {isKorean
            ? "상품명·브랜드·옵션·수량을 모두 선택하거나 없는 항목을 없음으로 지정해 주세요."
            : "Select product name, brand, option and quantity, or mark missing fields as none."}
        </p>
      )}
      {allFieldsChosen && draft.tableBottom === null && (
        <p className={styles.help}>
          {isKorean
            ? "표 끝을 직접 지정해야 미리보기를 만들 수 있습니다."
            : "Set the table end yourself to create a preview."}
        </p>
      )}
      {draft.firstRow.quantity && !draft.quantityConfirmed && (
        <p className={styles.warning}>
          {isKorean
            ? "선택한 영역이 실제 수량인지 확인해 주세요. 가격이나 상품 번호는 수량으로 사용할 수 없습니다."
            : "Confirm that the selected area is the actual quantity. Prices or product numbers cannot be used as quantities."}
        </p>
      )}
      {sourceUnavailable && (
        <p className={styles.warning}>
          {isKorean
            ? "이전 검토본에 원본 인식 행이 없어 영역을 다시 지정할 수 없습니다."
            : "The earlier review has no recognized source rows, so areas cannot be marked again."}
        </p>
      )}
      <div className={styles.actions}>
        <button
          type="button"
          className={styles.secondary}
          disabled={locked || !mappingValid || sourceUnavailable}
          onClick={() => void remap(true)}
        >
          {busy
            ? isKorean
              ? "영역 확인 중…"
              : "Checking areas…"
            : isKorean
              ? "영역 미리보기"
              : "Preview areas"}
        </button>
        <button
          type="button"
          className={styles.primary}
          disabled={locked || !mappingValid || !previewCurrent || sourceUnavailable}
          onClick={() => void remap(false)}
        >
          {isKorean ? "영역 지정 적용" : "Apply area mapping"}
        </button>
      </div>
    </>
  );
}
