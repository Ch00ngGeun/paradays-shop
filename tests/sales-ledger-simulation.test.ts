import { describe, expect, it } from "vitest";
import {
  closeTestSales,
  createTestSales,
  postTestSale,
  previewTestStock,
  reopenTestSales,
  saveTestSale,
  testSalesTotals,
  TestSalesError,
  type TestSaleInput,
  type TestSalesState,
} from "@/lib/admin-ui/sales-ledger-simulation";

const card: TestSaleInput = {
  time: "09:00",
  method: "CARD",
  reference: "TEST_CARD_001",
  amount: 20_000,
  lines: [
    {
      productId: "TEST_PRODUCT_DECK",
      option: "TEST_8_INCH",
      quantity: 2,
      unitAmount: 10_000,
    },
  ],
};
const cash: TestSaleInput = {
  time: "10:00",
  method: "CASH",
  reference: "TEST_CASH_001",
  amount: 5_000,
  lines: [
    {
      productId: "TEST_PRODUCT_GRIP",
      option: "TEST_BLACK",
      quantity: 1,
      unitAmount: 5_000,
    },
  ],
};
const transfer: TestSaleInput = {
  time: "11:00",
  method: "TRANSFER",
  reference: "TEST_TRANSFER_001",
  amount: 5_000,
  lines: [
    {
      productId: "TEST_PRODUCT_GRIP",
      option: "TEST_BLACK",
      quantity: 1,
      unitAmount: 5_000,
    },
  ],
};
const post = (s: TestSalesState, input: TestSaleInput) => {
  const draft = saveTestSale(s, input);
  const id = draft.entries.find((e) => e.reference === input.reference)!.id;
  return postTestSale(draft, previewTestStock(draft, id), true);
};
describe("synthetic sales, inventory and close teaching flow", () => {
  it("draft and preview do not change stock/totals; posting each entry changes stock exactly once", () => {
    const initial = createTestSales("flow");
    const draft = saveTestSale(initial, card);
    const preview = previewTestStock(draft, "TEST_SALE_001");
    expect(initial.entries).toEqual([]);
    expect(draft.stock).toEqual(initial.stock);
    expect(testSalesTotals(draft).combined).toBe(0);
    expect(preview.rows[0]).toMatchObject({ before: 10, quantity: 2, after: 8 });
    expect(() => postTestSale(draft, preview, false)).toThrow("명시적 확인");
    const posted = postTestSale(draft, preview, true);
    expect(postTestSale(posted, preview, true)).toBe(posted);
    const both = post(posted, cash);
    expect(both.stock).toEqual({ TEST_PRODUCT_DECK: 8, TEST_PRODUCT_GRIP: 4 });
    expect(testSalesTotals(both)).toEqual({
      card: 20_000,
      cash: 5_000,
      transfer: 0,
      offline: 25_000,
      online: 0,
      combined: 25_000,
    });
  });
  it("close takes a snapshot with no additional deduction; reopen preserves old snapshots", () => {
    const both = post(post(createTestSales("close"), card), cash);
    expect(() => closeTestSales(both, 0, true)).toThrow("현금 수기 대조액");
    expect(() => closeTestSales(both, 5_000, false)).toThrow("확인란");
    const closed = closeTestSales(both, 5_000, true);
    expect(closed.stock).toBe(both.stock);
    expect(closed.snapshots[0]).toMatchObject({
      totals: { combined: 25_000 },
      cashCompared: 5_000,
      entryIds: ["TEST_SALE_001", "TEST_SALE_002"],
      stock: both.stock,
    });
    expect(closeTestSales(closed, 5_000, true)).toBe(closed);
    expect(() => saveTestSale(closed, { ...cash, reference: "TEST_CASH_002" })).toThrow(
      "재개방",
    );
    expect(() => reopenTestSales(closed, "")).toThrow("가상 사유");
    const opened = reopenTestSales(closed, "TEST_RECHECK");
    const reclosed = closeTestSales(opened, 5_000, true);
    expect(reclosed.snapshots).toHaveLength(2);
    expect(reclosed.snapshots[0]).toBe(closed.snapshots[0]);
    expect(reclosed.stock).toBe(both.stock);
  });
  it("unmatched and mismatched drafts persist for editing but block inventory and close", () => {
    const unmatched = saveTestSale(createTestSales("draft"), { ...card, lines: [] });
    expect(() => previewTestStock(unmatched, "TEST_SALE_001")).toThrow("상품");
    expect(() => closeTestSales(unmatched, 0, true)).toThrow("작성 중");
    const mismatch = saveTestSale(
      unmatched,
      { ...card, amount: 19_000 },
      { id: "TEST_SALE_001", version: 1 },
    );
    expect(() => previewTestStock(mismatch, "TEST_SALE_001")).toThrow("줄 합계");
    expect(mismatch.stock.TEST_PRODUCT_DECK).toBe(10);
  });
  it("changed drafts, other stock changes and reset sessions invalidate old previews", () => {
    const first = saveTestSale(createTestSales("old"), card);
    const preview = previewTestStock(first, "TEST_SALE_001");
    const edited = saveTestSale(
      first,
      { ...card, time: "08:00" },
      { id: "TEST_SALE_001", version: 1 },
    );
    expect(() => postTestSale(edited, preview, true)).toThrow("바뀌었습니다");
    const withCash = post(first, cash);
    expect(() => postTestSale(withCash, preview, true)).toThrow("바뀌었습니다");
    const reset = saveTestSale(createTestSales("new"), card);
    expect(() => postTestSale(reset, preview, true)).toThrow("명시적 확인");
    expect(() =>
      saveTestSale(edited, card, { id: "TEST_SALE_001", version: 1 }),
    ).toThrow("바뀌었습니다");
  });
  it("aggregates repeated product options before checking stock", () => {
    const input = {
      ...card,
      amount: 110_000,
      lines: [
        { ...card.lines[0], quantity: 6 },
        { ...card.lines[0], option: "TEST_825_INCH", quantity: 5 },
      ],
    };
    const draft = saveTestSale(createTestSales("stock"), input);
    expect(() => previewTestStock(draft, "TEST_SALE_001")).toThrow("재고가 부족");
    expect(draft.stock.TEST_PRODUCT_DECK).toBe(10);
  });
  it("rejects real/unknown products, options, reference input and invalid numbers", () => {
    for (const input of [
      { ...card, reference: "REAL_CARD_001" },
      { ...card, time: "24:00" },
      { ...card, amount: NaN },
      { ...card, amount: 100_000_001 },
      { ...card, lines: [{ ...card.lines[0], productId: "real-product" }] },
      { ...card, lines: [{ ...card.lines[0], option: "real-option" }] },
      { ...card, lines: [{ ...card.lines[0], quantity: -1 }] },
      { ...card, lines: [{ ...card.lines[0], quantity: 0.5 }] },
      { ...card, lines: [{ ...card.lines[0], unitAmount: Infinity }] },
    ])
      expect(() =>
        saveTestSale(createTestSales("invalid"), input as TestSaleInput),
      ).toThrow();
  });
  it("normalizes synthetic references, prevents duplicate references and sorts by sale time", () => {
    const first = saveTestSale(createTestSales("sort"), cash);
    const both = saveTestSale(first, card);
    expect(both.entries.map((e) => e.time)).toEqual(["09:00", "10:00"]);
    expect(() => saveTestSale(both, { ...card, reference: " test_card_001 " })).toThrow(
      "이미 있습니다",
    );
    const normalized = saveTestSale(createTestSales("normalize"), {
      ...card,
      reference: " test_card_001 ",
    });
    expect(normalized.entries[0].reference).toBe("TEST_CARD_001");
  });
  it("rejects edits to posted entries and forged preview stock rows", () => {
    const draft = saveTestSale(createTestSales("tamper"), card);
    const preview = previewTestStock(draft, "TEST_SALE_001");
    expect(() =>
      postTestSale(
        draft,
        { ...preview, rows: [{ ...preview.rows[0], after: 100 }] },
        true,
      ),
    ).toThrow("바뀌었습니다");
    const posted = postTestSale(draft, preview, true);
    expect(() =>
      saveTestSale(posted, card, { id: "TEST_SALE_001", version: 2 }),
    ).toThrow("확정 전표");
  });
  it("transfers post stock once and total apart from cash, so cash comparison excludes them", () => {
    const both = post(post(createTestSales("transfer"), cash), transfer);
    expect(both.stock).toEqual({ TEST_PRODUCT_DECK: 10, TEST_PRODUCT_GRIP: 3 });
    expect(testSalesTotals(both)).toEqual({
      card: 0,
      cash: 5_000,
      transfer: 5_000,
      offline: 10_000,
      online: 0,
      combined: 10_000,
    });
    expect(() => closeTestSales(both, 10_000, true)).toThrow("현금 수기 대조액");
    const closed = closeTestSales(both, 5_000, true);
    expect(closed.snapshots[0]!.totals.transfer).toBe(5_000);
    expect(closed.stock).toEqual(both.stock);
    // Same reference under another method is a different payment, as for card/cash.
    expect(() =>
      saveTestSale(both, { ...transfer, time: "12:00", method: "TRANSFER" }),
    ).toThrow("같은 결제수단");
    expect(
      saveTestSale(both, { ...transfer, reference: "TEST_CASH_001" }).entries,
    ).toHaveLength(3);
    expect(() =>
      saveTestSale(createTestSales("bad"), {
        ...transfer,
        method: "BANK" as TestSaleInput["method"],
      }),
    ).toThrow("카드·현금·이체");
  });
  it("keeps the Korean message and carries an English message for the screen", () => {
    const open = createTestSales("locale");
    let error: unknown;
    try {
      reopenTestSales(open, "TEST_REASON");
    } catch (caught) {
      error = caught;
    }
    expect(error).toBeInstanceOf(TestSalesError);
    expect((error as TestSalesError).message).toBe(
      "모의 마감된 영업일만 재개방할 수 있습니다.",
    );
    expect((error as TestSalesError).localized).toEqual({
      ko: "모의 마감된 영업일만 재개방할 수 있습니다.",
      en: "Only a closed mock business day can be reopened.",
    });
  });
});
