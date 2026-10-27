import assert from "node:assert/strict";
import test, { type TestContext } from "node:test";
import {
  GetCommand,
  QueryCommand,
  ScanCommand,
  TransactWriteCommand,
} from "@aws-sdk/lib-dynamodb";
import { documentClient } from "../lambda/dynamodb-client.js";
import {
  operateSalesDay,
  readOnline,
  readSalesDay,
} from "../lambda/sales-ledger-store.js";
import type {
  SalesCommand,
  SaleEntry,
  StockPreview,
} from "../lambda/sales-ledger-domain.js";
process.env.SALES_LEDGER_TABLE_NAME = "fixture_sales";
process.env.CATALOG_TABLE_NAME = "fixture_catalog";
process.env.ORDER_TABLE_NAME = "fixture_orders";
const day = "2026-10-15";
const save = (
  id = "sale_001",
  reference = "APP-001",
): Extract<SalesCommand, { action: "save" }> => ({
  action: "save",
  entryId: id,
  expectedVersion: 0,
  soldAt: "2026-10-15T01:00:00.000Z",
  method: "CARD",
  reference,
  amount: 200,
  memo: "",
  lines: [
    { productId: "prd_deck", name: "Deck", option: "8", quantity: 2, unitAmount: 100 },
  ],
});
function fixture(t: TestContext) {
  const ledger = new Map<string, Record<string, unknown>>();
  const products = new Map<string, Record<string, unknown>>([
    [
      "prd_deck",
      {
        productId: "prd_deck",
        name: "Deck",
        price: 100,
        sizes: ["8"],
        status: "PUBLISHED",
        currency: "KRW",
        inventoryQuantity: 10,
        inventoryReserved: 3,
        inventoryCommitted: 0,
        version: 1,
      },
    ],
  ]);
  let orders: Record<string, unknown>[] = [];
  let writes = 0;
  let lostReply = false;
  let race: (() => void) | undefined;
  const clone = <T>(value: T): T => structuredClone(value);
  const key = (d: string, id: string) => `${d}/${id}`;
  t.mock.method(documentClient, "send", async (c: unknown) => {
    if (c instanceof GetCommand)
      return {
        Item: clone(
          c.input.TableName === "fixture_catalog"
            ? products.get(c.input.Key!.productId)
            : ledger.get(key(c.input.Key!.businessDay, c.input.Key!.entryId)),
        ),
      };
    if (c instanceof QueryCommand)
      return {
        Items: clone(
          [...ledger.values()].filter(
            (e) => e.businessDay === c.input.ExpressionAttributeValues![":day"],
          ),
        ),
      };
    if (c instanceof ScanCommand) return { Items: clone(orders) };
    assert.ok(c instanceof TransactWriteCommand);
    if (race) {
      const callback = race;
      race = undefined;
      callback();
    }
    const items = c.input.TransactItems!;
    // Validate the entire batch before mutation, just as DynamoDB does.
    for (const w of items) {
      const op = w.Put ?? w.Update!;
      const item = w.Put?.Item ?? w.Update!.Key!;
      const existing =
        op.TableName === "fixture_catalog"
          ? products.get(item.productId)
          : ledger.get(key(item.businessDay, item.entryId));
      const v = op.ExpressionAttributeValues ?? {};
      let ok = true;
      if (op.ConditionExpression?.includes("attribute_not_exists"))
        ok =
          !existing ||
          ("saleId" in (existing ?? {}) && existing!.saleId === v[":sale"]);
      else if (op.ConditionExpression?.includes("#version"))
        ok =
          existing?.version === v[":version"] &&
          (!op.ConditionExpression.includes("#status") ||
            existing?.status === v[":draft"]);
      if (!ok)
        throw Object.assign(new Error("conditional"), {
          name: "TransactionCanceledException",
        });
    }
    for (const w of items)
      if (w.Put) {
        const item = clone(w.Put.Item!);
        if (w.Put.TableName === "fixture_catalog") products.set(item.productId, item);
        else ledger.set(key(item.businessDay, item.entryId), item);
      } else {
        const u = w.Update!,
          v = u.ExpressionAttributeValues!,
          p = products.get(u.Key!.productId)!;
        products.set(u.Key!.productId, {
          ...p,
          inventoryQuantity: v[":after"],
          inventoryCommitted:
            Number(p.inventoryCommitted ?? 0) + Number(v[":committed"]),
          version: v[":nextVersion"],
        });
      }
    writes++;
    if (lostReply) {
      lostReply = false;
      throw new Error("lost response after commit");
    }
    return {};
  });
  return {
    ledger,
    products,
    setOrders: (o: Record<string, unknown>[]) => {
      orders = o;
    },
    writes: () => writes,
    loseNextReply: () => {
      lostReply = true;
    },
    raceNextWrite: (callback: () => void) => {
      race = callback;
    },
  };
}
test("lost posted response replays durable proof without another debit", async (t) => {
  const f = fixture(t);
  await operateSalesDay(day, save(), "admin");
  const preview = (await operateSalesDay(
    day,
    { action: "preview", entryId: "sale_001", version: 1 },
    "admin",
  )) as { previewToken: string };
  const command = {
    action: "post",
    entryId: "sale_001",
    version: 1,
    previewToken: preview.previewToken,
    confirmed: true,
  } as const;
  f.loseNextReply();
  await assert.rejects(
    () => operateSalesDay(day, command, "admin"),
    /SALES_WRITE_UNCERTAIN/,
  );
  const result = (await operateSalesDay(day, command, "admin")) as { entry: SaleEntry };
  assert.equal(result.entry.status, "POSTED");
  assert.equal(f.products.get("prd_deck")!.inventoryQuantity, 8);
  assert.equal(f.writes(), 2);
});
test("catalog and day CAS races abort all sale writes", async (t) => {
  const f = fixture(t);
  await operateSalesDay(day, save(), "admin");
  const preview = (await operateSalesDay(
    day,
    { action: "preview", entryId: "sale_001", version: 1 },
    "admin",
  )) as { previewToken: string };
  f.raceNextWrite(() => {
    f.products.get("prd_deck")!.version = 2;
  });
  await assert.rejects(
    () =>
      operateSalesDay(
        day,
        {
          action: "post",
          entryId: "sale_001",
          version: 1,
          previewToken: preview.previewToken,
          confirmed: true,
        },
        "admin",
      ),
    /SALES_CONCURRENT_OR_DUPLICATE/,
  );
  assert.equal(f.ledger.get(`${day}/sale_001`)!.status, "DRAFT");
  assert.equal(f.ledger.get(`${day}/~state`)!.version, 1);
  assert.equal(f.products.get("prd_deck")!.inventoryQuantity, 10);
  f.raceNextWrite(() => {
    f.ledger.get(`${day}/~state`)!.version = 2;
  });
  await assert.rejects(
    () => operateSalesDay(day, save("sale_other", "APP-002"), "admin"),
    /SALES_CONCURRENT_OR_DUPLICATE/,
  );
  assert.equal(f.ledger.has(`${day}/sale_other`), false);
});
test("late online observation warns against the retained immutable close snapshot", async (t) => {
  const f = fixture(t);
  const report = await readSalesDay(day);
  await operateSalesDay(
    day,
    {
      action: "close",
      operationId: "close_001",
      expectedVersion: report.version,
      onlineFingerprint: report.onlineFingerprint,
      cashComparedAmount: 0,
      confirmed: true,
    },
    "admin",
  );
  f.setOrders([
    {
      orderId: "pd_late",
      status: "PAID",
      paymentStatus: "DONE",
      total: 50,
      paidAt: "2026-10-15T01:00:00.000Z",
    },
  ]);
  const changed = await readSalesDay(day);
  assert.ok(changed.warnings.includes("ONLINE_CHANGED_AFTER_CLOSE"));
  assert.equal(changed.snapshots[0].totals.onlineGross, 0);
  assert.equal(changed.totals.onlineGross, 50);
});
test("ledger pagination incompleteness fails rather than presenting a closeable partial day", async (t) => {
  let pages = 0;
  t.mock.method(documentClient, "send", async (c: unknown) => {
    if (c instanceof GetCommand) return {};
    if (c instanceof ScanCommand) return { Items: [] };
    assert.ok(c instanceof QueryCommand);
    pages++;
    return {
      Items: [],
      LastEvaluatedKey: { businessDay: day, entryId: `sale_${pages}` },
    };
  });
  await assert.rejects(() => readSalesDay(day), /SALES_PAGINATION_INCOMPLETE/);
  assert.equal(pages, 100);
});
test("a completed scan arriving at the deadline still cannot return success", async (t) => {
  const realNow = Date.now.bind(Date);
  let elapsed = 0;
  t.mock.method(Date, "now", () => realNow() + elapsed);
  t.mock.method(documentClient, "send", async (c: unknown) => {
    assert.ok(c instanceof ScanCommand);
    elapsed = 8_001;
    return { Items: [] };
  });
  await assert.rejects(() => readOnline(day), /ONLINE_PAGINATION_INCOMPLETE/);
});
async function post() {
  const p = (await operateSalesDay(
    day,
    { action: "preview", entryId: "sale_001", version: 1 },
    "admin",
  )) as { preview: StockPreview[]; previewToken: string };
  const command: SalesCommand = {
    action: "post",
    entryId: "sale_001",
    version: 1,
    previewToken: p.previewToken,
    confirmed: true,
  };
  const result = (await operateSalesDay(day, command, "admin")) as { entry: SaleEntry };
  return { result, command, preview: p.preview };
}
test("offline debit atomically preserves online reservations, versions/revision and immutable proof; retry delta zero", async (t) => {
  const f = fixture(t);
  await operateSalesDay(day, save(), "admin");
  const { result, command, preview } = await post();
  assert.equal(preview[0].available, 7);
  assert.equal(result.entry.status, "POSTED");
  const product = f.products.get("prd_deck")!;
  assert.equal(product.inventoryQuantity, 8);
  assert.equal(product.inventoryReserved, 3);
  assert.equal(product.inventoryCommitted, 2);
  assert.equal(product.version, 2);
  assert.equal(f.products.get("~catalog_revision")!.version, 1);
  assert.equal(f.ledger.get(`${day}/~state`)!.version, 2);
  await operateSalesDay(day, command, "other-admin");
  assert.equal(f.writes(), 2);
  await assert.rejects(
    () => operateSalesDay(day, { ...save(), expectedVersion: 2 }, "admin"),
    /SALE_VERSION_OR_STATUS_CONFLICT/,
  );
});
test("same approval reference across new IDs fails without recording a second sale", async (t) => {
  const f = fixture(t);
  await operateSalesDay(day, save(), "admin");
  await operateSalesDay(day, save(), "admin");
  assert.equal(f.writes(), 1);
  await assert.rejects(
    () => operateSalesDay(day, save("sale_other"), "admin"),
    /SALES_CONCURRENT_OR_DUPLICATE/,
  );
  assert.equal(f.ledger.has(`${day}/sale_other`), false);
  assert.equal(f.ledger.get(`${day}/~state`)!.version, 1);
});
test("unmatched, changed preview and reserved stock exhaustion cannot debit", async (t) => {
  const f = fixture(t);
  await operateSalesDay(day, { ...save(), lines: [] }, "admin");
  await assert.rejects(
    () =>
      operateSalesDay(
        day,
        { action: "preview", entryId: "sale_001", version: 1 },
        "admin",
      ),
    /SALE_PRODUCTS_OR_AMOUNT_UNCONFIRMED/,
  );
  await operateSalesDay(day, { ...save(), expectedVersion: 1 }, "admin");
  const preview = (await operateSalesDay(
    day,
    { action: "preview", entryId: "sale_001", version: 2 },
    "admin",
  )) as { previewToken: string };
  f.products.get("prd_deck")!.version = 2;
  await assert.rejects(
    () =>
      operateSalesDay(
        day,
        {
          action: "post",
          entryId: "sale_001",
          version: 2,
          previewToken: preview.previewToken,
          confirmed: true,
        },
        "admin",
      ),
    /SALE_STOCK_CHANGED_PREVIEW_AGAIN/,
  );
  f.products.get("prd_deck")!.inventoryQuantity = 4;
  await assert.rejects(
    () =>
      operateSalesDay(
        day,
        { action: "preview", entryId: "sale_001", version: 2 },
        "admin",
      ),
    /SALE_STOCK_INSUFFICIENT_RECOUNT_REQUIRED/,
  );
  assert.equal(f.products.get("prd_deck")!.inventoryCommitted, 0);
});
test("reversal is linked immutable evidence, inspection controls restoration and original can only reverse once", async (t) => {
  const f = fixture(t);
  await operateSalesDay(day, save(), "admin");
  await post();
  const reverse: SalesCommand = {
    action: "reverse",
    entryId: "sale_refund",
    originalDay: day,
    originalId: "sale_001",
    soldAt: "2026-10-15T02:00:00.000Z",
    reason: "입고 검수 완료",
    restockInspected: true,
    confirmed: true,
  };
  await operateSalesDay(day, reverse, "admin");
  await operateSalesDay(day, reverse, "other-admin");
  assert.equal(f.products.get("prd_deck")!.inventoryQuantity, 10);
  assert.equal(f.products.get("prd_deck")!.inventoryCommitted, 0);
  assert.equal(f.ledger.get(`${day}/sale_001`)!.status, "POSTED");
  assert.equal((await readSalesDay(day)).totals.offlineNet, 0);
  await assert.rejects(
    () => operateSalesDay(day, { ...reverse, entryId: "sale_refund_again" }, "admin"),
    /SALE_STOCK_INSUFFICIENT_RECOUNT_REQUIRED|SALES_CONCURRENT_OR_DUPLICATE/,
  );
});
test("close takes a stable manifest snapshot, repeats no stock write, reopening retains prior snapshot/reason", async (t) => {
  const f = fixture(t);
  await operateSalesDay(day, save(), "admin");
  await post();
  const report = await readSalesDay(day);
  const close: SalesCommand = {
    action: "close",
    operationId: "close_001",
    expectedVersion: report.version,
    onlineFingerprint: report.onlineFingerprint,
    cashComparedAmount: 0,
    confirmed: true,
  };
  await operateSalesDay(day, close, "admin");
  await operateSalesDay(day, close, "admin");
  const closed = await readSalesDay(day);
  assert.equal(closed.status, "CLOSED");
  assert.equal(closed.snapshots.length, 1);
  assert.equal(closed.snapshots[0].entryCount, 1);
  assert.equal(f.products.get("prd_deck")!.inventoryQuantity, 8);
  await assert.rejects(
    () => operateSalesDay(day, save("sale_later", "APP-002"), "admin"),
    /SALES_DAY_CLOSED/,
  );
  await operateSalesDay(
    day,
    {
      action: "reopen",
      operationId: "reopen_001",
      expectedVersion: closed.version,
      reason: "늦게 확인한 판매 추가",
    },
    "admin",
  );
  const opened = await readSalesDay(day);
  assert.equal(opened.status, "OPEN");
  assert.equal(opened.snapshots.length, 1);
  assert.equal(opened.history.at(-1)!.reason, "늦게 확인한 판매 추가");
});
test("unposted sales and cash mismatch block day close", async (t) => {
  fixture(t);
  await operateSalesDay(day, { ...save(), method: "CASH" }, "admin");
  let report = await readSalesDay(day);
  const close = () =>
    ({
      action: "close",
      operationId: "close_001",
      expectedVersion: report.version,
      onlineFingerprint: report.onlineFingerprint,
      cashComparedAmount: 0,
      confirmed: true,
    }) as const;
  await assert.rejects(
    () => operateSalesDay(day, close(), "admin"),
    /SALES_CLOSE_RECONCILIATION_REQUIRED/,
  );
  await post();
  report = await readSalesDay(day);
  await assert.rejects(
    () => operateSalesDay(day, close(), "admin"),
    /CASH_SALES_COMPARISON_MISMATCH/,
  );
});
test("online gross uses approval date even when now refunded; dated refunds use their own day; missing evidence blocks", async (t) => {
  const f = fixture(t);
  f.setOrders([
    {
      orderId: "pd_order_001",
      status: "REFUNDED",
      paymentStatus: "CANCELED",
      total: 500,
      paidAt: "2026-10-15T01:00:00.000Z",
      financialRefundedAmount: 500,
      financialEvents: [
        {
          eventId: "approval1",
          kind: "APPROVAL",
          amount: 500,
          occurredAt: "2026-10-15T01:00:00.000Z",
          recordedAt: "2026-10-15T01:00:00.000Z",
          timeBasis: "PROVIDER",
        },
        {
          eventId: "refund1",
          kind: "REFUND",
          amount: 500,
          occurredAt: "2026-10-16T01:00:00.000Z",
          recordedAt: "2026-10-16T01:00:00.000Z",
          timeBasis: "OBSERVED",
        },
      ],
    },
  ]);
  assert.equal((await readSalesDay(day)).totals.onlineGross, 500);
  assert.equal((await readSalesDay(day)).totals.onlineRefunds, 0);
  assert.equal((await readSalesDay("2026-10-16")).totals.onlineRefunds, 500);
  f.setOrders([
    {
      orderId: "pd_legacy",
      status: "PAID",
      total: 500,
      paidAt: "2026-10-15T01:00:00.000Z",
      financialRefundedAmount: 100,
    },
  ]);
  assert.ok(
    (await readSalesDay(day)).warnings.includes("ONLINE_REFUND_HISTORY_UNAVAILABLE"),
  );
});
test("a nonempty pagination cursor never returns partial online totals", async (t) => {
  let scans = 0;
  t.mock.method(documentClient, "send", async (c: unknown) => {
    assert.ok(c instanceof ScanCommand);
    scans++;
    return { Items: [], LastEvaluatedKey: { orderId: `order_${scans}` } };
  });
  await assert.rejects(() => readOnline(day), /ONLINE_PAGINATION_INCOMPLETE/);
  assert.equal(scans, 100);
});
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
  // The cash draft is voided so the day can close with transfers only.
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
test("a legacy close snapshot without transfer is returned unchanged and is not rewritten by reopen", async (t) => {
  const f = fixture(t);
  const legacyTotals = {
    card: 0,
    cash: 0,
    offlineRefunds: 0,
    offlineNet: 0,
    onlineGross: 0,
    onlineRefunds: 0,
    onlineNet: 0,
    combinedNet: 0,
  };
  const legacy = {
    snapshotId: "close_legacy",
    closedAt: "2026-10-15T10:00:00.000Z",
    version: 1,
    totals: legacyTotals,
    onlineFingerprint: "a".repeat(64),
    cashComparedAmount: 0,
    entryManifest: "b".repeat(64),
    entryCount: 0,
    onlineEvents: [],
  };
  f.ledger.set(`${day}/~state`, {
    businessDay: day,
    entryId: "~state",
    recordType: "SALES_DAY",
    version: 1,
    status: "CLOSED",
    snapshots: [legacy],
    history: [],
  });
  const closed = await readSalesDay(day);
  assert.deepEqual(closed.snapshots, [legacy]);
  await operateSalesDay(
    day,
    {
      action: "reopen",
      operationId: "reopen_legacy",
      expectedVersion: 1,
      reason: "이체 전표 추가",
    },
    "admin",
  );
  const stored = f.ledger.get(`${day}/~state`)! as { snapshots: unknown[] };
  assert.deepEqual(stored.snapshots, [legacy]);
  assert.equal("transfer" in (stored.snapshots[0] as { totals: object }).totals, false);
});
test("a stored sale with an unknown payment method fails closed instead of counting as cash", async (t) => {
  const f = fixture(t);
  await operateSalesDay(day, { ...save(), method: "CASH" }, "admin");
  f.ledger.get(`${day}/sale_001`)!.method = "BANK";
  await assert.rejects(() => readSalesDay(day), /SALE_RECORD_INVALID/);
  await assert.rejects(
    () =>
      operateSalesDay(
        day,
        { action: "preview", entryId: "sale_001", version: 1 },
        "admin",
      ),
    /SALE_RECORD_INVALID/,
  );
});
