// 역할: 관리자 매출 API 응답 값 검증 도우미와 전표 명령 요청 본문 생성을 담당합니다.
import type {
  SaleEntry,
  SaleLine,
  SalesCommand,
} from "../../infra/lambda/sales-ledger-domain";
import { AdminSalesError, validSalesDay } from "./admin-sales-api-client";

/** 브라우저 번들과 격리 테스트 복사본이 도메인에서 타입만 가져오도록 이 값은 여기에 따로 둡니다. */
export const SALE_METHODS = [
  "CARD",
  "CASH",
  "TRANSFER",
] as const satisfies readonly SaleEntry["method"][];

export const record = (v: unknown): v is Record<string, unknown> =>
  !!v && typeof v === "object" && !Array.isArray(v);
export const integer = (v: unknown, max = Number.MAX_SAFE_INTEGER): v is number =>
  typeof v === "number" && Number.isSafeInteger(v) && v >= 0 && v <= max;
export const signed = (v: unknown): v is number =>
  typeof v === "number" && Number.isSafeInteger(v);
export const id = (v: unknown): v is string =>
  typeof v === "string" &&
  /^[A-Za-z0-9][A-Za-z0-9._-]{2,96}$/.test(v) &&
  !/^test/i.test(v);
export const text = (v: unknown, max: number): v is string =>
  typeof v === "string" && v.length <= max && !/[\u0000-\u001f\u007f]/.test(v);
export const time = (v: unknown): v is string =>
  typeof v === "string" &&
  /^\d{4}-\d\d-\d\dT\d\d:\d\d(?::\d\d(?:\.\d{1,9})?)?(?:Z|[+-]\d\d:\d\d)$/.test(v) &&
  Number.isFinite(Date.parse(v));
export const kstDay = (v: string) =>
  new Date(Date.parse(v) + 9 * 3_600_000).toISOString().slice(0, 10);
export const fingerprint = (v: unknown): v is string =>
  typeof v === "string" && /^[a-f0-9]{64}$/.test(v);
const exact = (v: Record<string, unknown>, fields: readonly string[]) =>
  Object.keys(v).length === fields.length && fields.every((k) => k in v);
export const invalid = (): never => {
  throw new AdminSalesError("SALES_RESPONSE_INVALID");
};
export function parseLine(v: unknown): SaleLine {
  if (
    !record(v) ||
    (v.productId !== null && !id(v.productId)) ||
    !text(v.name, 160) ||
    !text(v.option, 50) ||
    !integer(v.quantity, 10_000) ||
    !v.quantity ||
    !integer(v.unitAmount, 100_000_000)
  )
    return invalid();
  return {
    productId: v.productId,
    name: v.name,
    option: v.option,
    quantity: v.quantity,
    unitAmount: v.unitAmount,
  };
}
export function commandBody(command: SalesCommand, day: string) {
  const body = JSON.stringify(command),
    v: unknown = JSON.parse(body);
  const fail = () => {
    throw new AdminSalesError("SALES_COMMAND_INVALID", 400);
  };
  if (!record(v)) return fail();
  const version = () =>
    id(v.entryId) && integer(v.version, Number.MAX_SAFE_INTEGER - 1) && v.version > 0;
  const reason = () => text(v.reason, 300) && !!v.reason.trim();
  const soldAt = () =>
    time(v.soldAt) &&
    /(?:Z|\+09:00)$/.test(v.soldAt) &&
    kstDay(v.soldAt) === day &&
    Date.parse(v.soldAt) <= Date.now();
  if (v.action === "save") {
    if (
      !exact(v, [
        "action",
        "entryId",
        "expectedVersion",
        "soldAt",
        "method",
        "reference",
        "amount",
        "memo",
        "lines",
      ]) ||
      !id(v.entryId) ||
      !integer(v.expectedVersion, 98) ||
      !soldAt() ||
      !(SALE_METHODS as readonly string[]).includes(String(v.method)) ||
      !text(v.reference, 64) ||
      !/^[A-Za-z0-9][A-Za-z0-9._/-]{2,63}$/.test(v.reference) ||
      !integer(v.amount, 100_000_000) ||
      !v.amount ||
      !text(v.memo, 300) ||
      !Array.isArray(v.lines) ||
      v.lines.length > 20
    )
      return fail();
    for (const l of v.lines) {
      if (
        !record(l) ||
        !exact(l, ["productId", "name", "option", "quantity", "unitAmount"])
      )
        return fail();
      try {
        parseLine(l);
      } catch {
        return fail();
      }
    }
  } else if (v.action === "preview") {
    if (!exact(v, ["action", "entryId", "version"]) || !version()) return fail();
  } else if (v.action === "post") {
    if (
      !exact(v, ["action", "entryId", "version", "previewToken", "confirmed"]) ||
      !version() ||
      !fingerprint(v.previewToken) ||
      v.confirmed !== true
    )
      return fail();
  } else if (v.action === "void") {
    if (
      !exact(v, ["action", "entryId", "version", "reason"]) ||
      !version() ||
      !reason()
    )
      return fail();
  } else if (v.action === "reverse") {
    if (
      !exact(v, [
        "action",
        "entryId",
        "originalDay",
        "originalId",
        "soldAt",
        "reason",
        "restockInspected",
        "confirmed",
      ]) ||
      !id(v.entryId) ||
      !validSalesDay(v.originalDay) ||
      !id(v.originalId) ||
      !soldAt() ||
      !reason() ||
      typeof v.restockInspected !== "boolean" ||
      v.confirmed !== true
    )
      return fail();
  } else if (v.action === "close") {
    if (
      !exact(v, [
        "action",
        "operationId",
        "expectedVersion",
        "onlineFingerprint",
        "cashComparedAmount",
        "confirmed",
      ]) ||
      !id(v.operationId) ||
      !integer(v.expectedVersion, Number.MAX_SAFE_INTEGER - 1) ||
      !fingerprint(v.onlineFingerprint) ||
      !signed(v.cashComparedAmount) ||
      v.confirmed !== true
    )
      return fail();
  } else if (v.action === "reopen") {
    if (
      !exact(v, ["action", "operationId", "expectedVersion", "reason"]) ||
      !id(v.operationId) ||
      !integer(v.expectedVersion, Number.MAX_SAFE_INTEGER - 1) ||
      !reason()
    )
      return fail();
  } else return fail();
  return body;
}
