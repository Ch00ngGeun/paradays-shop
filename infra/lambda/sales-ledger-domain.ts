/** Shared, pure sales contracts. Amounts are gross KRW; no card/customer data. */
export type SaleLine = Readonly<{
  productId: string | null;
  name: string;
  option: string;
  quantity: number;
  unitAmount: number;
}>;
/** Offline payment methods. Each is totalled separately; none falls back to cash. */
export const SALE_METHODS = ["CARD", "CASH", "TRANSFER"] as const;
export type SaleMethod = (typeof SALE_METHODS)[number];
export type SaleInput = Readonly<{
  entryId: string;
  expectedVersion: number;
  soldAt: string;
  method: SaleMethod;
  reference: string;
  amount: number;
  memo: string;
  lines: readonly SaleLine[];
}>;
export type SaleEntry = Omit<SaleInput, "expectedVersion"> &
  Readonly<{
    businessDay: string;
    recordType: "SALE";
    version: number;
    status: "DRAFT" | "POSTED" | "VOID";
    kind: "SALE" | "REVERSAL";
    original?: Readonly<{ businessDay: string; entryId: string }>;
    restocked?: boolean;
    createdAt: string;
    updatedAt: string;
  }>;
export type StockPreview = Readonly<{
  productId: string;
  name: string;
  quantity: number;
  reserved: number;
  available: number;
  delta: number;
  after: number;
  version: number;
}>;
export type OnlineEvent = Readonly<{
  orderId: string;
  kind: "APPROVAL" | "REFUND";
  amount: number;
  occurredAt: string;
  timeBasis: "PROVIDER" | "OBSERVED";
}>;
export type DayTotals = Readonly<{
  card: number;
  cash: number;
  /** Absent only in snapshots closed before transfers existed; read as 0. */
  transfer?: number;
  offlineRefunds: number;
  offlineNet: number;
  onlineGross: number;
  onlineRefunds: number;
  onlineNet: number;
  combinedNet: number;
}>;
export type DaySnapshot = Readonly<{
  snapshotId: string;
  closedAt: string;
  observedAt?: string;
  version: number;
  totals: DayTotals;
  onlineFingerprint: string;
  cashComparedAmount: number;
  entryManifest: string;
  entryCount: number;
  onlineEvents: readonly OnlineEvent[];
}>;
export type DayReport = Readonly<{
  businessDay: string;
  timezone: "Asia/Seoul";
  version: number;
  status: "OPEN" | "CLOSED";
  asOf: string;
  entries: readonly SaleEntry[];
  onlineEvents: readonly OnlineEvent[];
  totals: DayTotals;
  warnings: readonly string[];
  onlineFingerprint: string;
  snapshots: readonly DaySnapshot[];
  history: readonly Readonly<{ action: string; reason: string; at: string }>[];
  complete: true;
}>;
export type SalesCommand =
  | ({ action: "save" } & SaleInput)
  | { action: "preview"; entryId: string; version: number }
  | {
      action: "post";
      entryId: string;
      version: number;
      previewToken: string;
      confirmed: true;
    }
  | { action: "void"; entryId: string; version: number; reason: string }
  | {
      action: "reverse";
      entryId: string;
      originalDay: string;
      originalId: string;
      soldAt: string;
      reason: string;
      restockInspected: boolean;
      confirmed: true;
    }
  | {
      action: "close";
      operationId: string;
      expectedVersion: number;
      onlineFingerprint: string;
      cashComparedAmount: number;
      confirmed: true;
    }
  | { action: "reopen"; operationId: string; expectedVersion: number; reason: string };

export class SalesError extends Error {
  constructor(
    readonly code: string,
    readonly status = 409,
  ) {
    super(code);
  }
}
export const record = (v: unknown): v is Record<string, unknown> =>
  typeof v === "object" && v !== null && !Array.isArray(v);
export const integer = (v: unknown, max = 100_000_000): v is number =>
  typeof v === "number" && Number.isSafeInteger(v) && v >= 0 && v <= max;
export const identifier = (v: unknown): v is string =>
  typeof v === "string" &&
  /^[A-Za-z0-9][A-Za-z0-9._-]{2,96}$/.test(v) &&
  !/^test/i.test(v);
const text = (v: unknown, max: number): v is string =>
  typeof v === "string" && v.length <= max && !/[\u0000-\u001f\u007f]/.test(v);
export function validDay(v: unknown): v is string {
  return (
    typeof v === "string" &&
    /^20\d\d-\d\d-\d\d$/.test(v) &&
    Number.isFinite(Date.parse(`${v}T00:00:00+09:00`)) &&
    kstDay(`${v}T00:00:00+09:00`) === v
  );
}
export function kstDay(iso: string) {
  return new Date(Date.parse(iso) + 9 * 3_600_000).toISOString().slice(0, 10);
}
export function validSaleTime(v: unknown, day: string, now = Date.now()): v is string {
  return (
    typeof v === "string" &&
    /^\d{4}-\d\d-\d\dT\d\d:\d\d(?::\d\d(?:\.\d{3})?)?(?:Z|\+09:00)$/.test(v) &&
    validDay(v.slice(0, 10)) &&
    Number(v.slice(11, 13)) <= 23 &&
    Number(v.slice(14, 16)) <= 59 &&
    (v[16] !== ":" || Number(v.slice(17, 19)) <= 59) &&
    Number.isFinite(Date.parse(v)) &&
    Date.parse(v) <= now &&
    kstDay(v) === day
  );
}
function keys(v: Record<string, unknown>, allowed: readonly string[]) {
  return Object.keys(v).length === allowed.length && allowed.every((k) => k in v);
}
export function parseSalesCommand(
  v: unknown,
  day: string,
  now = Date.now(),
): SalesCommand | null {
  if (!record(v) || !validDay(day)) return null;
  const idVersion = () =>
    identifier(v.entryId) &&
    integer(v.version, Number.MAX_SAFE_INTEGER - 1) &&
    v.version > 0;
  const reason = () => text(v.reason, 300) && v.reason.trim().length > 0;
  if (v.action === "save") {
    if (
      !keys(v, [
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
      !identifier(v.entryId) ||
      !integer(v.expectedVersion, 98) ||
      !validSaleTime(v.soldAt, day, now) ||
      !(SALE_METHODS as readonly string[]).includes(String(v.method)) ||
      !text(v.reference, 64) ||
      !/^[A-Za-z0-9][A-Za-z0-9._/-]{2,63}$/.test(v.reference) ||
      !integer(v.amount) ||
      v.amount < 1 ||
      !text(v.memo, 300) ||
      !Array.isArray(v.lines) ||
      v.lines.length > 20
    )
      return null;
    for (const l of v.lines)
      if (
        !record(l) ||
        !keys(l, ["productId", "name", "option", "quantity", "unitAmount"]) ||
        (l.productId !== null && !identifier(l.productId)) ||
        !text(l.name, 160) ||
        !text(l.option, 50) ||
        !integer(l.quantity, 10_000) ||
        l.quantity < 1 ||
        !integer(l.unitAmount)
      )
        return null;
    return { ...v, soldAt: new Date(v.soldAt).toISOString() } as SalesCommand;
  }
  if (
    v.action === "preview" &&
    keys(v, ["action", "entryId", "version"]) &&
    idVersion()
  )
    return v as SalesCommand;
  if (
    v.action === "post" &&
    keys(v, ["action", "entryId", "version", "previewToken", "confirmed"]) &&
    idVersion() &&
    typeof v.previewToken === "string" &&
    /^[a-f0-9]{64}$/.test(v.previewToken) &&
    v.confirmed === true
  )
    return v as SalesCommand;
  if (
    v.action === "void" &&
    keys(v, ["action", "entryId", "version", "reason"]) &&
    idVersion() &&
    reason()
  )
    return v as SalesCommand;
  if (
    v.action === "reverse" &&
    keys(v, [
      "action",
      "entryId",
      "originalDay",
      "originalId",
      "soldAt",
      "reason",
      "restockInspected",
      "confirmed",
    ]) &&
    identifier(v.entryId) &&
    validDay(v.originalDay) &&
    identifier(v.originalId) &&
    validSaleTime(v.soldAt, day, now) &&
    reason() &&
    typeof v.restockInspected === "boolean" &&
    v.confirmed === true
  )
    return { ...v, soldAt: new Date(v.soldAt).toISOString() } as SalesCommand;
  if (
    v.action === "close" &&
    keys(v, [
      "action",
      "operationId",
      "expectedVersion",
      "onlineFingerprint",
      "cashComparedAmount",
      "confirmed",
    ]) &&
    identifier(v.operationId) &&
    integer(v.expectedVersion, Number.MAX_SAFE_INTEGER - 1) &&
    typeof v.onlineFingerprint === "string" &&
    /^[a-f0-9]{64}$/.test(v.onlineFingerprint) &&
    typeof v.cashComparedAmount === "number" &&
    Number.isSafeInteger(v.cashComparedAmount) &&
    Math.abs(v.cashComparedAmount) <= Number.MAX_SAFE_INTEGER &&
    v.confirmed === true
  )
    return v as SalesCommand;
  if (
    v.action === "reopen" &&
    keys(v, ["action", "operationId", "expectedVersion", "reason"]) &&
    identifier(v.operationId) &&
    integer(v.expectedVersion, Number.MAX_SAFE_INTEGER - 1) &&
    reason()
  )
    return v as SalesCommand;
  return null;
}
export function saleWarnings(entry: SaleEntry) {
  const warnings: string[] = [];
  if (
    !entry.lines.length ||
    entry.lines.some((l) => !l.productId || !l.option || !l.name.trim())
  )
    warnings.push("UNMATCHED_PRODUCTS");
  if (entry.lines.reduce((s, l) => s + l.quantity * l.unitAmount, 0) !== entry.amount)
    warnings.push("LINE_AMOUNT_MISMATCH");
  return warnings;
}
export function sortEntries(entries: readonly SaleEntry[]) {
  return [...entries].sort(
    (a, b) => a.soldAt.localeCompare(b.soldAt) || a.entryId.localeCompare(b.entryId),
  );
}
export function calculateTotals(
  entries: readonly SaleEntry[],
  online: readonly OnlineEvent[],
): DayTotals {
  let card = 0,
    cash = 0,
    transfer = 0,
    offlineRefunds = 0,
    onlineGross = 0,
    onlineRefunds = 0;
  for (const e of entries)
    if (e.status === "POSTED") {
      const signed = e.kind === "REVERSAL" ? -e.amount : e.amount;
      if (e.method === "CARD") card += signed;
      else if (e.method === "CASH") cash += signed;
      else if (e.method === "TRANSFER") transfer += signed;
      else throw new SalesError("SALE_METHOD_INVALID", 503);
      if (e.kind === "REVERSAL") offlineRefunds += e.amount;
    }
  for (const e of online)
    if (e.kind === "APPROVAL") onlineGross += e.amount;
    else onlineRefunds += e.amount;
  const offlineNet = card + cash + transfer,
    onlineNet = onlineGross - onlineRefunds;
  const totals = {
    card,
    cash,
    transfer,
    offlineRefunds,
    offlineNet,
    onlineGross,
    onlineRefunds,
    onlineNet,
    combinedNet: offlineNet + onlineNet,
  };
  if (!Object.values(totals).every(Number.isSafeInteger))
    throw new SalesError("SALES_AMOUNT_OVERFLOW", 503);
  return totals;
}
