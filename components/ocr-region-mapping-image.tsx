// 역할: OCR 영역 지정 이미지 도구줄(확대 배율·이미지 이동)과 이미지 위에 지정한 영역·표 끝·두 번째 상품 표시를 겹쳐 그립니다.
"use client";

import type { Dispatch, SetStateAction } from "react";
import type { Locale } from "@/types/store";
import { AdminHelpButton } from "./admin-help-button";
import styles from "./ocr-region-mapping.module.css";
import {
  FIELDS,
  FIELD_LABELS,
  rectStyle,
  type Draft,
  type Field,
  type Mode,
  type Point,
  type Rect,
} from "./ocr-region-mapping-model";

export function OcrRegionImageToolbar({
  locale,
  isKorean,
  id,
  zoom,
  setZoom,
  pan,
  setPan,
  locked,
  ready,
  setKeyboardActive,
  cancelPointer,
}: Readonly<{
  locale: Locale;
  isKorean: boolean;
  id: string;
  zoom: number;
  setZoom: Dispatch<SetStateAction<number>>;
  pan: boolean;
  setPan: Dispatch<SetStateAction<boolean>>;
  locked: boolean;
  ready: boolean;
  setKeyboardActive: Dispatch<SetStateAction<boolean>>;
  cancelPointer: () => void;
}>) {
  return (
    <div className={styles.imageToolbar}>
      <label className={styles.field} htmlFor={`${id}-zoom`}>
        <span>{isKorean ? "이미지 확대 배율" : "Image zoom"}</span>
        <select
          id={`${id}-zoom`}
          value={zoom}
          disabled={locked || !ready}
          onChange={(event) => {
            cancelPointer();
            setZoom(Number(event.target.value));
          }}
        >
          <option value="1">100%</option>
          <option value="2">200%</option>
          <option value="3">300%</option>
        </select>
      </label>
      <button
        type="button"
        className={styles.secondary}
        aria-pressed={pan}
        disabled={locked || !ready}
        onClick={() => {
          cancelPointer();
          setKeyboardActive(false);
          setPan((current) => !current);
        }}
      >
        {isKorean ? "이미지 이동" : "Move image"}
      </button>
      <div className={styles.help}>
        <AdminHelpButton
          locale={locale}
          target={isKorean ? "이미지 영역 선택" : "Image area selection"}
        >
          <p>
            {isKorean
              ? "작은 글자는 확대해서 선택하세요. 이미지 이동을 켜면 확대된 이미지를 스크롤하거나 손가락으로 이동할 수 있고, 영역을 선택하려면 항목 버튼을 누르세요."
              : "Zoom in to select small text. With Move image on, scroll or swipe the zoomed image; press a field button to select areas."}
          </p>
          <p>
            {isKorean
              ? "키보드로는 이미지에 초점을 둔 뒤 방향키로 이동하고 Space로 시작, Enter로 끝을 지정합니다. Shift와 방향키를 함께 누르면 더 크게 이동합니다."
              : "With a keyboard, focus the image, move with the arrow keys, press Space to start and Enter to finish. Hold Shift with the arrow keys to move further."}
          </p>
        </AdminHelpButton>
      </div>
    </div>
  );
}
export function OcrRegionOverlay({
  locale,
  isKorean,
  draft,
  mode,
  drag,
  cursor,
  keyboardActive,
  activeRect,
}: Readonly<{
  locale: Locale;
  isKorean: boolean;
  draft: Draft;
  mode: Mode;
  drag: { start: Point; end: Point } | null;
  cursor: Point;
  keyboardActive: boolean;
  activeRect: Rect | null;
}>) {
  return (
    <div className={styles.overlay} aria-hidden="true">
      {FIELDS.map((field) =>
        draft.firstRow[field] ? (
          <div
            className={`${styles.box} ${styles[field]}`}
            style={rectStyle(draft.firstRow[field]!)}
            key={field}
          >
            <span>{FIELD_LABELS[locale][field]}</span>
          </div>
        ) : null,
      )}
      {draft.tableBottom !== null && (
        <div
          className={styles.bottomLine}
          style={{ top: `${draft.tableBottom * 100}%` }}
        >
          <span>{isKorean ? "표 끝" : "Table end"}</span>
        </div>
      )}
      {draft.secondRowY !== null && (
        <div
          className={styles.secondLine}
          style={{ top: `${draft.secondRowY * 100}%` }}
        >
          <span>{isKorean ? "두 번째 상품" : "Second product"}</span>
        </div>
      )}
      {activeRect && FIELDS.includes(mode as Field) && (
        <div
          className={`${styles.box} ${styles.pendingBox}`}
          style={rectStyle(activeRect)}
        />
      )}
      {drag && mode === "tableBottom" && (
        <div
          className={styles.bottomLine}
          style={{ top: `${Math.max(drag.start.y, drag.end.y) * 100}%` }}
        />
      )}
      {drag && mode === "secondRow" && (
        <div
          className={styles.secondLine}
          style={{ top: `${(drag.start.y + drag.end.y) * 50}%` }}
        />
      )}
      {keyboardActive && (
        <div
          className={styles.cursor}
          style={{ left: `${cursor.x * 100}%`, top: `${cursor.y * 100}%` }}
        />
      )}
    </div>
  );
}
