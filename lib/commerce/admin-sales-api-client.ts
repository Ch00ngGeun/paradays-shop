// 역할: 허용된 관리자가 일자별 매출 장부를 조회하고 전표 명령을 보내는 관리자 매출 API 클라이언트입니다.
// 결제·고객 상세 정보는 이 클라이언트로 들어오지 않습니다.
import {
  getCheckoutApiConfig,
  type CheckoutApiConfig,
  type CheckoutAuthorizationTokenProvider,
} from "./checkout-api-client";
import type {
  DayReport,
  DaySnapshot,
  DayTotals,
  OnlineEvent,
  SaleEntry,
  SalesCommand,
  StockPreview,
} from "../../infra/lambda/sales-ledger-domain";
export type {
  DayReport,
  SaleEntry,
  SaleInput,
  SaleLine,
  SalesCommand,
  StockPreview,
} from "../../infra/lambda/sales-ledger-domain";

import {
  SALE_METHODS,
  commandBody,
  fingerprint,
  id,
  integer,
  invalid,
  kstDay,
  parseLine,
  record,
  signed,
  text,
  time,
} from "./admin-sales-api-client-validation";

export type AdminSalesResult =
  | { entry: SaleEntry }
  | {
      preview: readonly StockPreview[];
      previewToken: string;
      entryId: string;
      version: number;
    }
  | { report: DayReport };
export class AdminSalesError extends Error {
  constructor(
    readonly code: string,
    readonly status: number | null = null,
    readonly resultUncertain = false,
  ) {
    super(code);
  }
}
export const validSalesDay = (v: unknown): v is string =>
  typeof v === "string" &&
  /^20\d\d-\d\d-\d\d$/.test(v) &&
  Number.isFinite(Date.parse(`${v}T00:00:00+09:00`)) &&
  kstDay(`${v}T00:00:00+09:00`) === v;
export function parseSalesEntry(v: unknown, day: string): SaleEntry {
  if (
    !record(v) ||
    v.businessDay !== day ||
    v.recordType !== "SALE" ||
    !id(v.entryId) ||
    !integer(v.version, Number.MAX_SAFE_INTEGER - 1) ||
    !v.version ||
    !["DRAFT", "POSTED", "VOID"].includes(String(v.status)) ||
    !["SALE", "REVERSAL"].includes(String(v.kind)) ||
    !time(v.soldAt) ||
    kstDay(v.soldAt) !== day ||
    !(SALE_METHODS as readonly string[]).includes(String(v.method)) ||
    !text(v.reference, 64) ||
    !/^[A-Za-z0-9][A-Za-z0-9._/-]{2,63}$/.test(v.reference) ||
    !integer(v.amount, 100_000_000) ||
    !v.amount ||
    !text(v.memo, 300) ||
    !Array.isArray(v.lines) ||
    v.lines.length > 20 ||
    !time(v.createdAt) ||
    !time(v.updatedAt)
  )
    return invalid();
  const lines = v.lines.map(parseLine);
  let original: SaleEntry["original"];
  if (v.kind === "REVERSAL") {
    if (
      v.status !== "POSTED" ||
      !record(v.original) ||
      !validSalesDay(v.original.businessDay) ||
      !id(v.original.entryId) ||
      typeof v.restocked !== "boolean"
    )
      return invalid();
    original = { businessDay: v.original.businessDay, entryId: v.original.entryId };
  }
  return {
    businessDay: day,
    recordType: "SALE",
    entryId: v.entryId,
    version: v.version,
    status: v.status as SaleEntry["status"],
    kind: v.kind as SaleEntry["kind"],
    soldAt: v.soldAt,
    method: v.method as SaleEntry["method"],
    reference: v.reference,
    amount: v.amount,
    memo: v.memo,
    lines,
    createdAt: v.createdAt,
    updatedAt: v.updatedAt,
    ...(original ? { original, restocked: v.restocked as boolean } : {}),
  };
}
const totalKeys = [
  "card",
  "cash",
  "offlineRefunds",
  "offlineNet",
  "onlineGross",
  "onlineRefunds",
  "onlineNet",
  "combinedNet",
] as const;
/** 계좌이체 도입 전 서버·스냅샷은 `transfer`를 생략하므로 필드가 없을 때만 0으로 읽습니다. */
function parseTotals(v: unknown): DayTotals {
  if (!record(v)) return invalid();
  const transfer = "transfer" in v ? v.transfer : 0;
  if (
    !totalKeys.every((k) => signed(v[k])) ||
    !signed(transfer) ||
    !integer(v.offlineRefunds) ||
    !integer(v.onlineGross) ||
    !integer(v.onlineRefunds) ||
    v.offlineNet !== (v.card as number) + (v.cash as number) + transfer ||
    v.onlineNet !== v.onlineGross - v.onlineRefunds ||
    v.combinedNet !== (v.offlineNet as number) + (v.onlineNet as number)
  )
    return invalid();
  return {
    ...(Object.fromEntries(totalKeys.map((k) => [k, v[k]])) as DayTotals),
    transfer,
  };
}
export function parseSalesDay(v: unknown, day: string): DayReport {
  if (
    !record(v) ||
    !validSalesDay(day) ||
    v.businessDay !== day ||
    v.timezone !== "Asia/Seoul" ||
    !integer(v.version, Number.MAX_SAFE_INTEGER - 1) ||
    !["OPEN", "CLOSED"].includes(String(v.status)) ||
    !time(v.asOf) ||
    v.complete !== true ||
    !fingerprint(v.onlineFingerprint) ||
    !Array.isArray(v.entries) ||
    !Array.isArray(v.onlineEvents) ||
    !Array.isArray(v.snapshots) ||
    !Array.isArray(v.history) ||
    !Array.isArray(v.warnings) ||
    !v.warnings.every((w) => typeof w === "string" && /^[A-Z0-9_]{1,80}$/.test(w))
  )
    return invalid();
  const entries = v.entries
    .map((e) => parseSalesEntry(e, day))
    .sort(
      (a, b) =>
        Date.parse(a.soldAt) - Date.parse(b.soldAt) ||
        a.entryId.localeCompare(b.entryId),
    );
  if (new Set(entries.map((e) => e.entryId)).size !== entries.length) return invalid();
  const onlineEvents: OnlineEvent[] = v.onlineEvents.map((e) => {
    if (
      !record(e) ||
      !id(e.orderId) ||
      !["APPROVAL", "REFUND"].includes(String(e.kind)) ||
      !integer(e.amount) ||
      !time(e.occurredAt) ||
      kstDay(e.occurredAt) !== day ||
      !["PROVIDER", "OBSERVED"].includes(String(e.timeBasis))
    )
      return invalid();
    return {
      orderId: e.orderId,
      kind: e.kind as OnlineEvent["kind"],
      amount: e.amount,
      occurredAt: e.occurredAt,
      timeBasis: e.timeBasis as OnlineEvent["timeBasis"],
    };
  });
  const totals = parseTotals(v.totals);
  const posted = entries.filter((e) => e.status === "POSTED");
  const sum = (method: string) =>
    posted
      .filter((e) => e.method === method)
      .reduce((s, e) => s + (e.kind === "REVERSAL" ? -e.amount : e.amount), 0);
  if (
    totals.card !== sum("CARD") ||
    totals.cash !== sum("CASH") ||
    totals.transfer !== sum("TRANSFER") ||
    totals.offlineRefunds !==
      posted.filter((e) => e.kind === "REVERSAL").reduce((s, e) => s + e.amount, 0) ||
    totals.onlineGross !==
      onlineEvents
        .filter((e) => e.kind === "APPROVAL")
        .reduce((s, e) => s + e.amount, 0) ||
    totals.onlineRefunds !==
      onlineEvents.filter((e) => e.kind === "REFUND").reduce((s, e) => s + e.amount, 0)
  )
    return invalid();
  const snapshots: DaySnapshot[] = v.snapshots.map((s) => {
    if (
      !record(s) ||
      !id(s.snapshotId) ||
      !time(s.closedAt) ||
      !integer(s.version, v.version as number) ||
      !fingerprint(s.onlineFingerprint) ||
      !signed(s.cashComparedAmount)
    )
      return invalid();
    const st = parseTotals(s.totals);
    if (s.cashComparedAmount !== st.cash) return invalid();
    const snapshotOnline: OnlineEvent[] = Array.isArray(s.onlineEvents)
      ? s.onlineEvents.map((e) => {
          if (
            !record(e) ||
            !id(e.orderId) ||
            !["APPROVAL", "REFUND"].includes(String(e.kind)) ||
            !integer(e.amount) ||
            !time(e.occurredAt) ||
            kstDay(e.occurredAt) !== day ||
            !["PROVIDER", "OBSERVED"].includes(String(e.timeBasis))
          )
            return invalid();
          return {
            orderId: e.orderId,
            kind: e.kind as OnlineEvent["kind"],
            amount: e.amount,
            occurredAt: e.occurredAt,
            timeBasis: e.timeBasis as OnlineEvent["timeBasis"],
          };
        })
      : [];
    if (s.entryManifest !== undefined && !fingerprint(s.entryManifest))
      return invalid();
    if (s.entryCount !== undefined && !integer(s.entryCount)) return invalid();
    return {
      snapshotId: s.snapshotId,
      closedAt: s.closedAt,
      version: s.version,
      totals: st,
      onlineFingerprint: s.onlineFingerprint,
      cashComparedAmount: s.cashComparedAmount,
      entryManifest: typeof s.entryManifest === "string" ? s.entryManifest : "",
      entryCount: typeof s.entryCount === "number" ? s.entryCount : 0,
      onlineEvents: snapshotOnline,
    };
  });
  if (v.status === "CLOSED" && !snapshots.length) return invalid();
  const history = v.history.map((h) => {
    if (
      !record(h) ||
      !["CLOSE", "REOPEN"].includes(String(h.action)) ||
      !text(h.reason, 300) ||
      !time(h.at)
    )
      return invalid();
    return { action: h.action as string, reason: h.reason, at: h.at };
  });
  return {
    businessDay: day,
    timezone: "Asia/Seoul",
    version: v.version,
    status: v.status as DayReport["status"],
    asOf: v.asOf,
    entries,
    onlineEvents,
    totals,
    warnings: [...v.warnings],
    onlineFingerprint: v.onlineFingerprint,
    snapshots,
    history,
    complete: true,
  };
}
export function createAdminSalesApiClient({
  authorizationTokenProvider,
  config = getCheckoutApiConfig(),
  fetchImplementation = fetch,
}: Readonly<{
  authorizationTokenProvider: CheckoutAuthorizationTokenProvider;
  config?: CheckoutApiConfig;
  fetchImplementation?: typeof fetch;
}>) {
  async function request(
    day: string,
    command?: SalesCommand,
  ): Promise<AdminSalesResult> {
    if (!validSalesDay(day)) throw new AdminSalesError("SALES_DAY_INVALID", 400);
    // 비동기 인증 전에 요청 본문을 고정하므로 재시도도 정확히 같은 명령을 보냅니다.
    const body = command ? commandBody(command, day) : undefined;
    const token = (await authorizationTokenProvider.getAccessToken())?.trim();
    if (!token) throw new AdminSalesError("ADMIN_LOGIN_REQUIRED", 401);
    try {
      const response = await fetchImplementation(
        new URL(
          `admin/sales/${encodeURIComponent(day)}`,
          `${config.apiBaseUrl.replace(/\/+$/, "")}/`,
        ),
        {
          method: body ? "POST" : "GET",
          headers: {
            Authorization: `Bearer ${token}`,
            Accept: "application/json",
            ...(body ? { "Content-Type": "application/json" } : {}),
          },
          ...(body ? { body } : {}),
          redirect: "error",
          // 서버 작업은 24초에 멈추므로 Lambda 28초 상한 전에 전송 시간을 남깁니다.
          signal: AbortSignal.timeout(27_000),
        },
      );
      const value: unknown = await response.json();
      if (!response.ok)
        throw new AdminSalesError(
          record(value) &&
          typeof value.code === "string" &&
          /^[A-Z0-9_]{1,80}$/.test(value.code)
            ? value.code
            : "SALES_OPERATION_FAILED",
          response.status,
          !!body && response.status >= 500,
        );
      if (!record(value)) return invalid();
      if (!command || command.action === "close" || command.action === "reopen")
        return { report: parseSalesDay(value.report, day) };
      if (command.action === "preview") {
        if (
          value.entryId !== command.entryId ||
          value.version !== command.version ||
          !fingerprint(value.previewToken) ||
          !Array.isArray(value.preview) ||
          !value.preview.length ||
          value.preview.length > 20
        )
          return invalid();
        const preview: StockPreview[] = value.preview.map((r) => {
          if (
            !record(r) ||
            !id(r.productId) ||
            !text(r.name, 160) ||
            !integer(r.quantity) ||
            !integer(r.reserved, r.quantity) ||
            r.available !== r.quantity - r.reserved ||
            !signed(r.delta) ||
            r.delta >= 0 ||
            !integer(r.after) ||
            r.after !== r.quantity + r.delta ||
            r.after < r.reserved ||
            !integer(r.version) ||
            !r.version
          )
            return invalid();
          return {
            productId: r.productId,
            name: r.name,
            quantity: r.quantity,
            reserved: r.reserved,
            available: r.available as number,
            delta: r.delta,
            after: r.after,
            version: r.version,
          };
        });
        if (new Set(preview.map((r) => r.productId)).size !== preview.length)
          return invalid();
        return {
          preview,
          previewToken: value.previewToken,
          entryId: value.entryId,
          version: value.version as number,
        };
      }
      const entry = parseSalesEntry(value.entry, day);
      if (
        entry.entryId !== command.entryId ||
        (command.action === "save" && entry.status !== "DRAFT") ||
        (command.action === "void" && entry.status !== "VOID") ||
        (["post", "reverse"].includes(command.action) && entry.status !== "POSTED")
      )
        return invalid();
      return { entry };
    } catch (error) {
      if (error instanceof AdminSalesError && error.code !== "SALES_RESPONSE_INVALID")
        throw error;
      throw new AdminSalesError(
        error instanceof AdminSalesError ? error.code : "SALES_CONNECTION_FAILED",
        null,
        !!body,
      );
    }
  }
  return {
    getDay: async (day: string) =>
      ((await request(day)) as { report: DayReport }).report,
    operate: (day: string, command: SalesCommand) => request(day, command),
  };
}
