// 역할: OCR 매핑 템플릿 검사의 메모리 저장소와 열·영역 템플릿·저장 봉투 데이터를 제공함.
import { vi } from "vitest";
import {
  OCR_MAPPING_TEMPLATES_STORAGE_KEY,
  type OcrMappingTemplate,
  type OcrMappingTemplateStorage,
} from "../lib/admin-ui/ocr-mapping-templates";
import type {
  OcrColumnMapping,
  OcrRegionMapping,
} from "../infra/lambda/ocr-table-parser.js";

export function storageFixture(initial?: string): OcrMappingTemplateStorage {
  const values = new Map<string, string>();
  if (initial !== undefined) values.set(OCR_MAPPING_TEMPLATES_STORAGE_KEY, initial);
  return {
    getItem: vi.fn((key) => values.get(key) ?? null),
    setItem: vi.fn((key, value) => void values.set(key, value)),
    removeItem: vi.fn((key) => void values.delete(key)),
  };
}

export function template(
  id = "template-1",
): OcrMappingTemplate & { mapping: OcrColumnMapping } {
  return {
    id,
    name: "양식 1",
    layout: { roles: ["ignore", "productInfo", "quantity"] },
    mapping: {
      schemaVersion: 1,
      headerRow: 0,
      columns: { productName: 1, brand: null, option: null, quantity: 2 },
      productInfo: { productNameLine: 0, brandLine: 1, optionLine: null },
    },
  };
}

export function regionTemplate(
  id = "region-1",
): OcrMappingTemplate & { mapping: OcrRegionMapping } {
  return {
    id,
    name: "양식 2",
    layout: { roles: ["productName", "brand", "option", "quantity"] },
    mapping: {
      schemaVersion: 2,
      parserVersion: 1,
      kind: "regions",
      image: { width: 1200, height: 800 },
      firstRow: {
        productName: { left: 0.1, top: 0.2, right: 0.4, bottom: 0.25 },
        brand: { left: 0.5, top: 0.2, right: 0.6, bottom: 0.25 },
        option: { left: 0.7, top: 0.2, right: 0.8, bottom: 0.25 },
        quantity: { left: 0.9, top: 0.2, right: 0.95, bottom: 0.25 },
      },
      tableBottom: 0.9,
      secondRowY: 0.35,
      quantityConfirmed: true,
    },
  };
}

export const envelope = (templates: unknown[], schemaVersion = 1) =>
  JSON.stringify({ schemaVersion, templates });
