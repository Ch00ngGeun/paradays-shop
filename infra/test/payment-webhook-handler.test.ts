import assert from "node:assert/strict";
import test from "node:test";
import { handler } from "../lambda/payment-webhook-handler.js";
import { reserveInventory } from "../lambda/order-inventory-store.js";
import { event, paymentFixture, response, savedOrder } from "./payment-flow-fixture.js";
const payment = {
  paymentKey: "pk",
  orderId: "pd_order_001",
  totalAmount: 200,
  balanceAmount: 200,
  status: "DONE",
  method: "카드",
  currency: "KRW",
  cancels: [],
};
const webhook = () =>
  event({
    eventType: "PAYMENT_STATUS_CHANGED",
    data: { paymentKey: "pk", status: "forged" },
  });
test("webhook and repeated delivery share one debit proof and ignore input status", async (t) => {
  const db = paymentFixture(t, savedOrder());
  await reserveInventory(savedOrder(), "pk");
  db.setProvider(() => payment);
  assert.equal(response(await handler(webhook())).status, 200);
  assert.equal(db.product().inventoryQuantity, 2);
  assert.equal(response(await handler(webhook())).body.duplicate, true);
  assert.equal(db.product().inventoryQuantity, 2);
  assert.equal(db.calls.length, 1);
});
test("storage or paymentKey mismatch cannot consume an event", async (t) => {
  const db = paymentFixture(t, savedOrder());
  db.setProvider(() => ({ ...payment, paymentKey: "other" }));
  assert.equal(response(await handler(webhook())).status, 503);
  assert.equal(
    [...db.records.keys()].some((k) => k.startsWith("events:")),
    false,
  );
  db.failRead();
  assert.equal(response(await handler(webhook())).status, 503);
});
test("verified late payment after release is not silently accepted", async (t) => {
  const db = paymentFixture(
    t,
    savedOrder({
      status: "FAILED",
      providerPaymentKey: "pk",
      inventory: {
        schema: 1,
        version: 1,
        state: "RELEASED",
        paymentKey: "pk",
        expiresAt: new Date().toISOString(),
        fulfillment: "UNCONFIRMED",
        restored: [0],
        canceled: [0],
        refundedAmount: 0,
        operations: {},
      },
    }),
  );
  db.setProvider(() => payment);
  assert.equal(response(await handler(webhook())).status, 503);
  assert.equal(db.product().inventoryQuantity, 4);
  assert.equal(
    [...db.records.keys()].some((k) => k.startsWith("events:")),
    false,
  );
});
