/** Shared transactional writer: order proof, product versions and OCR catalog revision commit together. */
import {
  GetCommand,
  TransactWriteCommand,
  type TransactWriteCommandInput,
} from "@aws-sdk/lib-dynamodb";
import { randomUUID } from "node:crypto";
import { documentClient, getRequiredEnvironment } from "./dynamodb-client.js";
import { salesRequestSignal } from "./sales-request-deadline.js";
import {
  isOrderRecord,
  validFinancialEvents,
  type FinancialEvent,
  type OrderRecord,
} from "./order-record.js";
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
type Write = NonNullable<TransactWriteCommandInput["TransactItems"]>[number];
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
/** Whole order CAS serializes fulfillment, refund intents and all inventory operations. */
export async function writeInventoryOrder(
  order: OrderRecord,
  next: OrderRecord,
  deltas: ReadonlyMap<string, StockDelta> = new Map(),
  financialProof?: TossPayment,
): Promise<OrderRecord> {
  const orderTable = getRequiredEnvironment("ORDER_TABLE_NAME");
  const catalogTable = getRequiredEnvironment("CATALOG_TABLE_NAME");
  const timestamp = new Date().toISOString();
  const paymentVersion = (order.paymentVersion ?? 0) + 1;
  const financialEvents: FinancialEvent[] = [...(order.financialEvents ?? [])];
  if (next.paidAt && !financialEvents.some((event) => event.kind === "APPROVAL")) {
    const validProviderTime =
      !!financialProof?.approvedAt &&
      Number.isFinite(Date.parse(financialProof.approvedAt)) &&
      Date.parse(financialProof.approvedAt) <= Date.parse(timestamp);
    financialEvents.push({
      eventId: `financial_${paymentVersion}_approval`,
      kind: "APPROVAL",
      amount: next.total,
      occurredAt: validProviderTime
        ? new Date(financialProof!.approvedAt!).toISOString()
        : Number.isFinite(Date.parse(next.paidAt)) &&
            Date.parse(next.paidAt) <= Date.parse(timestamp)
          ? new Date(next.paidAt).toISOString()
          : timestamp,
      recordedAt: timestamp,
      timeBasis: validProviderTime ? "PROVIDER" : "OBSERVED",
    });
  }
  const beforeRefund = Math.max(
    order.financialRefundedAmount ?? 0,
    order.inventory?.refundedAmount ?? 0,
  );
  const afterRefund = Math.max(
    next.financialRefundedAmount ?? 0,
    next.inventory?.refundedAmount ?? 0,
  );
  if (afterRefund < beforeRefund) throw new InventoryError("PAYMENT_STALE_STATE", 503);
  if (afterRefund > beforeRefund) {
    const known = new Set(
      [
        ...(order.financialEvents ?? []).map((e) => e.transactionKey),
        ...Object.values(order.inventory?.operations ?? {}).map(
          (e) => e.transactionKey,
        ),
      ].filter(Boolean),
    );
    const cancellations =
      financialProof?.cancels.filter((c) => !known.has(c.transactionKey)) ?? [];
    const delta = afterRefund - beforeRefund;
    const providerDated =
      !!financialProof &&
      verifiedCancellation(financialProof) &&
      cancellations.length > 0 &&
      cancellations.reduce((sum, c) => sum + c.cancelAmount, 0) === delta &&
      cancellations.every(
        (c) =>
          c.canceledAt &&
          Number.isFinite(Date.parse(c.canceledAt)) &&
          Date.parse(c.canceledAt) <= Date.parse(timestamp) &&
          (!next.paidAt || Date.parse(c.canceledAt) >= Date.parse(next.paidAt)),
      );
    if (providerDated)
      for (const [index, cancellation] of cancellations.entries())
        financialEvents.push({
          eventId: `financial_${paymentVersion}_refund_${index}`,
          kind: "REFUND",
          amount: cancellation.cancelAmount,
          occurredAt: new Date(cancellation.canceledAt!).toISOString(),
          recordedAt: timestamp,
          timeBasis: "PROVIDER",
          transactionKey: cancellation.transactionKey,
        });
    else
      financialEvents.push({
        eventId: `financial_${paymentVersion}_refund`,
        kind: "REFUND",
        amount: afterRefund - beforeRefund,
        occurredAt: timestamp,
        recordedAt: timestamp,
        timeBasis: "OBSERVED",
      });
  }
  if (!validFinancialEvents(financialEvents, next.total))
    throw new InventoryError("FINANCIAL_EVENTS_INVALID", 503);
  const item = {
    ...next,
    updatedAt: timestamp,
    paymentVersion,
    ...(financialEvents.length ? { financialEvents } : {}),
  };
  for (let attempt = 0; attempt < 4; attempt++) {
    const financialCondition =
      order.paymentVersion === undefined
        ? "attribute_not_exists(paymentVersion)"
        : "paymentVersion = :paymentVersion";
    const writes: Write[] = [
      {
        Put: {
          TableName: orderTable,
          Item: item,
          ConditionExpression: `${order.inventory ? "inventory.#version = :version AND requestFingerprint = :fingerprint" : "attribute_not_exists(inventory) AND #status = :status AND requestFingerprint = :fingerprint"} AND ${financialCondition}`,
          ExpressionAttributeNames: order.inventory
            ? { "#version": "version" }
            : { "#status": "status" },
          ExpressionAttributeValues: {
            ...(order.inventory
              ? {
                  ":version": order.inventory.version,
                  ":fingerprint": order.requestFingerprint,
                }
              : { ":status": order.status, ":fingerprint": order.requestFingerprint }),
            ...(order.paymentVersion === undefined
              ? {}
              : { ":paymentVersion": order.paymentVersion }),
          },
        },
      },
    ];
    if (deltas.size) {
      const products = await readProducts([...deltas.keys()]);
      for (const [id, delta] of deltas) {
        const p = products.get(id)!;
        const reserved = p.inventoryReserved ?? 0;
        if (
          delta.reserved > 0 &&
          order.lines
            .filter((line) => line.productId === id)
            .some(
              (line) =>
                p.status !== "PUBLISHED" ||
                p.price !== line.unitPrice ||
                !p.sizes.includes(line.selectedSize),
            )
        )
          throw new InventoryError("CHECKOUT_CATALOG_CHANGED");
        const quantity = p.inventoryQuantity + delta.quantity;
        const nextReserved = reserved + delta.reserved;
        const committed = (p.inventoryCommitted ?? 0) - delta.quantity;
        if (
          !stockInteger(quantity) ||
          !stockInteger(nextReserved, quantity) ||
          !stockInteger(committed, Number.MAX_SAFE_INTEGER - 1)
        )
          throw new InventoryError("INVENTORY_INSUFFICIENT_OR_CONFLICT");
        writes.push({
          Update: {
            TableName: catalogTable,
            Key: { productId: id },
            ConditionExpression: "#version = :version",
            UpdateExpression:
              "SET inventoryQuantity = :quantity, inventoryReserved = :reserved, inventoryCommitted = :committed, #version = :nextVersion, updatedAt = :updatedAt",
            ExpressionAttributeNames: { "#version": "version" },
            ExpressionAttributeValues: {
              ":version": p.version,
              ":quantity": quantity,
              ":reserved": nextReserved,
              ":committed": committed,
              ":nextVersion": p.version + 1,
              ":updatedAt": timestamp,
            },
          },
        });
      }
      const { Item: revision } = await documentClient.send(
        new GetCommand({
          TableName: catalogTable,
          Key: { productId: "~catalog_revision" },
          ConsistentRead: true,
        }),
      );
      if (
        revision &&
        (revision.recordType !== "CATALOG_IDENTITY_REVISION" ||
          !stockInteger(revision.version, Number.MAX_SAFE_INTEGER - 1) ||
          revision.version < 1)
      )
        throw new InventoryError("CATALOG_REVISION_INVALID", 503);
      const version = (revision?.version as number | undefined) ?? 0;
      writes.push({
        Put: {
          TableName: catalogTable,
          Item: {
            productId: "~catalog_revision",
            recordType: "CATALOG_IDENTITY_REVISION",
            version: version + 1,
          },
          ConditionExpression: version
            ? "#version = :version"
            : "attribute_not_exists(productId)",
          ...(version
            ? {
                ExpressionAttributeNames: { "#version": "version" },
                ExpressionAttributeValues: { ":version": version },
              }
            : {}),
        },
      });
    }
    try {
      await documentClient.send(new TransactWriteCommand({ TransactItems: writes }));
      return item;
    } catch (error) {
      const current = await readOrder(order.orderId);
      if (
        current &&
        current.paymentVersion === item.paymentVersion &&
        current.status === item.status &&
        current.paymentStatus === item.paymentStatus &&
        current.providerPaymentKey === item.providerPaymentKey &&
        current.financialRefundedAmount === item.financialRefundedAmount &&
        JSON.stringify(current.financialEvents) ===
          JSON.stringify(item.financialEvents) &&
        JSON.stringify(current.inventory) === JSON.stringify(item.inventory)
      )
        return current;
      if (
        current?.paymentVersion !== order.paymentVersion ||
        current?.inventory?.version !== order.inventory?.version ||
        current?.status !== order.status
      )
        throw new InventoryError("ORDER_OPERATION_CONFLICT");
      if (
        !(
          error &&
          typeof error === "object" &&
          "name" in error &&
          error.name === "TransactionCanceledException"
        )
      )
        throw new InventoryError("INVENTORY_STORAGE_UNAVAILABLE", 503);
    }
  }
  throw new InventoryError("INVENTORY_CONCURRENT_CHANGE");
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
