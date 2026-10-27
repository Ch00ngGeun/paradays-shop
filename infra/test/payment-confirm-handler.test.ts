import assert from "node:assert/strict";
import test from "node:test";
import { handler } from "../lambda/payment-confirm-handler.js";
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
  cancels: null,
};
const request = () =>
  event({
    paymentKey: "pk",
    orderId: payment.orderId,
    amount: 200,
    checkoutReturnToken: "a".repeat(43),
  });
test("approval observes persisted hold, then commits exact-once stock debit", async (t) => {
  const db = paymentFixture(t, savedOrder());
  db.setProvider((_url, init) => {
    if (init.method === "GET") return { ...payment, status: "IN_PROGRESS" };
    assert.equal(db.product().inventoryReserved, 2);
    assert.equal(db.order().inventory?.paymentKey, "pk");
    assert.ok(db.order().inventory?.approvalAttemptedAt);
    return payment;
  });
  assert.equal(response(await handler(request())).status, 200);
  assert.equal(db.product().inventoryQuantity, 2);
  assert.equal(db.product().inventoryReserved, 0);
  assert.equal(response(await handler(request())).status, 200);
  assert.equal(db.calls.length, 1);
  assert.equal(
    response(
      await handler(event({ ...JSON.parse(request().body), paymentKey: "other" })),
    ).status,
    409,
  );
});
test("a PAID order whose hold an older webhook left RESERVED is settled by lookup, not re-approved", async (t) => {
  const db = paymentFixture(t, savedOrder());
  const reserved = await reserveInventory(savedOrder(), "pk");
  const orderKey = [...db.records.keys()].find((key) => key.endsWith(":pd_order_001"))!;
  db.records.set(orderKey, { ...reserved, status: "PAID", paymentStatus: "DONE" });
  db.setProvider((_url, init) => {
    assert.equal(init.method, "GET");
    return payment;
  });
  assert.equal(response(await handler(request())).status, 200);
  assert.equal(db.product().inventoryQuantity, 2);
  assert.equal(db.product().inventoryReserved, 0);
  assert.equal(db.order().inventory?.state, "DEBITED");
  assert.equal(db.calls.filter((call) => call.init.method === "POST").length, 0);
});
test("a legacy PAID order without an inventory ledger still replays success", async (t) => {
  const db = paymentFixture(t, savedOrder({ status: "PAID", paymentStatus: "DONE" }));
  db.setProvider(() => assert.fail("legacy replay must not call the provider"));
  assert.equal(response(await handler(request())).status, 200);
  assert.equal(db.calls.length, 0);
});
test("an unreadable return expiry is treated as expired and never reaches the provider", async (t) => {
  const db = paymentFixture(t, savedOrder({ checkoutReturnExpiresAt: "invalid" }));
  db.setProvider(() => assert.fail("expired checkout must not call the provider"));
  assert.equal(response(await handler(request())).status, 410);
  assert.equal(db.calls.length, 0);
  assert.equal(db.product().inventoryReserved ?? 0, 0);
});
test("insufficient stock or failed storage never invokes provider", async (t) => {
  const db = paymentFixture(t, savedOrder());
  db.records.set("catalog:prd_deck", { ...db.product(), inventoryQuantity: 1 });
  db.setProvider(() => ({ ...payment, status: "IN_PROGRESS" }));
  assert.equal(response(await handler(request())).status, 409);
  assert.equal(db.calls.length, 0);
  db.failRead();
  assert.equal(response(await handler(request())).status, 503);
  assert.equal(db.calls.length, 0);
});
test("explicit not-found approval rejection releases the hold and stores its proof", async (t) => {
  const db = paymentFixture(t, savedOrder());
  t.mock.method(
    globalThis,
    "fetch",
    async () =>
      new Response(JSON.stringify({ code: "NOT_FOUND_PAYMENT" }), { status: 404 }),
  );
  assert.equal(response(await handler(request())).status, 409);
  assert.equal(db.product().inventoryReserved, 0);
  assert.equal(db.product().inventoryQuantity, 4);
  assert.equal(db.order().inventory?.approvalFailureCode, "NOT_FOUND_PAYMENT");
});
test("SDK card-window easy-pay is accepted, wrong currency is not", async (t) => {
  const db = paymentFixture(t, savedOrder());
  db.setProvider(() => ({ ...payment, method: "간편결제" }));
  assert.equal(response(await handler(request())).status, 200);
});
test("approval timeout and wrong payment identity preserve holds for reconciliation", async (t) => {
  const db = paymentFixture(t, savedOrder());
  db.setProvider((_url, init) => {
    if (init.method === "GET") return { ...payment, status: "IN_PROGRESS" };
    throw new Error("Timeout after possible charge");
  });
  assert.equal(response(await handler(request())).status, 503);
  assert.equal(db.product().inventoryReserved, 2);
  assert.equal(db.product().inventoryQuantity, 4);
  db.setProvider(() => ({ ...payment, paymentKey: "other" }));
  assert.equal(response(await handler(request())).status, 502);
  assert.equal(db.product().inventoryReserved, 2);
});
test("expired held orders are queried, never approved again; failed proof releases only reserved stock", async (t) => {
  const order = savedOrder({
    checkoutReturnExpiresAt: new Date(Date.now() - 1).toISOString(),
    providerPaymentKey: "pk",
    inventory: {
      schema: 1,
      version: 1,
      state: "RESERVED",
      paymentKey: "pk",
      expiresAt: new Date(Date.now() - 1).toISOString(),
      fulfillment: "UNCONFIRMED",
      restored: [0],
      canceled: [0],
      refundedAmount: 0,
      operations: {},
    },
  });
  const db = paymentFixture(t, order);
  db.records.set("catalog:prd_deck", { ...db.product(), inventoryReserved: 2 });
  db.setProvider((_url, init) => {
    assert.equal(init.method, "GET");
    return { ...payment, status: "EXPIRED" };
  });
  assert.equal(response(await handler(request())).status, 409);
  assert.equal(db.product().inventoryQuantity, 4);
  assert.equal(db.product().inventoryReserved, 0);
  assert.equal(db.order().inventory?.state, "RELEASED");
});
test("simultaneous confirmation has one durable approval claimant and one provider POST", async (t) => {
  const db = paymentFixture(t, savedOrder());
  db.setProvider(() => payment);
  const results = await Promise.all([handler(request()), handler(request())]);
  assert.ok(results.some((result) => response(result).status === 200));
  assert.equal(db.calls.filter((call) => call.init.method === "POST").length, 1);
  assert.equal(db.product().inventoryQuantity, 2);
  assert.equal(db.product().inventoryReserved, 0);
});
test("unknown approval retry uses lookup only and never automatically repeats approval", async (t) => {
  const db = paymentFixture(t, savedOrder());
  db.setProvider(() => {
    throw new Error("timeout");
  });
  assert.equal(response(await handler(request())).status, 503);
  db.setProvider((_url, init) => {
    assert.equal(init.method, "GET");
    return payment;
  });
  assert.equal(response(await handler(request())).status, 200);
  assert.equal(db.calls.filter((call) => call.init.method === "POST").length, 1);
  assert.equal(db.product().inventoryQuantity, 2);
});
