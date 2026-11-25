// 역할: OCR 재고·입고 계획 검증에 쓰는 한도 상수와 값 형식 검사 도우미를 제공합니다.
import type { OcrInventoryMode } from "@/lib/admin-ui/ocr-inventory-commit";

export const MAX_STOCK = 1_000_000;
export const MAX_ROWS = 500;
const JOB_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{2,127}$/;
const PRODUCT_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{2,95}$/;

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
export function isMode(value: unknown): value is OcrInventoryMode {
  return value === "add" || value === "replace";
}
export function isText(value: unknown, maximum: number): value is string {
  return (
    typeof value === "string" &&
    value.trim().length > 0 &&
    value.length <= maximum &&
    !value.includes("\0")
  );
}
export function isJobId(value: unknown): value is string {
  return typeof value === "string" && JOB_ID.test(value);
}
export function isProductId(value: unknown): value is string {
  return typeof value === "string" && PRODUCT_ID.test(value);
}
export function isVersion(value: unknown): value is number {
  return (
    typeof value === "number" &&
    Number.isSafeInteger(value) &&
    value >= 1 &&
    value <= MAX_STOCK
  );
}
export function isStock(value: unknown): value is number {
  return (
    typeof value === "number" &&
    Number.isSafeInteger(value) &&
    value >= 0 &&
    value <= MAX_STOCK
  );
}
export function isQuantity(value: unknown, mode: OcrInventoryMode): value is number {
  return isStock(value) && (mode === "replace" || value > 0);
}
