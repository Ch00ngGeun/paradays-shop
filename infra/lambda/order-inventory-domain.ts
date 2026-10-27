/** Pure, bounded stock contracts. Money refunds never imply physical returns. */
import { createHash } from "node:crypto";
import type { OrderLineSnapshot } from "./order-domain.js";

export class InventoryError extends Error {
  constructor(
    readonly code: string,
    readonly status = 409,
  ) {
    super(code);
  }
}
export type RefundIntent = Readonly<{
  operationId: string;
  fingerprint: string;
  reason: string;
  amount: number;
  quantities: readonly number[];
  disposition: "UNSHIPPED" | "SHIPPED" | "COMPENSATION";
  createdAt: string;
  providerReason: string;
  beforeRefundedAmount: number;
}>;
export type InventoryLedger = Readonly<{
  schema: 1;
  version: number;
  state: "RESERVED" | "DEBITED" | "RELEASED" | "LEGACY";
  paymentKey: string;
  expiresAt: string;
  fulfillment: "UNCONFIRMED" | "UNSHIPPED" | "SHIPPED";
  restored: readonly number[];
  canceled: readonly number[];
  refundedAmount: number;
  operations: Readonly<
    Record<
      string,
      Readonly<{
        fingerprint: string;
        kind: string;
        transactionKey?: string;
        amount?: number;
        failureCode?: string;
      }>
    >
  >;
  pendingRefund?: RefundIntent;
  approvalAttemptedAt?: string;
  approvalAttemptId?: string;
  approvalFailureCode?: string;
  lastFailure?: Readonly<{ code: string; operationId: string }>;
  nonStockRefund?: boolean;
}>;

export const stockInteger = (value: unknown, max = 1_000_000): value is number =>
  typeof value === "number" &&
  Number.isSafeInteger(value) &&
  value >= 0 &&
  value <= max;
export const operationKey = (value: string) =>
  createHash("sha256").update(value).digest("hex");
export function validOperationId(value: unknown): value is string {
  return typeof value === "string" && /^[A-Za-z0-9][A-Za-z0-9._-]{15,127}$/.test(value);
}
export function validOrderLines(
  value: unknown,
  subtotal: unknown,
  total: unknown,
): value is readonly OrderLineSnapshot[] {
  if (
    !Array.isArray(value) ||
    value.length < 1 ||
    value.length > 20 ||
    !stockInteger(subtotal, Number.MAX_SAFE_INTEGER) ||
    total !== subtotal ||
    total < 1
  )
    return false;
  let sum = 0;
  const ids = new Set<string>();
  for (const row of value) {
    if (
      !row ||
      typeof row !== "object" ||
      typeof row.productId !== "string" ||
      !/^[A-Za-z0-9][A-Za-z0-9._-]{2,96}$/.test(row.productId) ||
      typeof row.name !== "string" ||
      !row.name ||
      typeof row.selectedSize !== "string" ||
      !row.selectedSize ||
      !stockInteger(row.quantity, 10) ||
      row.quantity < 1 ||
      !stockInteger(row.unitPrice, 100_000_000) ||
      row.lineTotal !== row.quantity * row.unitPrice
    )
      return false;
    const key = JSON.stringify([row.productId, row.selectedSize]);
    if (ids.has(key)) return false;
    ids.add(key);
    sum += row.lineTotal;
  }
  return Number.isSafeInteger(sum) && sum === subtotal;
}
export function quantitiesFromRows(
  lines: readonly OrderLineSnapshot[],
  rows: unknown,
): number[] {
  if (!Array.isArray(rows) || !rows.length || rows.length > lines.length)
    throw new InventoryError("INVENTORY_ROWS_INVALID", 400);
  const vector = lines.map(() => 0);
  for (const row of rows) {
    if (
      !row ||
      !stockInteger(row.line, lines.length - 1) ||
      !stockInteger(row.quantity, 10) ||
      row.quantity < 1 ||
      row.quantity > lines[row.line]!.quantity ||
      vector[row.line] !== 0
    )
      throw new InventoryError("INVENTORY_ROWS_INVALID", 400);
    vector[row.line] = row.quantity;
  }
  return vector;
}
export function aggregateStock(
  lines: readonly OrderLineSnapshot[],
  vector: readonly number[] = lines.map((line) => line.quantity),
): Map<string, number> {
  if (vector.length !== lines.length)
    throw new InventoryError("INVENTORY_LEDGER_INVALID");
  const result = new Map<string, number>();
  lines.forEach((line, index) => {
    const quantity = vector[index]!;
    if (!stockInteger(quantity, line.quantity))
      throw new InventoryError("INVENTORY_LEDGER_INVALID");
    if (quantity)
      result.set(line.productId, (result.get(line.productId) ?? 0) + quantity);
  });
  return result;
}
export function validLedger(
  value: unknown,
  lines: readonly OrderLineSnapshot[],
): value is InventoryLedger {
  if (!value || typeof value !== "object") return false;
  const item = value as InventoryLedger;
  const total = lines.reduce((sum, line) => sum + line.lineTotal, 0);
  const pending = item.pendingRefund;
  const pendingValid =
    pending === undefined ||
    (!!pending &&
      typeof pending === "object" &&
      validOperationId(pending.operationId) &&
      typeof pending.fingerprint === "string" &&
      /^[a-f0-9]{64}$/.test(pending.fingerprint) &&
      typeof pending.reason === "string" &&
      pending.reason.length > 0 &&
      pending.reason.length <= 150 &&
      stockInteger(pending.amount, total) &&
      pending.amount > 0 &&
      stockInteger(pending.beforeRefundedAmount, total - pending.amount) &&
      typeof pending.createdAt === "string" &&
      Number.isFinite(Date.parse(pending.createdAt)) &&
      typeof pending.providerReason === "string" &&
      pending.providerReason.startsWith("pd:") &&
      pending.providerReason.length <= 200 &&
      ["UNSHIPPED", "SHIPPED", "COMPENSATION"].includes(pending.disposition) &&
      Array.isArray(pending.quantities) &&
      pending.quantities.length === lines.length &&
      pending.quantities.every((q, i) => stockInteger(q, lines[i]!.quantity)) &&
      (item.state !== "LEGACY" ||
        (pending.disposition === "COMPENSATION" &&
          pending.quantities.every((q) => q === 0))));
  return (
    item.schema === 1 &&
    stockInteger(item.version, Number.MAX_SAFE_INTEGER - 1) &&
    item.version > 0 &&
    ["RESERVED", "DEBITED", "RELEASED", "LEGACY"].includes(item.state) &&
    typeof item.paymentKey === "string" &&
    item.paymentKey.length > 0 &&
    item.paymentKey.length <= 200 &&
    typeof item.expiresAt === "string" &&
    Number.isFinite(Date.parse(item.expiresAt)) &&
    ["UNCONFIRMED", "UNSHIPPED", "SHIPPED"].includes(item.fulfillment) &&
    stockInteger(item.refundedAmount, total) &&
    pendingValid &&
    (item.nonStockRefund === undefined || typeof item.nonStockRefund === "boolean") &&
    (item.approvalAttemptedAt === undefined ||
      (typeof item.approvalAttemptedAt === "string" &&
        Number.isFinite(Date.parse(item.approvalAttemptedAt)))) &&
    [item.restored, item.canceled].every(
      (vector) =>
        Array.isArray(vector) &&
        vector.length === lines.length &&
        vector.every((q, i) => stockInteger(q, lines[i]!.quantity)),
    ) &&
    (item.state === "DEBITED" || item.restored.every((q) => q === 0)) &&
    !!item.operations &&
    typeof item.operations === "object" &&
    !Array.isArray(item.operations) &&
    Object.keys(item.operations).length <= 100 &&
    Object.entries(item.operations).every(
      ([key, op]) =>
        /^[a-f0-9]{64}$/.test(key) &&
        !!op &&
        typeof op.fingerprint === "string" &&
        typeof op.kind === "string",
    )
  );
}
export function restoreVector(
  ledger: InventoryLedger,
  lines: readonly OrderLineSnapshot[],
  quantities: readonly number[],
): number[] {
  if (ledger.state !== "DEBITED" || quantities.length !== lines.length)
    throw new InventoryError("INVENTORY_DEBIT_PROOF_REQUIRED");
  return quantities.map((q, i) => {
    if (
      !stockInteger(q, lines[i]!.quantity) ||
      ledger.restored[i]! + q > lines[i]!.quantity
    )
      throw new InventoryError("INVENTORY_RESTORE_EXCEEDS_DEBIT");
    return ledger.restored[i]! + q;
  });
}
export function checkOperation(
  ledger: InventoryLedger,
  id: string,
  fingerprint: string,
): boolean {
  const previous = ledger.operations[operationKey(id)];
  if (previous && previous.fingerprint !== fingerprint)
    throw new InventoryError("INVENTORY_OPERATION_REUSED");
  if (!previous && Object.keys(ledger.operations).length >= 100)
    throw new InventoryError("INVENTORY_OPERATION_LIMIT");
  return Boolean(previous);
}
