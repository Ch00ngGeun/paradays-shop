// 역할: 입고 OCR 영역 지정 패널 본체. 원본 이미지 위에서 첫 상품 필드 영역·표 끝·두 번째 상품을 지정하게 하고, 단계 조작부·이미지 표시·확인·미리보기·양식 영역을 묶습니다.
"use client";

import {
  useEffect,
  useId,
  useRef,
  useState,
  type KeyboardEvent,
  type PointerEvent,
} from "react";
import { useLocale } from "@/contexts/locale-context";
import { isOcrRegionMapping } from "../infra/lambda/ocr-table-parser.js";
import type {
  AdminOcrRemapPreview,
  AdminOcrRemapResult,
  OcrMapping,
  OcrRegionMapping,
  OcrTableAnalysis,
} from "@/lib/admin-ui/types";
import { normalizeOcrPointer } from "@/lib/admin-ui/ocr-region-selection";
import type { OcrMappingTemplate } from "@/lib/admin-ui/ocr-mapping-templates";
import styles from "./ocr-region-mapping.module.css";
import {
  FIELDS,
  FIELD_LABELS,
  draftFromAnalysis,
  emptyDraft,
  type Draft,
  type Field,
  type Mode,
  type Notice,
  type Point,
  type Size,
} from "./ocr-region-mapping-model";
import {
  useOcrRemapAction,
  useOcrSelectionActions,
  useOcrTemplateActions,
} from "./ocr-region-mapping-actions";
import { OcrRegionImageToolbar, OcrRegionOverlay } from "./ocr-region-mapping-image";
import { OcrRegionPreview, OcrRegionTemplates } from "./ocr-region-mapping-results";
import {
  OcrRegionConfirmation,
  OcrRegionStepControls,
} from "./ocr-region-mapping-steps";

export type OcrRegionMappingProps = Readonly<{
  file: File | null;
  jobId: string;
  version: number;
  analysis: OcrTableAnalysis | undefined;
  disabled: boolean;
  onRemap: (
    mapping: OcrMapping,
    preview: boolean,
  ) => Promise<AdminOcrRemapResult | null>;
}>;

/** 파일 이미지는 이 컴포넌트의 object URL에서만 표시하며 선택값은 좌표만 전달함. */
export function OcrRegionMappingPanel({
  file,
  jobId,
  version,
  analysis,
  disabled,
  onRemap,
}: OcrRegionMappingProps) {
  const { locale } = useLocale();
  const isKorean = locale === "ko";
  const id = useId();
  const imageRef = useRef<HTMLImageElement>(null);
  const imageUrlRef = useRef<string | null>(null);
  const requestSerial = useRef(0);
  const requestPending = useRef(false);
  const pointer = useRef<{ id: number; start: Point } | null>(null);
  const keyboardStart = useRef<Point | null>(null);
  const [loaded, setLoaded] = useState<{ file: File; size: Size } | null>(null);
  const [draft, setDraft] = useState(() => draftFromAnalysis(analysis));
  const [mode, setMode] = useState<Mode>("productName");
  const [drag, setDrag] = useState<{ start: Point; end: Point } | null>(null);
  const [cursor, setCursor] = useState<Point>({ x: 0.5, y: 0.5 });
  const [keyboardActive, setKeyboardActive] = useState(false);
  const [zoom, setZoom] = useState(1);
  const [pan, setPan] = useState(false);
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState<Notice>("");
  const [preview, setPreview] = useState<{
    key: string;
    result: AdminOcrRemapPreview;
  } | null>(null);
  const [templates, setTemplates] = useState<readonly OcrMappingTemplate[]>([]);
  const [selectedTemplateId, setSelectedTemplateId] = useState("");

  useEffect(() => {
    const image = imageRef.current;
    if (!file || !image) return;
    const url = URL.createObjectURL(file);
    imageUrlRef.current = url;
    image.src = url;
    return () => {
      requestSerial.current += 1;
      pointer.current = null;
      keyboardStart.current = null;
      imageUrlRef.current = null;
      image.removeAttribute("src");
      URL.revokeObjectURL(url);
    };
  }, [file]);

  const size = loaded?.file === file ? loaded.size : null;
  const locked = disabled || busy;
  const ready = Boolean(file && size);
  const allFieldsChosen = FIELDS.every((field) => draft.firstRow[field] !== undefined);
  const mapping: OcrRegionMapping | null =
    size && draft.firstRow.productName && allFieldsChosen && draft.tableBottom !== null
      ? {
          schemaVersion: 2,
          parserVersion: 1,
          kind: "regions",
          image: size,
          firstRow: {
            productName: draft.firstRow.productName,
            brand: draft.firstRow.brand ?? null,
            option: draft.firstRow.option ?? null,
            quantity: draft.firstRow.quantity ?? null,
          },
          tableBottom: draft.tableBottom,
          secondRowY: draft.secondRowY,
          quantityConfirmed: draft.quantityConfirmed,
        }
      : null;
  const mappingValid = mapping !== null && isOcrRegionMapping(mapping);
  const mappingKey = mapping ? JSON.stringify(mapping) : "";
  const previewCurrent =
    preview?.key === mappingKey &&
    preview.result.jobId === jobId &&
    preview.result.version === version;
  const sourceUnavailable = analysis?.reason === "source-rows-unavailable";
  const activeRect = drag
    ? {
        left: Math.min(drag.start.x, drag.end.x),
        top: Math.min(drag.start.y, drag.end.y),
        right: Math.max(drag.start.x, drag.end.x),
        bottom: Math.max(drag.start.y, drag.end.y),
      }
    : null;

  function updateDraft(next: Draft, message: Notice = "") {
    requestSerial.current += 1;
    setDraft(next);
    setPreview(null);
    setNotice(message);
  }

  function chooseMode(next: Mode) {
    pointer.current = null;
    keyboardStart.current = null;
    setDrag(null);
    setMode(next);
    setPan(false);
    setNotice("");
  }

  function advance(field: Field) {
    const next = FIELDS[FIELDS.indexOf(field) + 1];
    setMode(next ?? "tableBottom");
    setPan(false);
  }

  function skipField(field: Exclude<Field, "productName">) {
    updateDraft(
      {
        ...draft,
        firstRow: { ...draft.firstRow, [field]: null },
        ...(field === "quantity" ? { quantityConfirmed: false } : {}),
      },
      {
        ko: `${FIELD_LABELS.ko[field]} 없음으로 지정했습니다.`,
        en: `Set ${FIELD_LABELS.en[field]} to none.`,
      },
    );
    advance(field);
  }

  const { completeSelection } = useOcrSelectionActions({
    size,
    locked,
    mode,
    draft,
    setNotice,
    updateDraft,
    advance,
  });

  function normalizedPoint(event: PointerEvent<HTMLDivElement>): Point | null {
    const image = imageRef.current;
    return image
      ? normalizeOcrPointer(event.clientX, event.clientY, image.getBoundingClientRect())
      : null;
  }

  function pointerDown(event: PointerEvent<HTMLDivElement>) {
    if (pointer.current && pointer.current.id !== event.pointerId) {
      cancelPointer();
      return;
    }
    if (locked || !ready || pan || event.button !== 0) return;
    const point = normalizedPoint(event);
    if (!point) return;
    event.preventDefault();
    event.currentTarget.setPointerCapture(event.pointerId);
    pointer.current = { id: event.pointerId, start: point };
    keyboardStart.current = null;
    setKeyboardActive(false);
    setDrag({ start: point, end: point });
  }

  function pointerMove(event: PointerEvent<HTMLDivElement>) {
    if (!pointer.current || pointer.current.id !== event.pointerId) return;
    const point = normalizedPoint(event);
    if (point) setDrag({ start: pointer.current.start, end: point });
  }

  function pointerUp(event: PointerEvent<HTMLDivElement>) {
    const active = pointer.current;
    if (!active || active.id !== event.pointerId) return;
    const point = normalizedPoint(event);
    pointer.current = null;
    if (event.currentTarget.hasPointerCapture(event.pointerId)) {
      event.currentTarget.releasePointerCapture(event.pointerId);
    }
    setDrag(null);
    if (point) completeSelection(active.start, point);
  }

  function cancelPointer() {
    pointer.current = null;
    keyboardStart.current = null;
    setDrag(null);
  }

  function keyboardSelection(event: KeyboardEvent<HTMLDivElement>) {
    if (!ready || locked || pan) return;
    const arrows: Record<string, Point> = {
      ArrowLeft: { x: -1, y: 0 },
      ArrowRight: { x: 1, y: 0 },
      ArrowUp: { x: 0, y: -1 },
      ArrowDown: { x: 0, y: 1 },
    };
    if (Object.hasOwn(arrows, event.key)) {
      event.preventDefault();
      const step = event.shiftKey ? 0.05 : 0.01;
      const next = {
        x: Math.max(0, Math.min(1, cursor.x + arrows[event.key].x * step)),
        y: Math.max(0, Math.min(1, cursor.y + arrows[event.key].y * step)),
      };
      setCursor(next);
      setKeyboardActive(true);
      if (keyboardStart.current) setDrag({ start: keyboardStart.current, end: next });
    } else if (event.key === " ") {
      event.preventDefault();
      keyboardStart.current = cursor;
      setKeyboardActive(true);
      setDrag({ start: cursor, end: cursor });
    } else if (event.key === "Enter") {
      event.preventDefault();
      completeSelection(keyboardStart.current ?? cursor, cursor);
      keyboardStart.current = null;
      setDrag(null);
    } else if (event.key === "Escape") {
      event.preventDefault();
      cancelPointer();
    }
  }

  const { remap } = useOcrRemapAction({
    isKorean,
    jobId,
    version,
    onRemap,
    requestSerial,
    requestPending,
    setBusy,
    setNotice,
    setPreview,
    locked,
    mapping,
    mappingValid,
    mappingKey,
    previewCurrent,
    sourceUnavailable,
  });

  const { loadTemplates, saveTemplate, reuseTemplate, deleteTemplate, resetTemplates } =
    useOcrTemplateActions({
      isKorean,
      draft,
      setMode,
      setPan,
      setNotice,
      templates,
      setTemplates,
      selectedTemplateId,
      setSelectedTemplateId,
      size,
      mapping,
      mappingValid,
      updateDraft,
      cancelPointer,
    });
  const previewRows = preview?.result.rows ?? [];
  const previewTotal = previewRows.reduce(
    (total, row) => total + Number(row.quantity || 0),
    0,
  );
  const previewUnknown = previewRows.filter((row) => row.quantity === "").length;

  return (
    <section className={styles.panel} aria-labelledby={`${id}-heading`}>
      <div className={styles.heading}>
        <h3 id={`${id}-heading`}>
          {isKorean ? "이미지에서 영역 지정" : "Mark areas on the image"}
        </h3>
        <p>
          {isKorean
            ? "첫 번째 상품의 글자를 항목별로 드래그하세요. 없는 항목은 없음으로 지정하고, 마지막 상품 아래에서 표 끝을 정하세요."
            : "Drag over the first product's text for each field. Mark missing fields as none, and set the table end below the last product."}
        </p>
      </div>
      {!file ? (
        <p className={styles.warning}>
          {isKorean
            ? "영역을 지정하려면 인식에 사용한 이미지를 선택해 주세요."
            : "Select the image used for recognition to mark areas."}
        </p>
      ) : (
        <>
          <OcrRegionStepControls
            locale={locale}
            isKorean={isKorean}
            id={id}
            draft={draft}
            mode={mode}
            setMode={setMode}
            setPan={setPan}
            locked={locked}
            ready={ready}
            updateDraft={updateDraft}
            chooseMode={chooseMode}
            skipField={skipField}
            cancelPointer={cancelPointer}
          />
          <OcrRegionImageToolbar
            locale={locale}
            isKorean={isKorean}
            id={id}
            zoom={zoom}
            setZoom={setZoom}
            pan={pan}
            setPan={setPan}
            locked={locked}
            ready={ready}
            setKeyboardActive={setKeyboardActive}
            cancelPointer={cancelPointer}
          />
          <div className={styles.imageFrame}>
            <div
              className={styles.imageSurface}
              style={{ width: `${zoom * 100}%` }}
              data-pan={pan}
              tabIndex={ready && !locked ? 0 : -1}
              role="group"
              aria-label={isKorean ? "이미지 영역 선택" : "Image area selection"}
              aria-describedby={`${id}-instruction ${id}-keyboard`}
              onPointerDown={pointerDown}
              onPointerMove={pointerMove}
              onPointerUp={pointerUp}
              onPointerCancel={cancelPointer}
              onLostPointerCapture={cancelPointer}
              onKeyDown={keyboardSelection}
            >
              {/* object URL로 로컬 이미지 픽셀을 그대로 쓰고, 좌표 계산에 실제 img 요소의 사각형이 필요합니다. */}
              {/* eslint-disable-next-line @next/next/no-img-element */}
              <img
                ref={imageRef}
                alt={
                  isKorean
                    ? "입고표 영역 지정 이미지"
                    : "Receiving sheet image for area mapping"
                }
                draggable={false}
                onLoad={(event) => {
                  const image = event.currentTarget;
                  if (!file || image.src !== imageUrlRef.current) return;
                  const nextSize = {
                    width: image.naturalWidth,
                    height: image.naturalHeight,
                  };
                  if (
                    nextSize.width < 1 ||
                    nextSize.height < 1 ||
                    nextSize.width > 16384 ||
                    nextSize.height > 16384 ||
                    nextSize.width * nextSize.height > 40_000_000
                  ) {
                    setNotice({
                      ko: "이 이미지는 영역 지정 크기 제한을 넘습니다. 가로·세로 16,384픽셀 이하, 4천만 픽셀 이하 이미지를 선택해 주세요.",
                      en: "This image exceeds the area mapping size limit. Select an image up to 16,384 pixels on each side and 40 million pixels in total.",
                    });
                    return;
                  }
                  setLoaded({ file, size: nextSize });
                  if (loaded && loaded.file !== file) {
                    updateDraft(emptyDraft());
                    setMode("productName");
                    setPan(false);
                    setBusy(false);
                    requestPending.current = false;
                  } else if (analysis?.mapping?.schemaVersion === 2) {
                    const storedImage = analysis.mapping.image;
                    const storedAspect = storedImage.width / storedImage.height;
                    const currentAspect = nextSize.width / nextSize.height;
                    if (Math.abs(storedAspect - currentAspect) / storedAspect > 0.03) {
                      updateDraft(emptyDraft(), {
                        ko: "이미지 비율이 이전 영역 지정과 맞지 않습니다. 첫 상품과 표 끝을 다시 지정해 주세요.",
                        en: "The image ratio does not match the previous area mapping. Mark the first product and table end again.",
                      });
                      setMode("productName");
                    }
                  }
                }}
                onError={() => {
                  setLoaded(null);
                  setNotice({
                    ko: "이미지를 표시하지 못했습니다. 다른 이미지를 선택해 주세요.",
                    en: "Could not display the image. Select a different image.",
                  });
                }}
              />
              <OcrRegionOverlay
                locale={locale}
                isKorean={isKorean}
                draft={draft}
                mode={mode}
                drag={drag}
                cursor={cursor}
                keyboardActive={keyboardActive}
                activeRect={activeRect}
              />
            </div>
          </div>
          <OcrRegionConfirmation
            locale={locale}
            isKorean={isKorean}
            draft={draft}
            busy={busy}
            locked={locked}
            allFieldsChosen={allFieldsChosen}
            mappingValid={mappingValid}
            previewCurrent={previewCurrent}
            sourceUnavailable={sourceUnavailable}
            updateDraft={updateDraft}
            remap={remap}
          />
        </>
      )}
      {preview && previewCurrent && (
        <OcrRegionPreview
          locale={locale}
          isKorean={isKorean}
          preview={preview}
          previewTotal={previewTotal}
          previewUnknown={previewUnknown}
        />
      )}
      <OcrRegionTemplates
        locale={locale}
        isKorean={isKorean}
        id={id}
        templates={templates}
        selectedTemplateId={selectedTemplateId}
        setSelectedTemplateId={setSelectedTemplateId}
        size={size}
        locked={locked}
        ready={ready}
        mappingValid={mappingValid}
        loadTemplates={loadTemplates}
        saveTemplate={saveTemplate}
        reuseTemplate={reuseTemplate}
        deleteTemplate={deleteTemplate}
        resetTemplates={resetTemplates}
      />
      <p className={styles.notice} role="status" aria-live="polite">
        {typeof notice === "string" ? notice : notice[locale]}
      </p>
    </section>
  );
}
