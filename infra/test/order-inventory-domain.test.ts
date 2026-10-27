import assert from "node:assert/strict";
import test from "node:test";
import {
  aggregateStock,
  checkOperation,
  operationKey,
  quantitiesFromRows,
  restoreVector,
  validOrderLines,
  validLedger,
  type InventoryLedger,
} from "../lambda/order-inventory-domain.js";
const lines = [
  {
    productId: "prd_a",
    name: "Deck",
    selectedSize: "8",
    quantity: 2,
    unitPrice: 100,
    lineTotal: 200,
  },
  {
    productId: "prd_a",
    name: "Deck",
    selectedSize: "9",
    quantity: 3,
    unitPrice: 100,
    lineTotal: 300,
  },
];
const ledger: InventoryLedger = {
  schema: 1,
  version: 1,
  state: "DEBITED",
  paymentKey: "pk",
  expiresAt: "2026-10-15T00:00:00Z",
  fulfillment: "SHIPPED",
  restored: [1, 0],
  canceled: [0, 0],
  refundedAmount: 0,
  operations: {},
};
test("strict persisted snapshot validates quantities, money and unique variants", () => {
  assert.equal(validOrderLines(lines, 500, 500), true);
  for (const bad of [NaN, Infinity, -1, 0, 1.5, 11])
    assert.equal(validOrderLines([{ ...lines[0], quantity: bad }], 200, 200), false);
  assert.equal(validOrderLines(lines, 400, 400), false);
  assert.equal(validOrderLines([lines[0], lines[0]], 400, 400), false);
  assert.equal(
    validOrderLines([{ ...lines[0], productId: "~internal" }], 200, 200),
    false,
  );
});
test("stock aggregates product-wide across sizes without losing quantities", () => {
  assert.deepEqual([...aggregateStock(lines)], [["prd_a", 5]]);
  assert.deepEqual(quantitiesFromRows(lines, [{ line: 1, quantity: 2 }]), [0, 2]);
  assert.throws(() =>
    quantitiesFromRows(lines, [
      { line: 0, quantity: 1 },
      { line: 0, quantity: 1 },
    ]),
  );
});
test("cumulative restoration is bounded by proven debit, not refund amount", () => {
  assert.deepEqual(restoreVector(ledger, lines, [1, 2]), [2, 2]);
  assert.throws(() => restoreVector(ledger, lines, [2, 0]));
  assert.throws(() => restoreVector({ ...ledger, state: "RESERVED" }, lines, [1, 0]));
});
test("durable operation fingerprint rejects retargeted id", () => {
  const id = "return_operation_001";
  const completed = {
    ...ledger,
    operations: { [operationKey(id)]: { fingerprint: "fp", kind: "return" } },
  };
  assert.equal(checkOperation(completed, id, "fp"), true);
  assert.throws(() => checkOperation(completed, id, "changed"));
});
test("corrupt pending cancellation and legacy restoration claims fail persisted validation", () => {
  assert.equal(validLedger(ledger, lines), true);
  assert.equal(validLedger({ ...ledger, pendingRefund: {} }, lines), false);
  assert.equal(validLedger({ ...ledger, state: "LEGACY" }, lines), false);
  assert.equal(validLedger({ ...ledger, refundedAmount: 501 }, lines), false);
  assert.equal(
    validLedger({ ...ledger, approvalAttemptedAt: "invalid" }, lines),
    false,
  );
});
