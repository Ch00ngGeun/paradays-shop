import assert from "node:assert/strict";
import test from "node:test";
import { isOrderRecord, validFinancialEvents } from "../lambda/order-record.js";

// A record stored before inventory/financial fields existed.
const legacy = {
  orderId: "order_legacy_001",
  userSub: "user-sub",
  status: "PAID",
  paymentStatus: "DONE",
  provider: "toss",
  currency: "KRW",
  subtotal: 30_000,
  total: 30_000,
  orderName: "TEST DECK",
  lines: [
    {
      productId: "TEST_DECK",
      name: "TEST DECK",
      selectedSize: "8.0",
      quantity: 2,
      unitPrice: 15_000,
      lineTotal: 30_000,
    },
  ],
  idempotencyKeyHash: "hash",
  requestFingerprint: "fingerprint",
  checkoutReturnTokenHash: "token-hash",
  checkoutReturnExpiresAt: "2026-10-27T00:00:00.000Z",
  createdAt: "2026-10-26T00:00:00.000Z",
  updatedAt: "2026-10-26T00:00:00.000Z",
};
const approval = {
  eventId: "evt_approval",
  kind: "APPROVAL",
  amount: 30_000,
  occurredAt: "2026-10-26T00:00:00.000Z",
  recordedAt: "2026-10-26T00:00:01.000Z",
  timeBasis: "PROVIDER",
};

test("legacy stored orders without new optional fields still load", () => {
  assert.equal(isOrderRecord(legacy), true);
});

test("new optional payment fields are accepted when valid", () => {
  assert.equal(
    isOrderRecord({
      ...legacy,
      paymentVersion: 1,
      financialRefundedAmount: 0,
      financialEvents: [approval],
    }),
    true,
  );
});

test("lines that do not add up to the stored total are rejected", () => {
  assert.equal(isOrderRecord({ ...legacy, subtotal: 29_000, total: 29_000 }), false);
  assert.equal(isOrderRecord({ ...legacy, lines: [] }), false);
});

test("invalid optional payment fields are rejected", () => {
  assert.equal(isOrderRecord({ ...legacy, paymentVersion: 0 }), false);
  assert.equal(isOrderRecord({ ...legacy, financialRefundedAmount: 30_001 }), false);
});

test("financial events stay bounded, unique and within the order total", () => {
  const refund = { ...approval, eventId: "evt_refund", kind: "REFUND", amount: 10_000 };
  assert.equal(validFinancialEvents([approval, refund], 30_000), true);
  assert.equal(validFinancialEvents([approval, approval], 30_000), false);
  assert.equal(validFinancialEvents([{ ...approval, amount: 1 }], 30_000), false);
  assert.equal(
    validFinancialEvents(
      [refund, { ...refund, eventId: "evt_refund_2", amount: 20_001 }],
      30_000,
    ),
    false,
  );
});
