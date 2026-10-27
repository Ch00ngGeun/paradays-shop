import assert from "node:assert/strict";
import test from "node:test";
import {
  parseSalesCommand,
  validDay,
  kstDay,
  calculateTotals,
  sortEntries,
  saleWarnings,
  type SaleEntry,
} from "../lambda/sales-ledger-domain.js";
const draft = {
  action: "save",
  entryId: "sale_001",
  expectedVersion: 0,
  soldAt: "2026-10-15T23:59:00+09:00",
  method: "CARD",
  reference: "APP-123",
  amount: 100,
  memo: "",
  lines: [],
};
test("KST boundary, actual sale time and strict minimal inputs", () => {
  assert.equal(kstDay("2026-10-15T15:00:00Z"), "2026-10-16");
  assert.equal(validDay("2026-02-30"), false);
  assert.ok(parseSalesCommand(draft, "2026-10-15", Date.parse("2026-10-16T00:00:00Z")));
  assert.equal(
    parseSalesCommand({ ...draft, cardNumber: "forbidden" }, "2026-10-15"),
    null,
  );
  assert.equal(parseSalesCommand(draft, "2026-10-16"), null);
  assert.equal(parseSalesCommand(draft, "2026-10-15", 0), null);
  assert.equal(
    parseSalesCommand({ ...draft, soldAt: "2026-02-30T10:00+09:00" }, "2026-03-02"),
    null,
  );
  assert.equal(
    parseSalesCommand({ ...draft, soldAt: "2026-10-15T24:00Z" }, "2026-10-16"),
    null,
  );
  assert.equal(
    parseSalesCommand({ ...draft, soldAt: "2026-02-29T10:00+09:00" }, "2026-03-01"),
    null,
  );
  assert.ok(
    parseSalesCommand({ ...draft, soldAt: "2024-02-29T10:00+09:00" }, "2024-02-29"),
  );
});
test("unmatched stays pending, refund signs and time tie ordering", () => {
  const e = {
    ...draft,
    recordType: "SALE",
    businessDay: "2026-10-15",
    version: 1,
    status: "POSTED",
    kind: "SALE",
    createdAt: draft.soldAt,
    updatedAt: draft.soldAt,
  } as SaleEntry;
  assert.deepEqual(saleWarnings(e), ["UNMATCHED_PRODUCTS", "LINE_AMOUNT_MISMATCH"]);
  const reverse = { ...e, entryId: "sale_002", kind: "REVERSAL" as const };
  assert.equal(
    calculateTotals(
      [e, reverse],
      [
        {
          orderId: "order001",
          kind: "APPROVAL",
          amount: 500,
          occurredAt: e.soldAt,
          timeBasis: "PROVIDER",
        },
        {
          orderId: "order001",
          kind: "REFUND",
          amount: 100,
          occurredAt: e.soldAt,
          timeBasis: "OBSERVED",
        },
      ],
    ).combinedNet,
    400,
  );
  assert.deepEqual(
    sortEntries([reverse, e]).map((x) => x.entryId),
    ["sale_001", "sale_002"],
  );
});
test("transfers are accepted and totalled apart from cash, including reversals", () => {
  const now = Date.parse("2026-10-16T00:00:00Z");
  assert.ok(parseSalesCommand({ ...draft, method: "TRANSFER" }, "2026-10-15", now));
  assert.equal(
    parseSalesCommand({ ...draft, method: "BANK" }, "2026-10-15", now),
    null,
  );
  const posted = (entryId: string, method: SaleEntry["method"], amount: number) =>
    ({
      ...draft,
      entryId,
      method,
      amount,
      recordType: "SALE",
      businessDay: "2026-10-15",
      version: 2,
      status: "POSTED",
      kind: "SALE",
      createdAt: draft.soldAt,
      updatedAt: draft.soldAt,
    }) as SaleEntry;
  const totals = calculateTotals(
    [
      posted("sale_card", "CARD", 1_000),
      posted("sale_cash", "CASH", 300),
      posted("sale_transfer", "TRANSFER", 5_000),
      { ...posted("sale_transfer_back", "TRANSFER", 2_000), kind: "REVERSAL" },
      { ...posted("sale_transfer_draft", "TRANSFER", 9_000), status: "DRAFT" },
      { ...posted("sale_transfer_void", "TRANSFER", 9_000), status: "VOID" },
    ],
    [],
  );
  assert.deepEqual(totals, {
    card: 1_000,
    cash: 300,
    transfer: 3_000,
    offlineRefunds: 2_000,
    offlineNet: 4_300,
    onlineGross: 0,
    onlineRefunds: 0,
    onlineNet: 0,
    combinedNet: 4_300,
  });
  assert.throws(
    () =>
      calculateTotals([posted("sale_unknown", "BANK" as SaleEntry["method"], 100)], []),
    /SALE_METHOD_INVALID/,
  );
  assert.throws(
    () =>
      calculateTotals(
        [
          posted("sale_transfer_a", "TRANSFER", Number.MAX_SAFE_INTEGER),
          posted("sale_transfer_b", "TRANSFER", 1),
        ],
        [],
      ),
    /SALES_AMOUNT_OVERFLOW/,
  );
});
