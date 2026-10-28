"use client";

import {
  useEffect,
  useId,
  useRef,
  useState,
  type CSSProperties,
  type KeyboardEvent,
  type PointerEvent,
} from "react";
import { useLocale } from "@/contexts/locale-context";
import type { Locale } from "@/types/store";
import { isOcrRegionMapping } from "../infra/lambda/ocr-table-parser.js";
import type {
  AdminOcrRemapPreview,
  AdminOcrRemapResult,
  OcrMapping,
  OcrRegionMapping,
  OcrTableAnalysis,
} from "@/lib/admin-ui/types";
import {
  normalizeOcrPointer,
  rectsOverlap,
  selectionFromPoints,
} from "@/lib/admin-ui/ocr-region-selection";
import {
  deleteOcrMappingTemplate,
  isOcrRegionTemplateReusable,
  loadOcrMappingTemplates,
  resetOcrMappingTemplates,
  saveOcrMappingTemplate,
  type OcrMappingTemplate,
  type OcrMappingTemplatesResult,
} from "@/lib/admin-ui/ocr-mapping-templates";
import styles from "./ocr-region-mapping.module.css";

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

type Rect = Readonly<{
  left: number;
  top: number;
  right: number;
  bottom: number;
}>;
type Point = Readonly<{ x: number; y: number }>;
type Size = Readonly<{ width: number; height: number }>;
type Field = "productName" | "brand" | "option" | "quantity";
type Mode = Field | "tableBottom" | "secondRow";
type Draft = Readonly<{
  firstRow: Readonly<Record<Field, Rect | null | undefined>>;
  tableBottom: number | null;
  secondRowY: number | null;
  quantityConfirmed: boolean;
}>;
const FIELDS = ["productName", "brand", "option", "quantity"] as const;
const FIELD_LABELS: Record<Locale, Record<Field, string>> = {
  ko: { productName: "상품명", brand: "브랜드", option: "옵션", quantity: "수량" },
  en: {
    productName: "Product name",
    brand: "Brand",
    option: "Option",
    quantity: "Quantity",
  },
};
const MODE_LABELS: Record<Locale, Record<Mode, string>> = {
  ko: { ...FIELD_LABELS.ko, tableBottom: "표 끝", secondRow: "두 번째 상품 위치" },
  en: {
    ...FIELD_LABELS.en,
    tableBottom: "Table end",
    secondRow: "Second product position",
  },
};
const WARNING_LABELS: Record<string, Readonly<Record<Locale, string>>> = {
  "quantity-missing": {
    ko: "수량이 확인되지 않은 행이 있습니다.",
    en: "Some rows have no confirmed quantity.",
  },
  "empty-quantity": {
    ko: "수량이 확인되지 않은 행이 있습니다.",
    en: "Some rows have no confirmed quantity.",
  },
  "excluded-tokens": {
    ko: "선택한 표 밖의 글자는 상품 행에서 제외했습니다.",
    en: "Text outside the selected table was left out of the product rows.",
  },
  "region-excluded-tokens": {
    ko: "헤더·선택하지 않은 정보·표 밖의 글자는 원문에 보존하고 상품 행에서 제외했습니다.",
    en: "Headers, unselected information and text outside the table were kept in the source text and left out of the product rows.",
  },
  "row-stride-inferred": {
    ko: "상품 간격을 추정했습니다. 모든 행을 확인해 주세요.",
    en: "The product spacing was estimated. Check every row.",
  },
};

/** 처리 결과 문구는 두 언어를 함께 저장하고 화면에 그릴 때 현재 언어로 고릅니다. */
type Notice = string | Readonly<Record<Locale, string>>;

/** 저장 이름 `양식 N`은 그대로 두고 영어 화면에서만 `Template N`으로 보여 줍니다. */
function templateDisplayName(name: string, locale: Locale) {
  const match = /^양식 ([1-9][0-9]?)$/u.exec(name);
  return locale === "en" && match ? `Template ${match[1]}` : name;
}

function emptyDraft(): Draft {
  return {
    firstRow: {
      productName: undefined,
      brand: undefined,
      option: undefined,
      quantity: undefined,
    },
    tableBottom: null,
    secondRowY: null,
    quantityConfirmed: false,
  };
}

function draftFromAnalysis(analysis: OcrTableAnalysis | undefined): Draft {
  if (analysis?.mapping?.schemaVersion === 2 && isOcrRegionMapping(analysis.mapping)) {
    return {
      firstRow: analysis.mapping.firstRow,
      tableBottom: analysis.mapping.tableBottom,
      secondRowY: analysis.mapping.secondRowY,
      quantityConfirmed: analysis.mapping.quantityConfirmed,
    };
  }
  return emptyDraft();
}

function rectStyle(rect: Rect): CSSProperties {
  return {
    left: `${rect.left * 100}%`,
    top: `${rect.top * 100}%`,
    width: `${(rect.right - rect.left) * 100}%`,
    height: `${(rect.bottom - rect.top) * 100}%`,
  };
}

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

  function completeSelection(start: Point, end: Point) {
    if (!size || locked) return;
    if (mode === "tableBottom") {
      const bottom = Math.max(start.y, end.y);
      const firstBottom = Math.max(
        ...FIELDS.map((field) => draft.firstRow[field]?.bottom ?? 0),
      );
      if (!draft.firstRow.productName || bottom < firstBottom) {
        setNotice({
          ko: "표 끝은 첫 상품의 모든 선택 영역 아래에 지정해 주세요.",
          en: "Set the table end below every selected area of the first product.",
        });
        return;
      }
      updateDraft(
        { ...draft, tableBottom: bottom },
        {
          ko: "표 끝을 지정했습니다. 합계와 하단 안내 문구가 포함되지 않았는지 확인해 주세요.",
          en: "Set the table end. Check that totals and footer notes are not included.",
        },
      );
      return;
    }
    if (mode === "secondRow") {
      const y = (start.y + end.y) / 2;
      const first = draft.firstRow.productName;
      if (
        !first ||
        (start.x + end.x) / 2 < first.left ||
        (start.x + end.x) / 2 > first.right ||
        y <= first.bottom ||
        (draft.tableBottom !== null && y > draft.tableBottom)
      ) {
        setNotice({
          ko: "두 번째 상품명을 첫 상품명과 같은 열에서, 첫 상품 아래와 표 끝 사이에 지정해 주세요.",
          en: "Set the second product name in the same column as the first, between the first product and the table end.",
        });
        return;
      }
      updateDraft(
        { ...draft, secondRowY: y },
        {
          ko: "두 번째 상품 위치를 지정했습니다.",
          en: "Set the second product position.",
        },
      );
      return;
    }
    const rect = selectionFromPoints(start, end, size);
    if (!rect) {
      setNotice({
        ko: "글자를 포함하도록 영역을 조금 더 크게 드래그해 주세요.",
        en: "Drag a slightly larger area so it includes the text.",
      });
      return;
    }
    if (
      FIELDS.some(
        (field) =>
          field !== mode &&
          draft.firstRow[field] &&
          rectsOverlap(rect, draft.firstRow[field]!),
      )
    ) {
      setNotice({
        ko: "선택 영역이 다른 항목과 겹칩니다. 각각의 글자를 나누어 지정해 주세요.",
        en: "The selection overlaps another field. Set each piece of text separately.",
      });
      return;
    }
    const tableBottom =
      draft.tableBottom !== null && rect.bottom > draft.tableBottom
        ? null
        : draft.tableBottom;
    updateDraft(
      {
        ...draft,
        firstRow: { ...draft.firstRow, [mode]: rect },
        tableBottom,
        ...(mode === "quantity" ? { quantityConfirmed: false } : {}),
      },
      {
        ko: `${FIELD_LABELS.ko[mode]} 영역을 지정했습니다.`,
        en: `Set the ${FIELD_LABELS.en[mode]} area.`,
      },
    );
    advance(mode);
  }

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

  async function remap(previewOnly: boolean) {
    if (
      locked ||
      requestPending.current ||
      !mapping ||
      !mappingValid ||
      sourceUnavailable
    )
      return;
    if (
      !previewOnly &&
      (!previewCurrent ||
        !window.confirm(
          isKorean
            ? "현재 검토 행을 이 영역 지정 결과로 바꿀까요? 상품명·브랜드·옵션·수량의 기존 수정 내용이 바뀝니다."
            : "Replace the current review rows with this area result? Earlier edits to product name, brand, option and quantity will change.",
        ))
    )
      return;
    requestPending.current = true;
    const serial = ++requestSerial.current;
    setBusy(true);
    setNotice("");
    if (previewOnly) setPreview(null);
    try {
      const result = await onRemap(mapping, previewOnly);
      if (serial !== requestSerial.current) return;
      if (
        result?.kind === "preview" &&
        previewOnly &&
        result.preview.jobId === jobId &&
        result.preview.version === version
      ) {
        setPreview({ key: mappingKey, result: result.preview });
        setNotice({
          ko: "모든 상품 행과 수량, 제외된 글자를 확인한 뒤 적용해 주세요.",
          en: "Check every product row, quantity and excluded text, then apply.",
        });
      } else if (result?.kind === "saved" && !previewOnly) {
        setPreview(null);
        setNotice({ ko: "영역 지정을 적용했습니다.", en: "Applied the area mapping." });
      } else if (result?.kind === "conflict") {
        setPreview(null);
        setNotice({
          ko: "검토본이 변경되었습니다. 새 검토본에서 다시 미리보기를 확인해 주세요.",
          en: "The review changed. Check the preview again on the new review.",
        });
      } else {
        setPreview(null);
        setNotice({
          ko: "이 영역으로 상품 행을 만들지 못했습니다. 첫 상품, 표 끝과 반복 간격을 확인해 주세요.",
          en: "Could not make product rows from these areas. Check the first product, table end and repeat spacing.",
        });
      }
    } catch {
      if (serial === requestSerial.current) {
        setPreview(null);
        setNotice({
          ko: "이 영역으로 상품 행을 만들지 못했습니다. 첫 상품, 표 끝과 반복 간격을 확인해 주세요.",
          en: "Could not make product rows from these areas. Check the first product, table end and repeat spacing.",
        });
      }
    } finally {
      if (serial === requestSerial.current) {
        requestPending.current = false;
        setBusy(false);
      }
    }
  }

  function storage() {
    try {
      return window.localStorage;
    } catch {
      setNotice({
        ko: "이 브라우저에서 영역 양식 저장소를 사용할 수 없습니다.",
        en: "Template storage is not available in this browser.",
      });
      return undefined;
    }
  }

  function updateTemplates(
    result: OcrMappingTemplatesResult<OcrMappingTemplate[]>,
    message: Notice,
  ) {
    if (!result.ok) {
      setNotice(result.error.message);
      return false;
    }
    const regionTemplates = result.value.filter(
      (template) => template.mapping.schemaVersion === 2,
    );
    setTemplates(regionTemplates);
    if (!regionTemplates.some((template) => template.id === selectedTemplateId)) {
      setSelectedTemplateId("");
    }
    setNotice(message);
    return true;
  }

  function loadTemplates() {
    const target = storage();
    if (target) {
      updateTemplates(loadOcrMappingTemplates(target), {
        ko: "저장 영역 양식 목록을 불러왔습니다.",
        en: "Loaded the saved area templates.",
      });
    }
  }

  function saveTemplate() {
    if (!mapping || !mappingValid || !size || draft.tableBottom === null) return;
    const target = storage();
    if (!target) return;
    const loadedTemplates = loadOcrMappingTemplates(target);
    if (!loadedTemplates.ok) {
      setNotice(loadedTemplates.error.message);
      return;
    }
    const number = Array.from({ length: 99 }, (_, index) => index + 1).find(
      (index) =>
        !loadedTemplates.value.some((template) => template.name === `양식 ${index}`),
    );
    if (number === undefined) return;
    const template: OcrMappingTemplate = {
      id: `region-template-${window.crypto.randomUUID()}`,
      name: `양식 ${number}`,
      mapping,
      layout: {
        roles: [
          "productName",
          mapping.firstRow.brand ? "brand" : "ignore",
          mapping.firstRow.option ? "option" : "ignore",
          mapping.firstRow.quantity ? "quantity" : "ignore",
        ],
      },
    };
    if (
      updateTemplates(saveOcrMappingTemplate(target, template), {
        ko: `${template.name}의 영역 설정을 저장했습니다.`,
        en: `Saved the area settings of ${templateDisplayName(template.name, "en")}.`,
      })
    ) {
      setSelectedTemplateId(template.id);
    }
  }

  function reuseTemplate() {
    const template = templates.find((item) => item.id === selectedTemplateId);
    if (!template || template.mapping.schemaVersion !== 2 || !size) return;
    if (!isOcrRegionTemplateReusable(template, size)) {
      setNotice({
        ko: "이미지 비율이 저장된 영역 양식과 맞지 않아 재사용할 수 없습니다. 현재 영역 지정은 유지됩니다.",
        en: "The image ratio does not match the saved template, so it cannot be reused. The current areas are kept.",
      });
      return;
    }
    const resized = { ...template.mapping, image: size };
    if (!isOcrRegionMapping(resized)) {
      setNotice({
        ko: "이 이미지 크기에서는 저장된 영역을 사용할 수 없습니다. 현재 영역 지정은 유지됩니다.",
        en: "The saved areas cannot be used at this image size. The current areas are kept.",
      });
      return;
    }
    updateDraft(
      {
        firstRow: resized.firstRow,
        tableBottom: resized.tableBottom,
        secondRowY: resized.secondRowY,
        quantityConfirmed: false,
      },
      {
        ko: `${template.name}의 영역을 불러왔습니다. 영역과 표 끝을 이미지에 맞게 조정하고 수량을 다시 확인한 뒤 미리보기와 적용을 진행해 주세요.`,
        en: `Loaded the areas of ${templateDisplayName(template.name, "en")}. Adjust the areas and table end to the image, check the quantity again, then preview and apply.`,
      },
    );
    cancelPointer();
    setMode("productName");
    setPan(false);
  }

  function deleteTemplate() {
    const target = storage();
    if (target && selectedTemplateId) {
      updateTemplates(deleteOcrMappingTemplate(target, selectedTemplateId), {
        ko: "선택한 영역 양식을 삭제했습니다.",
        en: "Deleted the selected area template.",
      });
    }
  }

  function resetTemplates() {
    if (
      !window.confirm(
        isKorean
          ? "이 브라우저에 저장된 양식을 모두 삭제할까요?"
          : "Delete all templates saved in this browser?",
      )
    )
      return;
    const target = storage();
    if (target) {
      updateTemplates(resetOcrMappingTemplates(target), {
        ko: "이 브라우저의 저장 양식을 모두 삭제했습니다.",
        en: "Deleted all templates saved in this browser.",
      });
    }
  }

  return (
    <section className={styles.panel} aria-labelledby={`${id}-heading`}>
      <div className={styles.heading}>
        <h3 id={`${id}-heading`}>이미지에서 영역 지정</h3>
        <p>
          첫 번째 상품의 글자를 항목별로 드래그하세요. 없는 항목은 없음으로 지정하고,
          마지막 상품 아래에서 표 끝을 정하세요.
        </p>
      </div>
      {!file ? (
        <p className={styles.warning}>
          영역을 지정하려면 인식에 사용한 이미지를 선택해 주세요.
        </p>
      ) : (
        <>
          <fieldset className={styles.steps} disabled={locked || !ready}>
            <legend className={styles.srOnly}>첫 상품 영역 지정 순서</legend>
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
                    {index + 1}. {FIELD_LABELS[locale][field]}{" "}
                    {isKorean ? "영역" : "area"}
                  </span>
                  <small>
                    {draft.firstRow[field] === null
                      ? "없음"
                      : draft.firstRow[field]
                        ? "지정됨 · 다시 선택"
                        : "선택 필요"}
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
              aria-label="표 끝 지정"
              aria-pressed={mode === "tableBottom"}
              disabled={locked || !ready || !draft.firstRow.productName}
              onClick={() => chooseMode("tableBottom")}
            >
              표 끝 지정{draft.tableBottom !== null ? " · 지정됨" : ""}
            </button>
            <button
              type="button"
              className={styles.secondary}
              aria-label="두 번째 상품 위치"
              aria-pressed={mode === "secondRow"}
              disabled={locked || !ready || !draft.firstRow.productName}
              onClick={() => chooseMode("secondRow")}
            >
              두 번째 상품 위치{draft.secondRowY !== null ? " · 지정됨" : ""}
            </button>
            {draft.secondRowY !== null && (
              <button
                type="button"
                className={styles.textButton}
                disabled={locked}
                onClick={() => updateDraft({ ...draft, secondRowY: null })}
              >
                두 번째 상품 위치 지우기
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
              전체 영역 지우기
            </button>
          </div>
          <p className={styles.instruction} id={`${id}-instruction`}>
            {isKorean ? "현재 선택:" : "Selected:"}{" "}
            <strong>{MODE_LABELS[locale][mode]}</strong>
            {mode === "tableBottom"
              ? " · 마지막 상품 바로 아래를 클릭하거나 드래그하세요."
              : mode === "secondRow"
                ? " · 두 번째 상품의 중심을 클릭하거나 드래그하세요."
                : " · 첫 상품의 해당 글자를 둘러싸도록 드래그하세요."}
          </p>
          <p className={styles.help} id={`${id}-keyboard`}>
            키보드로는 이미지에 초점을 둔 뒤 방향키로 이동하고 Space로 시작, Enter로
            끝을 지정합니다. Shift와 방향키를 함께 누르면 더 크게 이동합니다.
          </p>
          <div className={styles.imageToolbar}>
            <label className={styles.field} htmlFor={`${id}-zoom`}>
              <span>이미지 확대 배율</span>
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
              이미지 이동
            </button>
            <p className={styles.help}>
              {pan
                ? "이동 모드입니다. 확대된 이미지를 스크롤하거나 손가락으로 이동하세요. 영역을 선택하려면 항목 버튼을 누르세요."
                : "작은 글자는 확대해서 선택하세요. 이미지 이동을 켜면 확대된 이미지를 스크롤할 수 있습니다."}
            </p>
          </div>
          <div className={styles.imageFrame}>
            <div
              className={styles.imageSurface}
              style={{ width: `${zoom * 100}%` }}
              data-pan={pan}
              tabIndex={ready && !locked ? 0 : -1}
              role="group"
              aria-label="이미지 영역 선택"
              aria-describedby={`${id}-instruction ${id}-keyboard`}
              onPointerDown={pointerDown}
              onPointerMove={pointerMove}
              onPointerUp={pointerUp}
              onPointerCancel={cancelPointer}
              onLostPointerCapture={cancelPointer}
              onKeyDown={keyboardSelection}
            >
              {/* Object URLs preserve local image pixels and need the native image rectangle. */}
              {/* eslint-disable-next-line @next/next/no-img-element */}
              <img
                ref={imageRef}
                alt="입고표 영역 지정 이미지"
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
                    setNotice(
                      "이 이미지는 영역 지정 크기 제한을 넘습니다. 가로·세로 16,384픽셀 이하, 4천만 픽셀 이하 이미지를 선택해 주세요.",
                    );
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
                      updateDraft(
                        emptyDraft(),
                        "이미지 비율이 이전 영역 지정과 맞지 않습니다. 첫 상품과 표 끝을 다시 지정해 주세요.",
                      );
                      setMode("productName");
                    }
                  }
                }}
                onError={() => {
                  setLoaded(null);
                  setNotice(
                    "이미지를 표시하지 못했습니다. 다른 이미지를 선택해 주세요.",
                  );
                }}
              />
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
                    <span>표 끝</span>
                  </div>
                )}
                {draft.secondRowY !== null && (
                  <div
                    className={styles.secondLine}
                    style={{ top: `${draft.secondRowY * 100}%` }}
                  >
                    <span>두 번째 상품</span>
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
            </div>
          </div>
          <fieldset className={styles.confirmation} disabled={locked}>
            <legend className={styles.srOnly}>수량 영역 확인</legend>
            <label>
              <input
                type="checkbox"
                checked={draft.quantityConfirmed}
                disabled={!draft.firstRow.quantity}
                onChange={(event) =>
                  updateDraft({ ...draft, quantityConfirmed: event.target.checked })
                }
              />
              선택한 수량 영역은 금액이 아닌 실제 수량입니다
            </label>
          </fieldset>
          {draft.firstRow.quantity === null && (
            <p className={styles.help}>
              수량 영역이 없으면 두 번째 상품 위치를 지정해 반복 간격을 알려 주세요.
              미리보기에서 모든 상품이 포함됐는지 확인하세요.
            </p>
          )}
          {!allFieldsChosen && (
            <p className={styles.help}>
              상품명·브랜드·옵션·수량을 모두 선택하거나 없는 항목을 없음으로 지정해
              주세요.
            </p>
          )}
          {allFieldsChosen && draft.tableBottom === null && (
            <p className={styles.help}>
              표 끝을 직접 지정해야 미리보기를 만들 수 있습니다.
            </p>
          )}
          {draft.firstRow.quantity && !draft.quantityConfirmed && (
            <p className={styles.warning}>
              선택한 영역이 실제 수량인지 확인해 주세요. 가격이나 상품 번호는 수량으로
              사용할 수 없습니다.
            </p>
          )}
          {sourceUnavailable && (
            <p className={styles.warning}>
              이전 검토본에 원본 인식 행이 없어 영역을 다시 지정할 수 없습니다.
            </p>
          )}
          <div className={styles.actions}>
            <button
              type="button"
              className={styles.secondary}
              disabled={locked || !mappingValid || sourceUnavailable}
              onClick={() => void remap(true)}
            >
              {busy ? "영역 확인 중…" : "영역 미리보기"}
            </button>
            <button
              type="button"
              className={styles.primary}
              disabled={locked || !mappingValid || !previewCurrent || sourceUnavailable}
              onClick={() => void remap(false)}
            >
              영역 지정 적용
            </button>
          </div>
        </>
      )}
      {preview && previewCurrent && (
        <div className={styles.preview}>
          <p className={styles.summary}>
            상품 {preview.result.rows.length}개 · 수량 합계{" "}
            {preview.result.rows
              .reduce((total, row) => total + Number(row.quantity || 0), 0)
              .toLocaleString("ko-KR")}
            개 · 수량 미확인{" "}
            {preview.result.rows.filter((row) => row.quantity === "").length}행
          </p>
          {preview.result.analysis.region && (
            <p className={styles.help}>
              원본 인식 항목 {preview.result.analysis.region.sourceTokenCount}개 중 포함{" "}
              {preview.result.analysis.region.includedTokenCount}개 · 제외{" "}
              {preview.result.analysis.region.excludedTokenCount}개
            </p>
          )}
          <p className={styles.warning}>
            미리보기의 상품 행과 수량을 원본 이미지와 비교해 주세요. 합계·금액·안내
            문구가 상품으로 들어가지 않았는지 확인해야 합니다.
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
            aria-label="영역 지정 미리보기 표"
          >
            <table>
              <caption>영역 지정 미리보기 · 읽기 전용</caption>
              <thead>
                <tr>
                  <th scope="col">상품명</th>
                  <th scope="col">브랜드</th>
                  <th scope="col">옵션</th>
                  <th scope="col">수량</th>
                </tr>
              </thead>
              <tbody>
                {preview.result.rows.map((row) => (
                  <tr key={row.id}>
                    <td>{row.productName || "—"}</td>
                    <td>{row.brand || "—"}</td>
                    <td>{row.option || "—"}</td>
                    <td>{row.quantity || "미확인"}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}
      <fieldset className={styles.templates} disabled={locked}>
        <legend>저장 영역 양식</legend>
        <p className={styles.help}>
          이 브라우저를 쓰는 계정들이 공유하는 설정입니다. 영역 좌표·이미지 크기·항목
          역할만 저장하며 이미지·원문·개인정보·인증 정보는 저장하지 않습니다. 불러온
          영역은 이미지에 맞게 확인하고 미리보기 후 직접 적용하세요.
        </p>
        <div className={styles.actions}>
          <button type="button" className={styles.secondary} onClick={loadTemplates}>
            영역 양식 불러오기
          </button>
          <button
            type="button"
            className={styles.secondary}
            disabled={!mappingValid || !ready}
            onClick={saveTemplate}
          >
            현재 영역 양식 저장
          </button>
        </div>
        <div className={styles.templateSelection}>
          <label className={styles.field} htmlFor={`${id}-template`}>
            <span>저장 영역 양식</span>
            <select
              id={`${id}-template`}
              value={selectedTemplateId}
              onChange={(event) => setSelectedTemplateId(event.target.value)}
            >
              <option value="">양식 선택</option>
              {templates.map((template) => (
                <option key={template.id} value={template.id}>
                  {template.name}
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
            영역 양식 재사용
          </button>
          <button
            type="button"
            className={styles.secondary}
            disabled={!selectedTemplateId}
            onClick={deleteTemplate}
          >
            선택 영역 양식 삭제
          </button>
          <button type="button" className={styles.textButton} onClick={resetTemplates}>
            전체 양식 삭제
          </button>
        </div>
      </fieldset>
      <p className={styles.notice} role="status" aria-live="polite">
        {typeof notice === "string" ? notice : notice[locale]}
      </p>
    </section>
  );
}
