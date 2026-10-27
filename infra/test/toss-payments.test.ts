import assert from "node:assert/strict";
import test from "node:test";
import {
  cancelTossPayment,
  parseTossPayment,
  paymentMatchesOrder,
  verifiedCancellation,
} from "../lambda/toss-payments.js";
const payment = {
  paymentKey: "pk",
  orderId: "pd_order",
  totalAmount: 100,
  balanceAmount: 100,
  status: "DONE",
  method: "카드",
  currency: "KRW",
  approvedAt: null,
  cancels: null,
};
test("nullable provider fields normalize without weakening canceled proof", () => {
  const parsed = parseTossPayment(payment)!;
  assert.ok(parsed);
  assert.equal(parsed.approvedAt, undefined);
  assert.deepEqual(parsed.cancels, []);
  assert.equal(verifiedCancellation(parsed), false);
  for (const bad of [-1, 0.5, 101, NaN])
    assert.equal(parseTossPayment({ ...payment, balanceAmount: bad }), null);
});
test("cancellation provider time is optional but malformed time cannot enter evidence", () => {
  const cancel = {
    transactionKey: "tx",
    cancelAmount: 20,
    cancelStatus: "DONE",
    cancelReason: "reason",
    canceledAt: "2026-10-15T01:00:00+09:00",
  };
  assert.equal(
    parseTossPayment({
      ...payment,
      status: "PARTIAL_CANCELED",
      balanceAmount: 80,
      cancels: [cancel],
    })?.cancels[0].canceledAt,
    cancel.canceledAt,
  );
  assert.equal(
    parseTossPayment({ ...payment, cancels: [{ ...cancel, canceledAt: "invalid" }] }),
    null,
  );
});
test("cancel proof checks immutable identity, final status, unique completed transactions and balance", () => {
  const parsed = parseTossPayment({
    ...payment,
    status: "CANCELED",
    balanceAmount: 0,
    cancels: [
      {
        transactionKey: "tx",
        cancelAmount: 100,
        cancelStatus: "DONE",
        cancelReason: "reason",
      },
    ],
  })!;
  assert.equal(verifiedCancellation(parsed), true);
  assert.equal(
    paymentMatchesOrder(parsed, { orderId: "pd_order", total: 100 }, "other"),
    false,
  );
  assert.equal(
    verifiedCancellation({
      ...parsed,
      cancels: [...parsed.cancels, ...parsed.cancels],
    }),
    false,
  );
  assert.equal(verifiedCancellation({ ...parsed, status: "DONE" }), false);
  assert.equal(
    paymentMatchesOrder(
      { ...parsed, currency: "USD" },
      { orderId: "pd_order", total: 100 },
      "pk",
    ),
    false,
  );
  assert.equal(
    verifiedCancellation({
      ...parsed,
      cancels: [{ ...parsed.cancels[0]!, cancelStatus: "PENDING" }],
    }),
    false,
  );
});
test("partial cancel forwards durable per-operation key and explicit amount; no network", async (t) => {
  t.mock.method(globalThis, "fetch", async (_url: unknown, init: RequestInit) => {
    assert.equal(
      (init.headers as Record<string, string>)["Idempotency-Key"],
      "cancel-opaque",
    );
    assert.deepEqual(JSON.parse(init.body as string), {
      cancelReason: "reason",
      cancelAmount: 40,
    });
    assert.equal(init.redirect, "error");
    assert.ok(init.signal);
    return new Response(
      JSON.stringify({
        ...payment,
        status: "PARTIAL_CANCELED",
        balanceAmount: 60,
        cancels: [
          {
            transactionKey: "tx",
            cancelAmount: 40,
            cancelStatus: "DONE",
            cancelReason: "reason",
          },
        ],
      }),
      { status: 200 },
    );
  });
  const result = await cancelTossPayment({
    credentials: { secretKey: "fake" },
    paymentKey: "pk",
    orderId: "pd_order",
    cancelReason: "reason",
    cancelAmount: 40,
    operationId: "opaque",
  });
  assert.equal(verifiedCancellation(result), true);
});
