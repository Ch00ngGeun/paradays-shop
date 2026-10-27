import assert from "node:assert/strict";
import test from "node:test";
import {
  confirmFulfillment,
  receiveReturn,
  refundIntent,
  startRefund,
  syncRefundPayment,
} from "../lambda/order-refunds.js";
import {
  reserveInventory,
  settleInventoryPayment,
} from "../lambda/order-inventory-store.js";
import { paymentFixture, savedOrder } from "./payment-flow-fixture.js";
import { operationKey } from "../lambda/order-inventory-domain.js";
const paid = {
  paymentKey: "pk",
  orderId: "pd_order_001",
  totalAmount: 200,
  balanceAmount: 200,
  status: "DONE",
  method: "카드",
  currency: "KRW",
  cancels: [],
};
async function sale(t: Parameters<typeof paymentFixture>[0]) {
  const db = paymentFixture(t, savedOrder());
  let order = await reserveInventory(savedOrder(), "pk");
  order = await settleInventoryPayment(order, paid);
  return { db, order };
}
test("unshipped partial cancellation restores only verified row quantity, and replays once", async (t) => {
  const { db, order: initial } = await sale(t);
  let order = await confirmFulfillment(
    initial,
    "UNSHIPPED",
    "fulfillment_operation_01",
  );
  const intent = refundIntent(order, {
    operationId: "refund_operation_01",
    disposition: "UNSHIPPED",
    cancelReason: "cancel",
    cancelAmount: 100,
    rows: [{ line: 0, quantity: 1 }],
  });
  db.setProvider(() => ({
    ...paid,
    status: "PARTIAL_CANCELED",
    balanceAmount: 100,
    cancels: [
      {
        transactionKey: "tx1",
        cancelAmount: 100,
        cancelReason: intent.providerReason,
        cancelStatus: "DONE",
      },
    ],
  }));
  order = await startRefund(order, intent, { secretKey: "fake" });
  assert.equal(db.product().inventoryQuantity, 3);
  assert.deepEqual(order.inventory?.restored, [1]);
  assert.equal(
    order.inventory?.operations[operationKey(intent.operationId)]?.transactionKey,
    "tx1",
  );
  assert.equal(await startRefund(order, intent, { secretKey: "fake" }), order);
  assert.equal(db.calls.length, 1);
});
test("a refund above the remaining paid balance is rejected before any PG call", async (t) => {
  const { db, order: initial } = await sale(t);
  let order = await confirmFulfillment(
    initial,
    "UNSHIPPED",
    "fulfillment_operation_cap",
  );
  const first = refundIntent(order, {
    operationId: "refund_operation_first",
    disposition: "UNSHIPPED",
    cancelReason: "cancel",
    cancelAmount: 100,
    rows: [{ line: 0, quantity: 1 }],
  });
  db.setProvider(() => ({
    ...paid,
    status: "PARTIAL_CANCELED",
    balanceAmount: 100,
    cancels: [
      {
        transactionKey: "tx_first",
        cancelAmount: 100,
        cancelReason: first.providerReason,
        cancelStatus: "DONE",
      },
    ],
  }));
  order = await startRefund(order, first, { secretKey: "fake" });
  // Within the order total, but above the 100 still paid after the first refund.
  const second = refundIntent(order, {
    operationId: "refund_operation_over_balance",
    disposition: "COMPENSATION",
    cancelReason: "compensation",
    cancelAmount: 101,
  });
  await assert.rejects(startRefund(order, second, { secretKey: "fake" }), {
    code: "REFUND_AMOUNT_EXCEEDS_BALANCE",
  });
  assert.equal(db.calls.length, 1);
});
test("definite refund rejection clears its lock with durable failure proof; retry does not send another cancel", async (t) => {
  const { db, order } = await sale(t);
  const intent = refundIntent(order, {
    operationId: "refund_reject_operation",
    disposition: "COMPENSATION",
    cancelReason: "compensation",
    cancelAmount: 100,
    rows: [],
  });
  let calls = 0;
  t.mock.method(globalThis, "fetch", async () => {
    calls++;
    return new Response(JSON.stringify({ code: "NOT_CANCELABLE_AMOUNT" }), {
      status: 403,
    });
  });
  const rejected = await startRefund(order, intent, { secretKey: "fake" });
  assert.equal(rejected.inventory?.pendingRefund, undefined);
  assert.equal(rejected.inventory?.lastFailure?.code, "NOT_CANCELABLE_AMOUNT");
  assert.equal(db.product().inventoryQuantity, 2);
  assert.equal(await startRefund(rejected, intent, { secretKey: "fake" }), rejected);
  assert.equal(calls, 1);
});
test("full compensation remains zero-restock through webhook/reconcile and later fulfillment confirmation", async (t) => {
  const { db, order: initial } = await sale(t);
  let order = await confirmFulfillment(
    initial,
    "UNSHIPPED",
    "fulfillment_compensation",
  );
  const intent = refundIntent(order, {
    operationId: "compensation_operation",
    disposition: "COMPENSATION",
    cancelReason: "compensation",
    cancelAmount: 200,
    rows: [],
  });
  const payment = {
    ...paid,
    status: "CANCELED",
    balanceAmount: 0,
    cancels: [
      {
        transactionKey: "tx-comp",
        cancelAmount: 200,
        cancelReason: intent.providerReason,
        cancelStatus: "DONE",
      },
    ],
  };
  db.setProvider(() => payment);
  order = await startRefund(order, intent, { secretKey: "fake" });
  order = await syncRefundPayment(order, payment);
  order = await confirmFulfillment(order, "UNSHIPPED", "fulfillment_comp_repeat");
  assert.equal(db.product().inventoryQuantity, 2);
  assert.deepEqual(order.inventory?.restored, [0]);
});
test("shipped monetary refund restores zero; inspection receipt deduplicates across operation IDs", async (t) => {
  const { db, order: initial } = await sale(t);
  let order = await confirmFulfillment(initial, "SHIPPED", "fulfillment_operation_02");
  const intent = refundIntent(order, {
    operationId: "refund_operation_02",
    disposition: "SHIPPED",
    cancelReason: "refund",
    cancelAmount: 200,
    rows: [{ line: 0, quantity: 2 }],
  });
  db.setProvider(() => ({
    ...paid,
    status: "CANCELED",
    balanceAmount: 0,
    cancels: [
      {
        transactionKey: "tx2",
        cancelAmount: 200,
        cancelReason: intent.providerReason,
        cancelStatus: "DONE",
      },
    ],
  }));
  order = await startRefund(order, intent, { secretKey: "fake" });
  assert.equal(db.product().inventoryQuantity, 2);
  order = await receiveReturn(
    order,
    [{ line: 0, quantity: 1 }],
    "RMA-batch-1",
    true,
    "return_operation_01",
  );
  assert.equal(db.product().inventoryQuantity, 3);
  order = await receiveReturn(
    order,
    [{ line: 0, quantity: 1 }],
    "RMA-batch-1",
    true,
    "return_operation_02",
  );
  assert.equal(db.product().inventoryQuantity, 3);
  await assert.rejects(() =>
    receiveReturn(
      order,
      [{ line: 0, quantity: 2 }],
      "RMA-batch-2",
      true,
      "return_operation_03",
    ),
  );
});
test("PG success with lost response remains locked and reconciles by exact transaction marker", async (t) => {
  const { db, order: initial } = await sale(t);
  const order = await confirmFulfillment(
    initial,
    "UNSHIPPED",
    "fulfillment_operation_03",
  );
  const intent = refundIntent(order, {
    operationId: "refund_operation_03",
    disposition: "UNSHIPPED",
    cancelReason: "cancel",
    cancelAmount: 200,
    rows: [{ line: 0, quantity: 2 }],
  });
  db.setProvider(() => {
    throw new Error("Response lost after provider commit");
  });
  await assert.rejects(
    () => startRefund(order, intent, { secretKey: "fake" }),
    /UNCERTAIN/,
  );
  const pending = db.order();
  await assert.rejects(
    () => confirmFulfillment(pending, "SHIPPED", "fulfillment_operation_04"),
    /IN_PROGRESS/,
  );
  const wrong = {
    ...paid,
    status: "CANCELED",
    balanceAmount: 0,
    cancels: [
      {
        transactionKey: "tx",
        cancelAmount: 200,
        cancelReason: "unrelated",
        cancelStatus: "DONE",
      },
    ],
  };
  const still = await syncRefundPayment(pending, wrong);
  assert.ok(still.inventory?.pendingRefund);
  assert.equal(db.product().inventoryQuantity, 2);
  const restored = await syncRefundPayment(still, {
    ...wrong,
    cancels: [{ ...wrong.cancels[0]!, cancelReason: intent.providerReason }],
  });
  assert.equal(db.product().inventoryQuantity, 4);
  assert.equal(restored.inventory?.pendingRefund, undefined);
});
test("legacy, unknown fulfillment and uninspected goods cannot restore", async (t) => {
  const { order } = await sale(t);
  await assert.rejects(() =>
    receiveReturn(
      order,
      [{ line: 0, quantity: 1 }],
      "RMA",
      true,
      "return_operation_04",
    ),
  );
  await assert.rejects(
    () =>
      receiveReturn(
        savedOrder({ status: "PAID" }),
        [{ line: 0, quantity: 1 }],
        "RMA",
        true,
        "return_operation_05",
      ),
    /DEBIT_PROOF/,
  );
  const shipped = {
    ...order,
    inventory: { ...order.inventory!, fulfillment: "SHIPPED" as const },
  };
  await assert.rejects(
    () =>
      receiveReturn(
        shipped,
        [{ line: 0, quantity: 1 }],
        "RMA",
        false,
        "return_operation_06",
      ),
    /INSPECTION/,
  );
});
test("cached pending-cancel response cannot reduce a newer observed refund total", async (t) => {
  const { db, order } = await sale(t);
  const intent = refundIntent(order, {
    operationId: "refund_stale_operation",
    disposition: "COMPENSATION",
    cancelReason: "compensation",
    cancelAmount: 100,
    rows: [],
  });
  db.setProvider(() => {
    throw new Error("lost response");
  });
  await assert.rejects(() => startRefund(order, intent, { secretKey: "fake" }));
  const pending = db.order();
  const newer = {
    ...pending,
    financialRefundedAmount: 200,
    inventory: { ...pending.inventory!, refundedAmount: 200 },
  };
  await assert.rejects(
    () =>
      syncRefundPayment(newer, {
        ...paid,
        status: "PARTIAL_CANCELED",
        balanceAmount: 100,
        cancels: [
          {
            transactionKey: "cached",
            cancelAmount: 100,
            cancelReason: intent.providerReason,
            cancelStatus: "DONE",
          },
        ],
      }),
    /STALE/,
  );
});
