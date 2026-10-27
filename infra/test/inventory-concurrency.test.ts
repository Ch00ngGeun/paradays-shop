import assert from "node:assert/strict";
import test from "node:test";
import {
  markApprovalAttempt,
  releaseUnattemptedReservation,
  reserveInventory,
  settleInventoryPayment,
} from "../lambda/order-inventory-store.js";
import { paymentFixture, savedOrder } from "./payment-flow-fixture.js";
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
test("legacy monetary CAS rejects stale same-status overwrites and failed status regression without creating inventory proof", async (t) => {
  const order = savedOrder({ status: "PAID", providerPaymentKey: "pk" });
  const db = paymentFixture(t, order);
  const partial = {
    ...payment,
    status: "PARTIAL_CANCELED",
    balanceAmount: 100,
    cancels: [
      {
        transactionKey: "tx",
        cancelAmount: 100,
        cancelStatus: "DONE",
        cancelReason: "external",
      },
    ],
  };
  const changed = await settleInventoryPayment(order, partial);
  assert.equal(changed.financialRefundedAmount, 100);
  assert.equal(changed.inventory, undefined);
  await assert.rejects(() => settleInventoryPayment(order, payment));
  await assert.rejects(() => settleInventoryPayment(changed, payment), /STALE/);
  await assert.rejects(() =>
    settleInventoryPayment(changed, { ...payment, status: "ABORTED" }),
  );
  assert.equal(db.order().paymentStatus, "PARTIAL_CANCELED");
  assert.equal(db.product().inventoryQuantity, 4);
});
test("expired unattempted reservation release excludes a late approval claimant", async (t) => {
  const order = savedOrder({
    checkoutReturnExpiresAt: new Date(Date.now() - 1000).toISOString(),
  });
  const db = paymentFixture(t, order);
  const reserved = await reserveInventory(order, "pk");
  const results = await Promise.allSettled([
    releaseUnattemptedReservation(reserved),
    markApprovalAttempt(reserved),
  ]);
  assert.equal(results.filter((result) => result.status === "fulfilled").length, 1);
  assert.equal(db.calls.length, 0);
  const current = db.order();
  if (current.inventory?.state === "RELEASED")
    assert.equal(db.product().inventoryReserved, 0);
  else {
    assert.equal(db.product().inventoryReserved, 2);
    assert.ok(current.inventory?.approvalAttemptedAt);
  }
});
test("last available units can be reserved by only one concurrent order", async (t) => {
  const first = savedOrder();
  const second = savedOrder({ orderId: "pd_order_002", requestFingerprint: "second" });
  const db = paymentFixture(t, first);
  db.records.set(
    "orders:pd_order_002",
    structuredClone(second) as unknown as Record<string, unknown>,
  );
  db.records.set("catalog:prd_deck", { ...db.product(), inventoryQuantity: 2 });
  const results = await Promise.allSettled([
    reserveInventory(first, "pk"),
    reserveInventory(second, "other"),
  ]);
  assert.equal(results.filter((result) => result.status === "fulfilled").length, 1);
  assert.equal(db.product().inventoryReserved, 2);
  assert.equal(db.product().inventoryQuantity, 2);
  assert.equal(db.calls.length, 0);
});
test("lost transaction response reconciles committed proof instead of debiting twice", async (t) => {
  const order = savedOrder();
  const db = paymentFixture(t, order);
  const reserved = await reserveInventory(order, "pk");
  db.loseResponse();
  const settled = await settleInventoryPayment(reserved, payment);
  assert.equal(settled.inventory?.state, "DEBITED");
  assert.equal(db.product().inventoryQuantity, 2);
  assert.equal(db.product().inventoryCommitted, 2);
});
test("OCR/catalog version contention rereads stock and preserves the concurrent intake", async (t) => {
  const order = savedOrder();
  const db = paymentFixture(t, order);
  db.beforeTransaction(() => {
    db.records.set("catalog:prd_deck", {
      ...db.product(),
      inventoryQuantity: 9,
      version: 2,
    });
    db.records.set("catalog:~catalog_revision", {
      productId: "~catalog_revision",
      recordType: "CATALOG_IDENTITY_REVISION",
      version: 1,
    });
  });
  const reserved = await reserveInventory(order, "pk");
  assert.equal(reserved.inventory?.state, "RESERVED");
  assert.equal(db.product().inventoryQuantity, 9);
  assert.equal(db.product().inventoryReserved, 2);
  assert.equal(db.product().version, 3);
});
test("already-held DONE settles the saved snapshot even after a catalog publication change", async (t) => {
  const order = savedOrder();
  const db = paymentFixture(t, order);
  const reserved = await reserveInventory(order, "pk");
  db.records.set("catalog:prd_deck", {
    ...db.product(),
    status: "DRAFT",
    price: 999,
    sizes: ["changed"],
    version: 3,
  });
  const paid = await settleInventoryPayment(reserved, payment);
  assert.equal(paid.status, "PAID");
  assert.equal(db.product().inventoryQuantity, 2);
  assert.equal(db.product().inventoryReserved, 0);
});
