/** Shared transactional writer: order proof, product versions and OCR catalog revision commit together. */
import { GetCommand } from "@aws-sdk/lib-dynamodb";
import { randomUUID } from "node:crypto";
import { documentClient, getRequiredEnvironment } from "./dynamodb-client.js";
import { salesRequestSignal } from "./sales-request-deadline.js";
import { isOrderRecord, type OrderRecord } from "./order-record.js";
import {
  aggregateStock,
  InventoryError,
  stockInteger,
  type InventoryLedger,
} from "./order-inventory-domain.js";
import {
  paymentMatchesOrder,
  verifiedCancellation,
  type TossPayment,
} from "./toss-payments.js";
import { writeInventoryOrder } from "./order-inventory-writer.js";

type Product = {
  productId: string;
  name: string;
  price: number;
  sizes: readonly string[];
  status: string;
  currency: string;
  inventoryQuantity: number;
  inventoryReserved?: number;
  inventoryCommitted?: number;
  version: number;
};

export type StockDelta = Readonly<{ quantity: number; reserved: number }>;

export async function readOrder(orderId: string): Promise<OrderRecord | null> {
  const result = await documentClient.send(
    new GetCommand({
      TableName: getRequiredEnvironment("ORDER_TABLE_NAME"),
      Key: { orderId },
      ConsistentRead: true,
    }),
  );
  if (!result.Item) return null;
  if (!isOrderRecord(result.Item))
    throw new InventoryError("ORDER_RECORD_INVALID", 503);
  return result.Item;
}

export async function readProducts(
  ids: readonly string[],
): Promise<Map<string, Product>> {
  const table = getRequiredEnvironment("CATALOG_TABLE_NAME");
  const products = await Promise.all(
    [...new Set(ids)].map(async (productId) => {
      const abortSignal = salesRequestSignal();
      const { Item: p } = await documentClient.send(
        new GetCommand({ TableName: table, Key: { productId }, ConsistentRead: true }),
        ...(abortSignal ? [{ abortSignal }] : []),
      );
      if (
        !p ||
        p.productId !== productId ||
        typeof p.name !== "string" ||
        !stockInteger(p.price, 100_000_000) ||
        !Array.isArray(p.sizes) ||
        !p.sizes.every((s) => typeof s === "string") ||
        !stockInteger(p.inventoryQuantity) ||
        !stockInteger(p.inventoryReserved ?? 0, p.inventoryQuantity) ||
        !stockInteger(p.inventoryCommitted ?? 0, Number.MAX_SAFE_INTEGER - 1) ||
        !stockInteger(p.version, Number.MAX_SAFE_INTEGER - 1) ||
        p.version < 1 ||
        p.currency !== "KRW"
      )
        throw new InventoryError("CATALOG_PRODUCT_UNAVAILABLE");
      return [productId, p as Product] as const;
    }),
  );
  return new Map(products);
}

export async function reserveInventory(
  order: OrderRecord,
  paymentKey: string,
): Promise<OrderRecord> {
  if (order.inventory) {
    if (order.inventory.paymentKey !== paymentKey)
      throw new InventoryError("PAYMENT_KEY_CONFLICT");
    if (order.inventory.state === "RELEASED")
      throw new InventoryError("PAYMENT_ALREADY_RESOLVED");
    return order;
  }
  if (order.status !== "PENDING_PAYMENT")
    throw new InventoryError("INVENTORY_LEGACY_ORDER");
  const products = await readProducts(order.lines.map((line) => line.productId));
  for (const line of order.lines) {
    const p = products.get(line.productId)!;
    if (
      p.status !== "PUBLISHED" ||
      p.price !== line.unitPrice ||
      !p.sizes.includes(line.selectedSize)
    )
      throw new InventoryError("CHECKOUT_CATALOG_CHANGED");
  }
  const quantities = aggregateStock(order.lines);
  const deltas = new Map(
    [...quantities].map(([id, q]) => [id, { quantity: 0, reserved: q }]),
  );
  const inventory: InventoryLedger = {
    schema: 1,
    version: 1,
    state: "RESERVED",
    paymentKey,
    expiresAt: order.checkoutReturnExpiresAt,
    fulfillment: "UNCONFIRMED",
    restored: order.lines.map(() => 0),
    canceled: order.lines.map(() => 0),
    refundedAmount: 0,
    operations: {},
  };
  return writeInventoryOrder(
    order,
    { ...order, providerPaymentKey: paymentKey, inventory },
    deltas,
  );
}

/** Persist the boundary BEFORE calling approval. No attempted marker means this code has not sent approval. */
export async function markApprovalAttempt(order: OrderRecord): Promise<OrderRecord> {
  if (!order.inventory || order.inventory.state !== "RESERVED")
    throw new InventoryError("INVENTORY_RESERVATION_REQUIRED");
  if (order.inventory.approvalAttemptedAt)
    throw new InventoryError("PAYMENT_APPROVAL_ALREADY_ATTEMPTED");
  // Unique claim prevents two simultaneous callers from treating the same CAS success as their own.
  return writeInventoryOrder(order, {
    ...order,
    inventory: {
      ...order.inventory,
      version: order.inventory.version + 1,
      approvalAttemptedAt: new Date().toISOString(),
      approvalAttemptId: randomUUID(),
    },
  });
}

export async function rejectApproval(
  order: OrderRecord,
  code: string,
): Promise<OrderRecord> {
  const ledger = order.inventory;
  if (!ledger || ledger.state !== "RESERVED" || !ledger.approvalAttemptedAt)
    throw new InventoryError("INVENTORY_RESERVATION_REQUIRED");
  const changes = new Map(
    [...aggregateStock(order.lines)].map(([id, q]) => [
      id,
      { quantity: 0, reserved: -q },
    ]),
  );
  return writeInventoryOrder(
    order,
    {
      ...order,
      status: "FAILED",
      paymentStatus: "ABORTED",
      inventory: {
        ...ledger,
        version: ledger.version + 1,
        state: "RELEASED",
        approvalFailureCode: code,
      },
    },
    changes,
  );
}

/** Expired reservation with no approval claim is provably unattempted. CAS excludes a late approval claimant. */
export async function releaseUnattemptedReservation(
  order: OrderRecord,
): Promise<OrderRecord> {
  const ledger = order.inventory;
  if (
    !ledger ||
    ledger.state !== "RESERVED" ||
    ledger.approvalAttemptedAt ||
    Date.parse(ledger.expiresAt) > Date.now()
  )
    throw new InventoryError("PAYMENT_RESERVATION_NOT_RELEASABLE");
  return writeInventoryOrder(
    order,
    {
      ...order,
      status: "FAILED",
      paymentStatus: "EXPIRED",
      inventory: {
        ...ledger,
        version: ledger.version + 1,
        state: "RELEASED",
        approvalFailureCode: "EXPIRED_WITHOUT_APPROVAL_ATTEMPT",
      },
    },
    new Map(
      [...aggregateStock(order.lines)].map(([id, q]) => [
        id,
        { quantity: 0, reserved: -q },
      ]),
    ),
  );
}

/** Server lookup, never event/body status. Expiry alone is NOT proof of payment failure. */
export async function settleInventoryPayment(
  order: OrderRecord,
  payment: TossPayment,
): Promise<OrderRecord> {
  const key = order.inventory?.paymentKey ?? order.providerPaymentKey;
  if (!key || !paymentMatchesOrder(payment, order, key))
    throw new InventoryError("PAYMENT_PROVIDER_MISMATCH", 502);
  const canceled = verifiedCancellation(payment);
  if (["CANCELED", "PARTIAL_CANCELED"].includes(payment.status) && !canceled)
    throw new InventoryError("PAYMENT_CANCELLATION_UNVERIFIED", 502);
  if (
    !["DONE", "CANCELED", "PARTIAL_CANCELED", "ABORTED", "EXPIRED"].includes(
      payment.status,
    )
  )
    return order;
  if (
    payment.status === "DONE" &&
    (payment.balanceAmount !== order.total || payment.cancels.length)
  )
    throw new InventoryError("PAYMENT_PROVIDER_MISMATCH", 502);
  const ledger = order.inventory;
  const failed = ["ABORTED", "EXPIRED"].includes(payment.status);
  const beforeRefund = Math.max(
    ledger?.refundedAmount ?? 0,
    order.financialRefundedAmount ?? 0,
  );
  if (failed && payment.cancels.length)
    throw new InventoryError("PAYMENT_PROVIDER_MISMATCH", 502);
  // Failure/expiry proves no new refund. A zero provider balance is not cancellation evidence.
  const refundedAmount = failed ? beforeRefund : order.total - payment.balanceAmount;
  if (
    refundedAmount < beforeRefund ||
    (order.status === "REFUNDED" && payment.status !== "CANCELED")
  )
    throw new InventoryError("PAYMENT_STALE_STATE", 503);
  if (ledger?.state === "RELEASED") {
    if (!failed && payment.status !== "CANCELED")
      throw new InventoryError("PAYMENT_RELEASED_REQUIRES_REVIEW", 503);
    return order;
  }
  if ((ledger?.state === "DEBITED" || ledger?.state === "LEGACY") && failed)
    throw new InventoryError("PAYMENT_STATE_REQUIRES_REVIEW", 503);
  const fullCancel = payment.status === "CANCELED";
  let nextLedger = ledger
    ? {
        ...ledger,
        version: ledger.version + 1,
        refundedAmount,
      }
    : undefined;
  const changes = new Map<string, StockDelta>();
  if (ledger?.state === "RESERVED") {
    for (const [id, q] of aggregateStock(order.lines))
      changes.set(id, { quantity: failed || fullCancel ? 0 : -q, reserved: -q });
    nextLedger = {
      ...nextLedger!,
      state: failed || fullCancel ? "RELEASED" : "DEBITED",
    };
  } else if (
    ledger?.state === "DEBITED" &&
    fullCancel &&
    ledger.fulfillment === "UNSHIPPED" &&
    !ledger.pendingRefund &&
    !ledger.nonStockRefund
  ) {
    const remaining = order.lines.map((line, i) => line.quantity - ledger.restored[i]!);
    for (const [id, q] of aggregateStock(order.lines, remaining))
      changes.set(id, { quantity: q, reserved: 0 });
    nextLedger = {
      ...nextLedger!,
      restored: order.lines.map((l) => l.quantity),
      canceled: order.lines.map((l) => l.quantity),
    };
  }
  const status = failed ? "FAILED" : fullCancel ? "REFUNDED" : "PAID";
  if (!ledger) {
    // Legacy has no stock proof: update money only; never invent a debit/restoration marker.
    if (
      order.status !== "PENDING_PAYMENT" &&
      order.status !== "PAID" &&
      order.status !== status
    )
      throw new InventoryError("PAYMENT_STATE_REQUIRES_REVIEW", 503);
    if (order.status === "PAID" && failed)
      throw new InventoryError("PAYMENT_STATE_REQUIRES_REVIEW", 503);
  }
  return writeInventoryOrder(
    order,
    {
      ...order,
      status,
      financialRefundedAmount: refundedAmount,
      paymentStatus: payment.status,
      providerPaymentStatus: payment.status,
      ...(!failed && (!fullCancel || payment.approvedAt)
        ? { paidAt: order.paidAt ?? payment.approvedAt ?? new Date().toISOString() }
        : {}),
      ...(fullCancel
        ? { refundedAt: order.refundedAt ?? new Date().toISOString() }
        : {}),
      ...(nextLedger ? { inventory: nextLedger } : {}),
    },
    changes,
    payment,
  );
}
