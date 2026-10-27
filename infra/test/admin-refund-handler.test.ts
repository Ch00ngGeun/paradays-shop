import assert from "node:assert/strict";
import test from "node:test";
import { handler } from "../lambda/admin-refund-handler.js";
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
test("all order APIs require admin; GET is allowlisted and never queries PG", async (t) => {
  const db = paymentFixture(t, savedOrder());
  assert.equal(
    response(await handler(event(undefined, false, payment.orderId, "GET"))).status,
    403,
  );
  const result = response(
    await handler(event(undefined, true, payment.orderId, "GET")),
  );
  assert.equal(result.status, 200);
  assert.equal(result.body.order.inventory, null);
  assert.equal(result.body.order.userSub, undefined);
  assert.equal(result.body.order.checkoutReturnTokenHash, undefined);
  assert.equal(db.calls.length, 0);
});
test("reconcile checks PG to settle held orders; fulfillment/return contracts stay separate", async (t) => {
  const db = paymentFixture(t, savedOrder());
  await reserveInventory(savedOrder(), "pk");
  db.setProvider(() => payment);
  const result = response(
    await handler(event({ action: "reconcile" }, true, payment.orderId)),
  );
  assert.equal(result.status, 200);
  assert.equal(result.body.order.inventory.state, "DEBITED");
  assert.equal(db.product().inventoryQuantity, 2);
  const shipped = response(
    await handler(
      event(
        {
          action: "fulfillment",
          state: "SHIPPED",
          operationId: "fulfillment_admin_01",
        },
        true,
        payment.orderId,
      ),
    ),
  );
  assert.equal(shipped.status, 200);
  const uninspected = response(
    await handler(
      event(
        {
          action: "return",
          receiptId: "RMA",
          rows: [{ line: 0, quantity: 1 }],
          resalableConfirmed: false,
          operationId: "return_admin_operation_01",
        },
        true,
        payment.orderId,
      ),
    ),
  );
  assert.equal(uninspected.status, 400);
  assert.equal(db.product().inventoryQuantity, 2);
});
test("storage outage is retryable rather than not-found; legacy cannot restock", async (t) => {
  const db = paymentFixture(
    t,
    savedOrder({ status: "PAID", providerPaymentKey: "pk" }),
  );
  assert.equal(
    response(
      await handler(
        event(
          {
            action: "return",
            receiptId: "RMA",
            rows: [{ line: 0, quantity: 1 }],
            resalableConfirmed: true,
            operationId: "return_admin_operation_02",
          },
          true,
          payment.orderId,
        ),
      ),
    ).status,
    409,
  );
  db.failRead();
  assert.equal(
    response(await handler(event(undefined, true, payment.orderId, "GET"))).status,
    503,
  );
  assert.equal(db.calls.length, 0);
});
test("legacy full monetary refund is preserved with durable operation proof but no stock restoration", async (t) => {
  const db = paymentFixture(
    t,
    savedOrder({ status: "PAID", providerPaymentKey: "pk" }),
  );
  db.setProvider((_url, init) => {
    const body = JSON.parse(init.body as string);
    return {
      ...payment,
      status: "CANCELED",
      balanceAmount: 0,
      cancels: [
        {
          transactionKey: "legacy_tx",
          cancelStatus: "DONE",
          cancelReason: body.cancelReason,
          cancelAmount: 200,
        },
      ],
    };
  });
  const result = response(
    await handler(event({ cancelReason: "legacy refund" }, true, payment.orderId)),
  );
  assert.equal(result.status, 200);
  assert.equal(result.body.status, "REFUNDED");
  assert.equal(result.body.order.inventory.state, "LEGACY");
  assert.equal(db.product().inventoryQuantity, 4);
  assert.equal(db.product().inventoryCommitted, undefined);
  assert.equal(
    response(
      await handler(event({ cancelReason: "legacy refund" }, true, payment.orderId)),
    ).status,
    200,
  );
  assert.equal(db.calls.length, 1);
  assert.equal(
    response(
      await handler(
        event(
          {
            action: "return",
            receiptId: "RMA",
            resalableConfirmed: true,
            rows: [{ line: 0, quantity: 1 }],
            operationId: "legacy_return_operation",
          },
          true,
          payment.orderId,
        ),
      ),
    ).status,
    409,
  );
  db.setProvider(() => ({
    ...payment,
    status: "CANCELED",
    balanceAmount: 0,
    cancels: [
      {
        transactionKey: "legacy_tx",
        cancelStatus: "DONE",
        cancelReason: "legacy",
        cancelAmount: 200,
      },
    ],
  }));
  assert.equal(
    response(await handler(event({ action: "reconcile" }, true, payment.orderId)))
      .status,
    200,
  );
  assert.equal(db.product().inventoryQuantity, 4);
});
test("legacy refund timeout reconciles exact PG cancellation without restoring stock or canceling twice", async (t) => {
  const db = paymentFixture(
    t,
    savedOrder({ status: "PAID", providerPaymentKey: "pk" }),
  );
  let marker = "";
  db.setProvider((_url, init) => {
    marker = JSON.parse(init.body as string).cancelReason;
    throw new Error("provider response lost");
  });
  assert.equal(
    response(
      await handler(event({ cancelReason: "legacy uncertain" }, true, payment.orderId)),
    ).status,
    503,
  );
  assert.ok(db.order().inventory?.pendingRefund);
  db.setProvider((_url, init) => {
    assert.equal(init.method, "GET");
    return {
      ...payment,
      status: "CANCELED",
      balanceAmount: 0,
      cancels: [
        {
          transactionKey: "legacy_recovered",
          cancelAmount: 200,
          cancelStatus: "DONE",
          cancelReason: marker,
        },
      ],
    };
  });
  assert.equal(
    response(await handler(event({ action: "reconcile" }, true, payment.orderId)))
      .status,
    200,
  );
  assert.equal(db.order().inventory?.pendingRefund, undefined);
  assert.equal(db.product().inventoryQuantity, 4);
  assert.equal(
    db.transactions.every((transaction) => transaction.TransactItems?.length === 1),
    true,
  );
});
