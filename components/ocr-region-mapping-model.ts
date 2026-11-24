import type { CSSProperties } from "react";
import type { Locale } from "@/types/store";
import { isOcrRegionMapping } from "../infra/lambda/ocr-table-parser.js";
import type { OcrTableAnalysis } from "@/lib/admin-ui/types";

export type Rect = Readonly<{
  left: number;
  top: number;
  right: number;
  bottom: number;
}>;
export type Point = Readonly<{ x: number; y: number }>;
export type Size = Readonly<{ width: number; height: number }>;
export type Field = "productName" | "brand" | "option" | "quantity";
export type Mode = Field | "tableBottom" | "secondRow";
export type Draft = Readonly<{
  firstRow: Readonly<Record<Field, Rect | null | undefined>>;
  tableBottom: number | null;
  secondRowY: number | null;
  quantityConfirmed: boolean;
}>;
export const FIELDS = ["productName", "brand", "option", "quantity"] as const;
export const FIELD_LABELS: Record<Locale, Record<Field, string>> = {
  ko: { productName: "상품명", brand: "브랜드", option: "옵션", quantity: "수량" },
  en: {
    productName: "Product name",
    brand: "Brand",
    option: "Option",
    quantity: "Quantity",
  },
};
export const MODE_LABELS: Record<Locale, Record<Mode, string>> = {
  ko: { ...FIELD_LABELS.ko, tableBottom: "표 끝", secondRow: "두 번째 상품 위치" },
  en: {
    ...FIELD_LABELS.en,
    tableBottom: "Table end",
    secondRow: "Second product position",
  },
};
export const WARNING_LABELS: Record<string, Readonly<Record<Locale, string>>> = {
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
export type Notice = string | Readonly<Record<Locale, string>>;

/** 저장 이름 `양식 N`은 그대로 두고 영어 화면에서만 `Template N`으로 보여 줍니다. */
export function templateDisplayName(name: string, locale: Locale) {
  const match = /^양식 ([1-9][0-9]?)$/u.exec(name);
  return locale === "en" && match ? `Template ${match[1]}` : name;
}

export function emptyDraft(): Draft {
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

export function draftFromAnalysis(analysis: OcrTableAnalysis | undefined): Draft {
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

export function rectStyle(rect: Rect): CSSProperties {
  return {
    left: `${rect.left * 100}%`,
    top: `${rect.top * 100}%`,
    width: `${(rect.right - rect.left) * 100}%`,
    height: `${(rect.bottom - rect.top) * 100}%`,
  };
}
