/** 역할: 계좌이체 매출이 기록·취소·마감에서 현금과 분리되고 현금 비교에 포함되지 않는지 검증함. */
import assert from "node:assert/strict";
import test from "node:test";
import { operateSalesDay, readSalesDay } from "../lambda/sales-ledger-store.js";
import { day, save, fixture, post } from "./sales-ledger-store-fixture.js";
process.env.SALES_LEDGER_TABLE_NAME = "fixture_sales";
process.env.CATALOG_TABLE_NAME = "fixture_catalog";
process.env.ORDER_TABLE_NAME = "fixture_orders";
test("transfer sales post, reverse and close apart from cash; the cash comparison never includes transfers", async (t) => {
  const f = fixture(t);
  await operateSalesDay(day, { ...save(), method: "TRANSFER" }, "admin");
  await post();
  await operateSalesDay(
    day,
    { ...save("sale_cash", "APP-CASH"), method: "CASH", amount: 100, lines: [] },
    "admin",
  );
  assert.equal(f.ledger.get(`${day}/sale_001`)!.method, "TRANSFER");
  assert.equal(f.products.get("prd_deck")!.inventoryQuantity, 8);
  await operateSalesDay(
    day,
    {
      action: "reverse",
      entryId: "sale_transfer_back",
      originalDay: day,
      originalId: "sale_001",
      soldAt: "2026-10-15T02:00:00.000Z",
      reason: "이체 환불",
      restockInspected: false,
      confirmed: true,
    },
    "admin",
  );
  const reversal = f.ledger.get(`${day}/sale_transfer_back`)!;
  assert.equal(reversal.method, "TRANSFER");
  assert.equal(reversal.kind, "REVERSAL");
  assert.equal(f.products.get("prd_deck")!.inventoryQuantity, 8);
  // 현금 초안을 무효 처리해 계좌이체만으로 마감할 수 있게 함.
  await operateSalesDay(
    day,
    { action: "void", entryId: "sale_cash", version: 1, reason: "중복 입력" },
    "admin",
  );
  const report = await readSalesDay(day);
  assert.equal(report.totals.transfer, 0);
  assert.equal(report.totals.cash, 0);
  assert.equal(report.totals.offlineRefunds, 200);
  assert.equal(report.totals.offlineNet, 0);
  const close = (cashComparedAmount: number) =>
    ({
      action: "close",
      operationId: `close_${cashComparedAmount}`,
      expectedVersion: report.version,
      onlineFingerprint: report.onlineFingerprint,
      cashComparedAmount,
      confirmed: true,
    }) as const;
  await assert.rejects(
    () => operateSalesDay(day, close(200), "admin"),
    /CASH_SALES_COMPARISON_MISMATCH/,
  );
  await operateSalesDay(day, close(0), "admin");
  const closed = await readSalesDay(day);
  assert.equal(closed.snapshots[0].totals.transfer, 0);
  assert.equal(closed.snapshots[0].cashComparedAmount, 0);
});
test("open transfer totals stay out of cash and the cash comparison", async (t) => {
  fixture(t);
  await operateSalesDay(day, { ...save(), method: "TRANSFER" }, "admin");
  await post();
  const report = await readSalesDay(day);
  assert.deepEqual(
    [report.totals.card, report.totals.cash, report.totals.transfer],
    [0, 0, 200],
  );
  assert.equal(report.totals.offlineNet, 200);
  await assert.rejects(
    () =>
      operateSalesDay(
        day,
        {
          action: "close",
          operationId: "close_transfer",
          expectedVersion: report.version,
          onlineFingerprint: report.onlineFingerprint,
          cashComparedAmount: 200,
          confirmed: true,
        },
        "admin",
      ),
    /CASH_SALES_COMPARISON_MISMATCH/,
  );
});
