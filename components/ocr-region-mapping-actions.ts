import type { Dispatch, RefObject, SetStateAction } from "react";
import { isOcrRegionMapping } from "../infra/lambda/ocr-table-parser.js";
import type { AdminOcrRemapPreview, OcrRegionMapping } from "@/lib/admin-ui/types";
import { rectsOverlap, selectionFromPoints } from "@/lib/admin-ui/ocr-region-selection";
import {
  deleteOcrMappingTemplate,
  isOcrRegionTemplateReusable,
  loadOcrMappingTemplates,
  ocrMappingTemplateErrorMessage,
  resetOcrMappingTemplates,
  saveOcrMappingTemplate,
  type OcrMappingTemplate,
  type OcrMappingTemplatesResult,
} from "@/lib/admin-ui/ocr-mapping-templates";
import type { OcrRegionMappingProps } from "./ocr-region-mapping";
import {
  FIELDS,
  FIELD_LABELS,
  templateDisplayName,
  type Draft,
  type Field,
  type Mode,
  type Notice,
  type Point,
  type Size,
} from "./ocr-region-mapping-model";

export function useOcrSelectionActions({
  size,
  locked,
  mode,
  draft,
  setNotice,
  updateDraft,
  advance,
}: Readonly<{
  size: Size | null;
  locked: boolean;
  mode: Mode;
  draft: Draft;
  setNotice: Dispatch<SetStateAction<Notice>>;
  updateDraft: (next: Draft, message?: Notice) => void;
  advance: (field: Field) => void;
}>) {
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
  return { completeSelection };
}

export function useOcrRemapAction({
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
}: Readonly<{
  isKorean: boolean;
  jobId: string;
  version: number;
  onRemap: OcrRegionMappingProps["onRemap"];
  requestSerial: RefObject<number>;
  requestPending: RefObject<boolean>;
  setBusy: Dispatch<SetStateAction<boolean>>;
  setNotice: Dispatch<SetStateAction<Notice>>;
  setPreview: Dispatch<
    SetStateAction<{ key: string; result: AdminOcrRemapPreview } | null>
  >;
  locked: boolean;
  mapping: OcrRegionMapping | null;
  mappingValid: boolean;
  mappingKey: string;
  previewCurrent: boolean;
  sourceUnavailable: boolean;
}>) {
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
  return { remap };
}

export function useOcrTemplateActions({
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
}: Readonly<{
  isKorean: boolean;
  draft: Draft;
  setMode: Dispatch<SetStateAction<Mode>>;
  setPan: Dispatch<SetStateAction<boolean>>;
  setNotice: Dispatch<SetStateAction<Notice>>;
  templates: readonly OcrMappingTemplate[];
  setTemplates: Dispatch<SetStateAction<readonly OcrMappingTemplate[]>>;
  selectedTemplateId: string;
  setSelectedTemplateId: Dispatch<SetStateAction<string>>;
  size: Size | null;
  mapping: OcrRegionMapping | null;
  mappingValid: boolean;
  updateDraft: (next: Draft, message?: Notice) => void;
  cancelPointer: () => void;
}>) {
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
      setNotice({
        ko: result.error.message,
        en: ocrMappingTemplateErrorMessage(result.error.code, "en"),
      });
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
      setNotice({
        ko: loadedTemplates.error.message,
        en: ocrMappingTemplateErrorMessage(loadedTemplates.error.code, "en"),
      });
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
  return { loadTemplates, saveTemplate, reuseTemplate, deleteTemplate, resetTemplates };
}
