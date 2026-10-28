import {
  isOcrColumnMapping,
  isOcrRegionMapping,
  type OcrColumnMapping,
  type OcrMapping,
  type OcrRegionMapping,
  type OcrRegionRect,
} from "../../infra/lambda/ocr-table-parser.js";
import type { Locale } from "@/types/store";

/** 운영자가 명시적으로 저장한 열 설정만 보관하는 버전별 키임. */
export const OCR_MAPPING_TEMPLATES_STORAGE_KEY = "paradays.ocr.column-templates.v1";

const MAX_TEMPLATES = 20;
const MAX_SERIALIZED_LENGTH = 32_768;
const SAFE_ID = /^[A-Za-z0-9][A-Za-z0-9_-]{0,79}$/u;
const SAFE_NAME = /^양식 [1-9][0-9]?$/u;
const COLUMN_ROLES = [
  "productName",
  "productInfo",
  "brand",
  "option",
  "quantity",
  "price",
  "ignore",
  "unknown",
] as const;

export type OcrMappingTemplateColumnRole = (typeof COLUMN_ROLES)[number];

/** 헤더 원문 없이 열 개수와 역할 순서만 보관하는 구조 지문임. */
export type OcrMappingTemplateLayout = Readonly<{
  roles: readonly OcrMappingTemplateColumnRole[];
}>;

/** 브라우저 저장소를 자동으로 조회하지 않도록 호출자가 전달하는 계약임. */
export type OcrMappingTemplateStorage = Pick<
  Storage,
  "getItem" | "setItem" | "removeItem"
>;

export type OcrMappingTemplate = Readonly<{
  id: string;
  name: string;
  mapping: OcrMapping;
  layout: OcrMappingTemplateLayout;
}>;

export type OcrMappingTemplatesErrorCode =
  | "invalid-data"
  | "invalid-template"
  | "unsupported-version"
  | "limit-reached"
  | "storage-unavailable"
  | "storage-quota";

export type OcrMappingTemplatesResult<T> =
  | { ok: true; value: T }
  | {
      ok: false;
      error: { code: OcrMappingTemplatesErrorCode; message: string };
    };

const ERROR_MESSAGES: Record<OcrMappingTemplatesErrorCode, Record<Locale, string>> = {
  "invalid-data": {
    ko: "저장된 열 템플릿을 읽을 수 없습니다. 초기화 후 다시 저장해 주세요.",
    en: "Cannot read the saved column templates. Reset them and save again.",
  },
  "invalid-template": {
    ko: "템플릿 이름과 열 설정을 확인해 주세요.",
    en: "Check the template name and column settings.",
  },
  "unsupported-version": {
    ko: "지원하지 않는 열 템플릿 버전입니다.",
    en: "This column template version is not supported.",
  },
  "limit-reached": {
    ko: "열 템플릿은 최대 20개까지 저장할 수 있습니다.",
    en: "You can save up to 20 column templates.",
  },
  "storage-unavailable": {
    ko: "이 브라우저에서 열 템플릿 저장소를 사용할 수 없습니다.",
    en: "Column template storage is not available in this browser.",
  },
  "storage-quota": {
    ko: "브라우저 저장 공간이 부족해 열 템플릿을 저장하지 못했습니다.",
    en: "Could not save the column template because browser storage is full.",
  },
};

export function ocrMappingTemplateErrorMessage(
  code: OcrMappingTemplatesErrorCode,
  locale: Locale = "ko",
): string {
  return ERROR_MESSAGES[code][locale];
}

function failure<T>(code: OcrMappingTemplatesErrorCode): OcrMappingTemplatesResult<T> {
  return { ok: false, error: { code, message: ocrMappingTemplateErrorMessage(code) } };
}

/** 알 수 없는 필드와 접근자를 거부해 원문·비밀값의 직렬화를 차단함. */
function hasExactKeys(
  value: unknown,
  required: readonly string[],
  optional: readonly string[] = [],
): value is Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) return false;
  const keys = Reflect.ownKeys(value);
  return (
    required.every((key) => Object.hasOwn(value, key)) &&
    keys.every(
      (key) =>
        typeof key === "string" &&
        (required.includes(key) || optional.includes(key)) &&
        "value" in Object.getOwnPropertyDescriptor(value, key)!,
    )
  );
}

/** 공유 검증을 통과한 설정도 허용된 숫자 필드만 새 객체로 복제함. */
function cloneColumnMapping(value: unknown): OcrColumnMapping | undefined {
  if (
    !hasExactKeys(value, ["schemaVersion", "headerRow", "columns"], ["productInfo"]) ||
    !hasExactKeys(value.columns, ["productName", "brand", "option", "quantity"]) ||
    (Object.hasOwn(value, "productInfo") &&
      !hasExactKeys(value.productInfo, [
        "productNameLine",
        "brandLine",
        "optionLine",
      ])) ||
    !isOcrColumnMapping(value)
  ) {
    return undefined;
  }

  return {
    schemaVersion: 1,
    headerRow: value.headerRow,
    columns: {
      productName: value.columns.productName,
      brand: value.columns.brand,
      option: value.columns.option,
      quantity: value.columns.quantity,
    },
    ...(value.productInfo
      ? {
          productInfo: {
            productNameLine: value.productInfo.productNameLine,
            brandLine: value.productInfo.brandLine,
            optionLine: value.productInfo.optionLine,
          },
        }
      : {}),
  };
}

/** 이미지 치수는 좌표 설정용 숫자임. 이미지 bytes·URL·파일 정보는 보관하지 않음. */
function cloneRegionMapping(value: unknown): OcrRegionMapping | undefined {
  if (
    !hasExactKeys(value, [
      "schemaVersion",
      "parserVersion",
      "kind",
      "image",
      "firstRow",
      "tableBottom",
      "secondRowY",
      "quantityConfirmed",
    ]) ||
    !hasExactKeys(value.image, ["width", "height"]) ||
    !hasExactKeys(value.firstRow, ["productName", "brand", "option", "quantity"]) ||
    Object.values(value.firstRow).some(
      (rect) =>
        rect !== null && !hasExactKeys(rect, ["left", "top", "right", "bottom"]),
    ) ||
    !isOcrRegionMapping(value)
  )
    return undefined;

  const cloneRect = (rect: OcrRegionRect): OcrRegionRect => ({
    left: rect.left,
    top: rect.top,
    right: rect.right,
    bottom: rect.bottom,
  });
  return {
    schemaVersion: 2,
    parserVersion: 1,
    kind: "regions",
    image: { width: value.image.width, height: value.image.height },
    firstRow: {
      productName: cloneRect(value.firstRow.productName),
      brand: value.firstRow.brand === null ? null : cloneRect(value.firstRow.brand),
      option: value.firstRow.option === null ? null : cloneRect(value.firstRow.option),
      quantity:
        value.firstRow.quantity === null ? null : cloneRect(value.firstRow.quantity),
    },
    tableBottom: value.tableBottom,
    secondRowY: value.secondRowY,
    quantityConfirmed: value.quantityConfirmed,
  };
}

function cloneMapping(value: unknown): OcrMapping | undefined {
  return cloneColumnMapping(value) ?? cloneRegionMapping(value);
}

/** 역할 배열의 추가 속성·빈 칸·접근자도 거부하고 허용된 열거값만 복제함. */
function cloneRoles(value: unknown): OcrMappingTemplateColumnRole[] | undefined {
  if (
    !Array.isArray(value) ||
    Object.getPrototypeOf(value) !== Array.prototype ||
    value.length === 0 ||
    value.length > 20
  )
    return undefined;
  const keys = Reflect.ownKeys(value);
  if (
    keys.length !== value.length + 1 ||
    keys.some(
      (key) =>
        key !== "length" &&
        (typeof key !== "string" ||
          !/^(0|[1-9][0-9]*)$/u.test(key) ||
          Number(key) >= value.length),
    )
  )
    return undefined;
  const roles: OcrMappingTemplateColumnRole[] = [];
  for (let index = 0; index < value.length; index += 1) {
    const descriptor = Object.getOwnPropertyDescriptor(value, String(index));
    if (
      !descriptor ||
      !("value" in descriptor) ||
      !COLUMN_ROLES.includes(descriptor.value)
    )
      return undefined;
    roles.push(descriptor.value as OcrMappingTemplateColumnRole);
  }
  return roles;
}

function cloneTemplate(value: unknown): OcrMappingTemplate | undefined {
  if (!hasExactKeys(value, ["id", "name", "mapping", "layout"])) return undefined;
  if (typeof value.id !== "string" || !SAFE_ID.test(value.id)) return undefined;
  // 첫 버전은 이름에 고객·주문 정보가 들어가지 않도록 고정 이름만 허용함.
  if (typeof value.name !== "string" || !SAFE_NAME.test(value.name)) {
    return undefined;
  }
  const mapping = cloneMapping(value.mapping);
  if (!mapping || !hasExactKeys(value.layout, ["roles"])) return undefined;
  const roles = cloneRoles(value.layout.roles);
  if (!roles) return undefined;
  if (mapping.schemaVersion === 1) {
    if (
      Object.values(mapping.columns).some(
        (index) => index !== null && index >= roles.length,
      )
    )
      return undefined;
  } else {
    // 영역 지문은 선택한 첫 상품의 네 역할만 반영하며 헤더 원문은 받지 않음.
    const regionRoles = [
      "productName",
      mapping.firstRow.brand === null ? "ignore" : "brand",
      mapping.firstRow.option === null ? "ignore" : "option",
      mapping.firstRow.quantity === null ? "ignore" : "quantity",
    ];
    if (roles.length !== 4 || roles.some((role, index) => role !== regionRoles[index]))
      return undefined;
  }
  return { id: value.id, name: value.name, mapping, layout: { roles } };
}

/** 미확인 열이 없고 역할 순서가 같을 때만 구조상 재사용 가능하다고 판단함. */
export function isOcrMappingTemplateLayoutReusable(
  input: OcrMappingTemplate,
  currentRoles: readonly OcrMappingTemplateColumnRole[],
): boolean {
  try {
    const template = cloneTemplate(input);
    const roles = cloneRoles(currentRoles);
    return Boolean(
      template &&
        template.mapping.schemaVersion === 1 &&
        roles &&
        !roles.includes("unknown") &&
        !template.layout.roles.includes("unknown") &&
        template.layout.roles.length === roles.length &&
        template.layout.roles.every((role, index) => role === roles[index]),
    );
  } catch {
    return false;
  }
}

/** 종횡비가 맞는 영역 양식만 재지정 후보로 허용함. 미리보기·적용은 별도로 필요함. */
export function isOcrRegionTemplateReusable(
  input: OcrMappingTemplate,
  naturalSize: Readonly<{ width: number; height: number }>,
): boolean {
  try {
    const template = cloneTemplate(input);
    if (!template || template.mapping.schemaVersion !== 2) return false;
    const { width, height } = naturalSize;
    if (
      !Number.isInteger(width) ||
      !Number.isInteger(height) ||
      width < 1 ||
      height < 1 ||
      width > 16_384 ||
      height > 16_384 ||
      width * height > 40_000_000
    )
      return false;
    const savedAspect = template.mapping.image.width / template.mapping.image.height;
    return Math.abs(width / height - savedAspect) <= 0.03 * savedAspect;
  } catch {
    return false;
  }
}

function storageFailure<T>(error: unknown): OcrMappingTemplatesResult<T> {
  // 예외 문구에는 브라우저 정보가 있을 수 있으므로 고정 안내만 반환함.
  let name: unknown;
  try {
    name =
      error && typeof error === "object" && "name" in error ? error.name : undefined;
  } catch {
    return failure("storage-unavailable");
  }
  return failure(
    name === "QuotaExceededError" || name === "NS_ERROR_DOM_QUOTA_REACHED"
      ? "storage-quota"
      : "storage-unavailable",
  );
}

/** 저장소 또는 직렬화 문자열을 읽으며 손상된 값을 자동으로 덮어쓰지 않음. */
export function loadOcrMappingTemplates(
  source: OcrMappingTemplateStorage | string | null,
): OcrMappingTemplatesResult<OcrMappingTemplate[]> {
  let serialized: unknown;
  try {
    serialized =
      typeof source === "string" || source === null
        ? source
        : source.getItem(OCR_MAPPING_TEMPLATES_STORAGE_KEY);
  } catch (error) {
    return storageFailure(error);
  }
  if (serialized === null) return { ok: true, value: [] };
  if (typeof serialized !== "string" || serialized.length > MAX_SERIALIZED_LENGTH) {
    return failure("invalid-data");
  }

  try {
    const envelope: unknown = JSON.parse(serialized);
    if (!hasExactKeys(envelope, ["schemaVersion", "templates"]))
      return failure("invalid-data");
    if (envelope.schemaVersion !== 1) return failure("unsupported-version");
    if (
      !Array.isArray(envelope.templates) ||
      envelope.templates.length > MAX_TEMPLATES
    ) {
      return failure("invalid-data");
    }
    const templates: OcrMappingTemplate[] = [];
    for (const candidate of envelope.templates) {
      const template = cloneTemplate(candidate);
      if (!template || templates.some((existing) => existing.id === template.id)) {
        return failure("invalid-data");
      }
      templates.push(template);
    }
    return { ok: true, value: templates };
  } catch {
    return failure("invalid-data");
  }
}

/** 검증·복제한 허용 필드만 직렬화하며 호출자 객체를 직접 직렬화하지 않음. */
function writeTemplates(
  storage: OcrMappingTemplateStorage,
  templates: OcrMappingTemplate[],
): OcrMappingTemplatesResult<OcrMappingTemplate[]> {
  const serialized = JSON.stringify({ schemaVersion: 1, templates });
  if (serialized.length > MAX_SERIALIZED_LENGTH) return failure("invalid-data");
  try {
    storage.setItem(OCR_MAPPING_TEMPLATES_STORAGE_KEY, serialized);
    return { ok: true, value: templates };
  } catch (error) {
    return storageFailure(error);
  }
}

/** 같은 ID는 교체하며 새 ID는 최대 20개까지 명시적으로 저장함. */
export function saveOcrMappingTemplate(
  storage: OcrMappingTemplateStorage,
  input: OcrMappingTemplate,
): OcrMappingTemplatesResult<OcrMappingTemplate[]> {
  let template: OcrMappingTemplate | undefined;
  try {
    template = cloneTemplate(input);
  } catch {
    return failure("invalid-template");
  }
  if (!template) return failure("invalid-template");
  const loaded = loadOcrMappingTemplates(storage);
  if (!loaded.ok) return loaded;
  const index = loaded.value.findIndex((existing) => existing.id === template.id);
  if (index === -1 && loaded.value.length >= MAX_TEMPLATES)
    return failure("limit-reached");
  const templates = [...loaded.value];
  if (index === -1) templates.push(template);
  else templates[index] = template;
  return writeTemplates(storage, templates);
}

/** 지정한 템플릿만 삭제하며 없는 ID는 저장소를 변경하지 않음. */
export function deleteOcrMappingTemplate(
  storage: OcrMappingTemplateStorage,
  id: string,
): OcrMappingTemplatesResult<OcrMappingTemplate[]> {
  if (typeof id !== "string" || !SAFE_ID.test(id)) return failure("invalid-template");
  const loaded = loadOcrMappingTemplates(storage);
  if (!loaded.ok) return loaded;
  const templates = loaded.value.filter((template) => template.id !== id);
  return templates.length === loaded.value.length
    ? loaded
    : writeTemplates(storage, templates);
}

/** 손상된 데이터도 포함해 해당 버전의 템플릿 키 하나만 명시적으로 초기화함. */
export function resetOcrMappingTemplates(
  storage: OcrMappingTemplateStorage,
): OcrMappingTemplatesResult<OcrMappingTemplate[]> {
  try {
    storage.removeItem(OCR_MAPPING_TEMPLATES_STORAGE_KEY);
    return { ok: true, value: [] };
  } catch (error) {
    return storageFailure(error);
  }
}
