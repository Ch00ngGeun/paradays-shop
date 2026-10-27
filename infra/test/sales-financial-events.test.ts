import assert from "node:assert/strict";
import test from "node:test";
import { GetCommand, TransactWriteCommand } from "@aws-sdk/lib-dynamodb";
import { documentClient } from "../lambda/dynamodb-client.js";
import { writeInventoryOrder } from "../lambda/order-inventory-store.js";
import { validFinancialEvents, type OrderRecord } from "../lambda/order-record.js";
import type { TossPayment } from "../lambda/toss-payments.js";
process.env.ORDER_TABLE_NAME = "test_orders";
process.env.CATALOG_TABLE_NAME = "test_catalog";
const order = {
  orderId: "pd_sale_test",
  userSub: "test",
  status: "PAID",
  paymentStatus: "DONE",
  provider: "toss",
  currency: "KRW",
  subtotal: 100,
  total: 100,
  orderName: "Deck",
  lines: [
    {
      productId: "prd_deck",
      name: "Deck",
      selectedSize: "8",
      quantity: 1,
      unitPrice: 100,
      lineTotal: 100,
    },
  ],
  idempotencyKeyHash: "hash",
  requestFingerprint: "fp",
  checkoutReturnTokenHash: "hash",
  checkoutReturnExpiresAt: "2026-10-15T00:00:00Z",
  createdAt: "2026-10-15T00:00:00Z",
  updatedAt: "2026-10-15T00:00:00Z",
  paidAt: "2026-10-15T00:00:00Z",
} as const satisfies OrderRecord;
test("financial evidence shares order transaction; cumulative refunds append only increases", async (t) => {
  let current: OrderRecord = order;
  t.mock.method(documentClient, "send", async (c: unknown) => {
    if (c instanceof GetCommand) return { Item: current };
    assert.ok(c instanceof TransactWriteCommand);
    current = c.input.TransactItems![0]!.Put!.Item! as OrderRecord;
    return {};
  });
  const first = await writeInventoryOrder(order, {
    ...order,
    financialRefundedAmount: 20,
  });
  assert.deepEqual(
    first.financialEvents?.map((e) => [e.kind, e.amount, e.timeBasis]),
    [
      ["APPROVAL", 100, "OBSERVED"],
      ["REFUND", 20, "OBSERVED"],
    ],
  );
  const repeat = await writeInventoryOrder(first, first);
  assert.equal(repeat.financialEvents?.length, 2);
  const next = await writeInventoryOrder(repeat, {
    ...repeat,
    financialRefundedAmount: 50,
  });
  assert.deepEqual(
    next.financialEvents?.filter((e) => e.kind === "REFUND").map((e) => e.amount),
    [20, 30],
  );
  await assert.rejects(
    () => writeInventoryOrder(next, { ...next, financialRefundedAmount: 10 }),
    /PAYMENT_STALE_STATE/,
  );
  assert.equal(
    validFinancialEvents([next.financialEvents![0], next.financialEvents![0]], 100),
    false,
  );
});
test("verified provider cancellation times survive delayed observation and transaction retries cannot duplicate events", async (t) => {
  let current: OrderRecord = order;
  t.mock.method(documentClient, "send", async (c: unknown) => {
    if (c instanceof GetCommand) return { Item: current };
    assert.ok(c instanceof TransactWriteCommand);
    current = c.input.TransactItems![0]!.Put!.Item! as OrderRecord;
    return {};
  });
  const proof: TossPayment = {
    paymentKey: "pk",
    orderId: order.orderId,
    totalAmount: 100,
    balanceAmount: 80,
    status: "PARTIAL_CANCELED",
    method: "카드",
    currency: "KRW",
    approvedAt: order.paidAt,
    cancels: [
      {
        transactionKey: "tx1",
        cancelAmount: 20,
        cancelStatus: "DONE",
        cancelReason: "reason",
        canceledAt: "2026-10-15T01:00:00+09:00",
      },
    ],
  };
  // A refund cannot precede approval. Invalid chronological evidence uses observation time.
  const invalid = await writeInventoryOrder(
    order,
    { ...order, financialRefundedAmount: 20 },
    new Map(),
    proof,
  );
  assert.equal(invalid.financialEvents![1].timeBasis, "OBSERVED");
  current = order;
  const first = await writeInventoryOrder(
    order,
    { ...order, financialRefundedAmount: 20 },
    new Map(),
    {
      ...proof,
      cancels: [{ ...proof.cancels[0], canceledAt: "2026-10-15T01:00:00Z" }],
    },
  );
  assert.equal(first.financialEvents![0].timeBasis, "PROVIDER");
  assert.equal(first.financialEvents![1].timeBasis, "PROVIDER");
  assert.equal(first.financialEvents![1].transactionKey, "tx1");
  assert.equal(first.financialEvents![1].occurredAt, "2026-10-15T01:00:00.000Z");
  const secondProof = {
    ...proof,
    balanceAmount: 50,
    cancels: [
      { ...proof.cancels[0], canceledAt: "2026-10-15T01:00:00Z" },
      {
        transactionKey: "tx2",
        cancelAmount: 30,
        cancelStatus: "DONE",
        cancelReason: "reason",
        canceledAt: "2026-10-16T01:00:00Z",
      },
    ],
  };
  const second = await writeInventoryOrder(
    first,
    { ...first, financialRefundedAmount: 50 },
    new Map(),
    secondProof,
  );
  assert.deepEqual(
    second.financialEvents
      ?.filter((e) => e.kind === "REFUND")
      .map((e) => [e.amount, e.transactionKey]),
    [
      [20, "tx1"],
      [30, "tx2"],
    ],
  );
});
