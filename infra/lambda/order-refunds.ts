/** Money cancellation and physical inspection are separate durable operations. */
import {
  aggregateStock,
  checkOperation,
  InventoryError,
  operationKey,
  quantitiesFromRows,
  restoreVector,
  stockInteger,
  validOperationId,
  type InventoryLedger,
  type RefundIntent,
} from "./order-inventory-domain.js";
import {
  writeInventoryOrder,
  settleInventoryPayment,
} from "./order-inventory-store.js";
import type { OrderRecord } from "./order-record.js";
import {
  cancelTossPayment,
  definitiveRefundRejection,
  paymentMatchesOrder,
  verifiedCancellation,
  type TossPayment,
  type TossPaymentsCredentials,
} from "./toss-payments.js";
const requiredLedger = (order: OrderRecord) => {
  if (!order.inventory || order.inventory.state !== "DEBITED")
    throw new InventoryError("INVENTORY_DEBIT_PROOF_REQUIRED");
  return order.inventory;
};
const financialLedger = (order: OrderRecord) => {
  if (!order.inventory || !["DEBITED", "LEGACY"].includes(order.inventory.state))
    throw new InventoryError("REFUND_PAYMENT_PROOF_REQUIRED");
  return order.inventory;
};
/** LEGACY is monetary bookkeeping only, never proof of a stock debit. */
export async function ensureLegacyFinancialLedger(
  order: OrderRecord,
): Promise<OrderRecord> {
  if (order.inventory) return order;
  if (order.status !== "PAID" || !order.providerPaymentKey)
    throw new InventoryError("ORDER_NOT_REFUNDABLE");
  const inventory: InventoryLedger = {
    schema: 1,
    version: 1,
    state: "LEGACY",
    paymentKey: order.providerPaymentKey,
    expiresAt: order.checkoutReturnExpiresAt,
    fulfillment: "UNCONFIRMED",
    restored: order.lines.map(() => 0),
    canceled: order.lines.map(() => 0),
    refundedAmount: order.financialRefundedAmount ?? 0,
    nonStockRefund: true,
    operations: {},
  };
  return writeInventoryOrder(order, { ...order, inventory });
}
const restoreDeltas = (order: OrderRecord, quantities: readonly number[]) =>
  new Map(
    [...aggregateStock(order.lines, quantities)].map(([id, q]) => [
      id,
      { quantity: q, reserved: 0 },
    ]),
  );
function recorded(
  ledger: InventoryLedger,
  id: string,
  fingerprint: string,
  kind: string,
): InventoryLedger {
  return {
    ...ledger,
    version: ledger.version + 1,
    operations: { ...ledger.operations, [operationKey(id)]: { fingerprint, kind } },
  };
}

export async function confirmFulfillment(
  order: OrderRecord,
  state: unknown,
  id: string,
): Promise<OrderRecord> {
  const ledger = requiredLedger(order);
  const fingerprint = operationKey(JSON.stringify(["fulfillment", state]));
  if (!validOperationId(id) || !["UNSHIPPED", "SHIPPED"].includes(state as string))
    throw new InventoryError("FULFILLMENT_INVALID", 400);
  if (checkOperation(ledger, id, fingerprint)) return order;
  if (ledger.pendingRefund) throw new InventoryError("REFUND_IN_PROGRESS");
  if (ledger.fulfillment === "SHIPPED" && state !== "SHIPPED")
    throw new InventoryError("FULFILLMENT_CANNOT_REVERSE_SHIPMENT");
  if (state === "SHIPPED" && order.status !== "PAID")
    throw new InventoryError("ORDER_NOT_SHIPPABLE");
  let inventory = {
    ...recorded(ledger, id, fingerprint, "fulfillment"),
    fulfillment: state as "UNSHIPPED" | "SHIPPED",
  };
  const remaining = order.lines.map((line, i) => line.quantity - ledger.restored[i]!);
  const restore =
    state === "UNSHIPPED" &&
    order.paymentStatus === "CANCELED" &&
    ledger.refundedAmount === order.total &&
    !ledger.nonStockRefund;
  if (restore)
    inventory = {
      ...inventory,
      restored: order.lines.map((line) => line.quantity),
      canceled: order.lines.map((line) => line.quantity),
    };
  return writeInventoryOrder(
    order,
    { ...order, inventory },
    restore ? restoreDeltas(order, remaining) : undefined,
  );
}
export async function receiveReturn(
  order: OrderRecord,
  rows: unknown,
  receiptId: unknown,
  confirmed: unknown,
  id: string,
): Promise<OrderRecord> {
  const ledger = requiredLedger(order);
  if (
    !validOperationId(id) ||
    typeof receiptId !== "string" ||
    !/^[A-Za-z0-9][A-Za-z0-9._-]{2,79}$/.test(receiptId) ||
    confirmed !== true
  )
    throw new InventoryError("RETURN_INSPECTION_REQUIRED", 400);
  const quantities = quantitiesFromRows(order.lines, rows);
  const fingerprint = operationKey(JSON.stringify(["return", receiptId, quantities]));
  const receiptKey = `return:${receiptId}`;
  if (
    checkOperation(ledger, id, fingerprint) ||
    checkOperation(ledger, receiptKey, fingerprint)
  )
    return order;
  if (ledger.pendingRefund) throw new InventoryError("REFUND_IN_PROGRESS");
  if (ledger.fulfillment !== "SHIPPED")
    throw new InventoryError("RETURN_SHIPMENT_CONFIRMATION_REQUIRED");
  const restored = restoreVector(ledger, order.lines, quantities);
  if (Object.keys(ledger.operations).length > 98)
    throw new InventoryError("INVENTORY_OPERATION_LIMIT");
  const inventory = {
    ...recorded(ledger, id, fingerprint, "return"),
    restored,
    operations: {
      ...ledger.operations,
      [operationKey(id)]: { fingerprint, kind: "return" },
      [operationKey(receiptKey)]: { fingerprint, kind: "return-receipt" },
    },
  };
  return writeInventoryOrder(
    order,
    { ...order, inventory },
    restoreDeltas(order, quantities),
  );
}
export function refundIntent(
  order: OrderRecord,
  body: Record<string, unknown>,
): RefundIntent {
  const ledger = financialLedger(order);
  const { operationId, disposition, cancelAmount } = body;
  const reason = typeof body.cancelReason === "string" ? body.cancelReason.trim() : "";
  if (ledger.state === "LEGACY" && body.disposition !== "COMPENSATION")
    throw new InventoryError("LEGACY_REFUND_NO_RESTOCK", 400);
  if (
    !validOperationId(operationId) ||
    !reason ||
    reason.length > 150 ||
    !["UNSHIPPED", "SHIPPED", "COMPENSATION"].includes(disposition as string) ||
    !stockInteger(cancelAmount, order.total) ||
    cancelAmount < 1
  )
    throw new InventoryError("REFUND_BODY_INVALID", 400);
  const quantities =
    disposition === "COMPENSATION"
      ? order.lines.map(() => 0)
      : quantitiesFromRows(order.lines, body.rows);
  if (disposition === "COMPENSATION" && Array.isArray(body.rows) && body.rows.length)
    throw new InventoryError("COMPENSATION_CANNOT_RESTOCK", 400);
  const fingerprint = operationKey(
    JSON.stringify(["refund", reason, disposition, cancelAmount, quantities]),
  );
  return {
    operationId,
    fingerprint,
    reason,
    amount: cancelAmount,
    quantities,
    disposition: disposition as RefundIntent["disposition"],
    createdAt: new Date().toISOString(),
    beforeRefundedAmount: ledger.refundedAmount,
    providerReason: `pd:${operationKey(order.orderId + ":" + operationId).slice(0, 32)}:${reason}`,
  };
}
/** Check op proof before any provider call, including a retry after the order is fully refunded. */
export async function startRefund(
  order: OrderRecord,
  intent: RefundIntent,
  credentials: TossPaymentsCredentials,
): Promise<OrderRecord> {
  const ledger = financialLedger(order);
  if (checkOperation(ledger, intent.operationId, intent.fingerprint)) return order;
  let working = order;
  if (ledger.pendingRefund) {
    if (
      ledger.pendingRefund.operationId !== intent.operationId ||
      ledger.pendingRefund.fingerprint !== intent.fingerprint
    )
      throw new InventoryError("REFUND_IN_PROGRESS");
    intent = ledger.pendingRefund;
    if (Date.now() - Date.parse(intent.createdAt) > 14 * 24 * 60 * 60_000)
      throw new InventoryError("REFUND_RECONCILIATION_REQUIRED");
  } else {
    if (order.status !== "PAID" || intent.amount > order.total - ledger.refundedAmount)
      throw new InventoryError("REFUND_AMOUNT_EXCEEDS_BALANCE");
    if (intent.disposition !== "COMPENSATION") {
      if (ledger.fulfillment !== intent.disposition)
        throw new InventoryError("REFUND_FULFILLMENT_CONFIRMATION_REQUIRED");
      if (
        intent.quantities.some(
          (q, i) => q + ledger.canceled[i]! > order.lines[i]!.quantity,
        )
      )
        throw new InventoryError("REFUND_QUANTITY_EXCEEDS_ORDER");
      if (
        intent.quantities.reduce(
          (sum, q, i) => sum + q * order.lines[i]!.unitPrice,
          0,
        ) !== intent.amount
      )
        throw new InventoryError("REFUND_LINE_AMOUNT_MISMATCH", 400);
    }
    working = await writeInventoryOrder(order, {
      ...order,
      inventory: { ...ledger, version: ledger.version + 1, pendingRefund: intent },
    });
  }
  let payment;
  try {
    payment = await cancelTossPayment({
      credentials,
      paymentKey: ledger.paymentKey,
      orderId: order.orderId,
      cancelReason: intent.providerReason,
      cancelAmount: intent.amount,
      operationId: operationKey(order.orderId + ":" + intent.operationId),
    });
  } catch (error) {
    if (definitiveRefundRejection(error)) {
      const current = working.inventory!;
      // eslint-disable-next-line @typescript-eslint/no-unused-vars -- drops the cleared pendingRefund
      const { pendingRefund: _pending, ...finished } = recorded(
        current,
        intent.operationId,
        intent.fingerprint,
        "refund-rejected",
      );
      return writeInventoryOrder(working, {
        ...working,
        inventory: {
          ...finished,
          lastFailure: { code: error.providerCode!, operationId: intent.operationId },
          operations: {
            ...finished.operations,
            [operationKey(intent.operationId)]: {
              fingerprint: intent.fingerprint,
              kind: "refund-rejected",
              failureCode: error.providerCode!,
            },
          },
        },
      });
    }
    throw new InventoryError("REFUND_RESULT_UNCERTAIN", 503);
  }
  return syncRefundPayment(working, payment);
}
export async function syncRefundPayment(
  order: OrderRecord,
  payment: TossPayment,
): Promise<OrderRecord> {
  const ledger = order.inventory;
  const pending = ledger?.pendingRefund;
  if (!pending) return settleInventoryPayment(order, payment);
  if (!paymentMatchesOrder(payment, order, ledger.paymentKey))
    throw new InventoryError("REFUND_PROVIDER_MISMATCH", 502);
  if (
    order.total - payment.balanceAmount <
    Math.max(ledger.refundedAmount, order.financialRefundedAmount ?? 0)
  )
    throw new InventoryError("PAYMENT_STALE_STATE", 503);
  const matches = payment.cancels.filter(
    (c) => c.cancelReason === pending.providerReason,
  );
  if (
    !verifiedCancellation(payment) ||
    matches.length !== 1 ||
    matches[0]!.cancelStatus !== "DONE" ||
    matches[0]!.cancelAmount !== pending.amount
  ) {
    // Preserve the lock until the exact provider transaction is proven; never attribute an unrelated cancel.
    return settleInventoryPayment(order, payment);
  }
  if (
    order.total - payment.balanceAmount <
    pending.beforeRefundedAmount + pending.amount
  )
    throw new InventoryError("REFUND_PROVIDER_MISMATCH", 502);
  const canceled = ledger.canceled.map((q, i) => q + pending.quantities[i]!);
  if (canceled.some((q, i) => q > order.lines[i]!.quantity))
    throw new InventoryError("REFUND_QUANTITY_EXCEEDS_ORDER");
  let quantities = order.lines.map(() => 0);
  if (pending.disposition === "UNSHIPPED") quantities = [...pending.quantities];
  const restored =
    ledger.state === "LEGACY"
      ? [...ledger.restored]
      : restoreVector(ledger, order.lines, quantities);
  // eslint-disable-next-line @typescript-eslint/no-unused-vars -- drops the cleared pendingRefund
  const { pendingRefund: _pending, ...withoutPending } = recorded(
    ledger,
    pending.operationId,
    pending.fingerprint,
    "refund",
  );
  const inventory = {
    ...withoutPending,
    restored,
    canceled,
    refundedAmount: order.total - payment.balanceAmount,
    nonStockRefund: ledger.nonStockRefund || pending.disposition === "COMPENSATION",
    operations: {
      ...withoutPending.operations,
      [operationKey(pending.operationId)]: {
        fingerprint: pending.fingerprint,
        kind: "refund",
        transactionKey: matches[0]!.transactionKey,
        amount: pending.amount,
      },
    },
  };
  return writeInventoryOrder(
    order,
    {
      ...order,
      inventory,
      financialRefundedAmount: order.total - payment.balanceAmount,
      status: payment.status === "CANCELED" ? "REFUNDED" : "PAID",
      paymentStatus: payment.status,
      providerPaymentStatus: payment.status,
      ...(payment.status === "CANCELED"
        ? { refundedAt: new Date().toISOString() }
        : {}),
    },
    restoreDeltas(order, quantities),
    payment,
  );
}
