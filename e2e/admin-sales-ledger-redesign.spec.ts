import { expect, test, type Page } from "@playwright/test";
import {
  DAY,
  NEW_ENTRY,
  CLOSE_DAY,
  ACTUAL_MODE,
  sale,
  audits,
  loadDay,
  setup,
  newDraft,
} from "./admin-sales-ledger-fixtures";

test.afterEach(async ({ page }) => {
  const state = audits.get(page);
  if (state) {
    expect(state.forbidden).toEqual([]);
    expect(state.unexpected).toEqual([]);
  }
});

function metric(page: Page, label: string) {
  return page
    .getByRole("article")
    .filter({ has: page.getByText(label, { exact: true }) });
}

async function expectNoDocumentOverflow(page: Page) {
  expect(
    await page.evaluate(
      () =>
        document.documentElement.scrollWidth <=
        document.documentElement.clientWidth + 1,
    ),
  ).toBe(true);
}

test("sales redesign: choosing or practising never reads or writes the actual ledger", async ({
  page,
}) => {
  const state = await setup(page, { mode: "choose" });
  const practice = page.getByRole("button", {
    name: "모의 매출·일마감 체험",
    exact: true,
  });
  await expect(practice).toBeDisabled();
  expect(state.gets).toBe(0);
  expect(state.posts).toEqual([]);
  await page
    .getByLabel("실제 장부와 재고를 바꾸지 않는 모의 체험임을 확인했습니다", {
      exact: true,
    })
    .check();
  await practice.click();
  await expect(
    page.getByRole("region", { name: "모의 매출·일마감", exact: true }),
  ).toContainText("연습 중 · 실제 변경 없음");
  await expect(
    page.getByRole("heading", { name: "모의 매출·일마감 체험", exact: true }),
  ).toBeVisible();
  await page.getByRole("button", { name: "카드 예시 불러오기", exact: true }).click();
  expect(state.gets).toBe(0);
  expect(state.posts).toEqual([]);
  expect(state.stockMoves).toBe(0);
  await page.getByRole("button", { name: "모의 체험 종료", exact: true }).click();
  await expect(
    page.getByRole("heading", { name: "매출·일마감 모드 선택", exact: true }),
  ).toBeVisible();
  await expect(practice).toBeDisabled();
  await page.getByRole("button", { name: ACTUAL_MODE, exact: true }).click();
  await expect(
    page.getByRole("heading", { name: "매출·일마감 관리", exact: true }),
  ).toBeVisible();
  expect(state.gets).toBe(0);
  expect(state.posts).toEqual([]);
  await loadDay(page);
  expect(state.gets).toBe(1);
  expect(state.posts).toEqual([]);
});

test("sales redesign: desktop cards show server net totals and keep closing beside the ledger", async ({
  page,
}, testInfo) => {
  await page.setViewportSize({ width: 1440, height: 1000 });
  const state = await setup(page, {
    entries: [
      sale({
        entryId: "sale_card_001",
        reference: "CARD-NET-001",
        status: "POSTED",
        amount: 10000,
      }),
      sale({
        entryId: "sale_card_refund",
        reference: "CARD-REFUND-001",
        status: "POSTED",
        kind: "REVERSAL",
        amount: 2000,
        original: { businessDay: "2026-10-14", entryId: "sale_card_original" },
        restocked: false,
      }),
      sale({
        entryId: "sale_cash_001",
        reference: "CASH-NET-001",
        status: "POSTED",
        method: "CASH",
        amount: 7000,
      }),
      sale({
        entryId: "sale_cash_refund",
        reference: "CASH-REFUND-001",
        status: "POSTED",
        method: "CASH",
        kind: "REVERSAL",
        amount: 1000,
        original: { businessDay: "2026-10-14", entryId: "sale_cash_original" },
        restocked: false,
      }),
      sale({ entryId: "sale_unposted_001", status: "DRAFT", amount: 99999 }),
      sale({ entryId: "sale_void_001", status: "VOID", amount: 88888 }),
    ],
  });
  const expected = {
    "온라인 순매출": 13000,
    "오프라인 카드 순매출": 8000,
    "오프라인 현금 순매출": 6000,
    "통합 순매출": 27000,
  };
  for (const [label, amount] of Object.entries(expected)) {
    const card = metric(page, label);
    await expect(card).toBeVisible();
    await expect(card.locator("strong")).toHaveText(
      `${amount.toLocaleString("ko-KR")}원`,
    );
  }
  await page.getByText("확정 매출 대조표·집계 기준", { exact: true }).click();
  const totals = page.getByRole("table", {
    name: "확정 매출 대조표 · 원화",
    exact: true,
  });
  await expect(
    totals.getByRole("row", {
      name: "오프라인 카드 10,000원 2,000원 8,000원",
      exact: true,
    }),
  ).toBeVisible();
  await expect(
    totals.getByRole("row", {
      name: "오프라인 현금 7,000원 1,000원 6,000원",
      exact: true,
    }),
  ).toBeVisible();
  await expect(
    totals.getByRole("row", {
      name: "온·오프라인 통합 32,000원 5,000원 27,000원",
      exact: true,
    }),
  ).toBeVisible();
  await page.getByText("확정 매출 대조표·집계 기준", { exact: true }).click();
  const ledger = page
    .getByRole("heading", { name: "오프라인 전표 · 판매 시간순", exact: true })
    .locator("xpath=ancestor::section[1]");
  const close = page.getByRole("region", { name: "일마감", exact: true });
  const ledgerBox = await ledger.boundingBox();
  const closeBox = await close.boundingBox();
  expect(ledgerBox).not.toBeNull();
  expect(closeBox).not.toBeNull();
  expect(closeBox!.x).toBeGreaterThan(ledgerBox!.x + ledgerBox!.width - 1);
  expect(Math.abs(closeBox!.y - ledgerBox!.y)).toBeLessThan(32);
  await expectNoDocumentOverflow(page);
  await page.screenshot({
    path: testInfo.outputPath("sales-redesign-desktop-1440.png"),
    fullPage: true,
  });
  await close.screenshot({
    path: testInfo.outputPath("sales-redesign-desktop-close-1440.png"),
  });
  expect(state.posts).toEqual([]);
  expect(state.stockMoves).toBe(0);
});

test("sales redesign: draft and unresolved online warnings remain visible and prevent closing", async ({
  page,
}) => {
  const state = await setup(page, {
    entries: [sale({ entryId: "sale_pending_001", status: "DRAFT" })],
  });
  await expect(page.getByTestId("ledger-entry-sale_pending_001")).toContainText(
    "작성 중",
  );
  await page.getByLabel("현금 순매출 수기 대조액", { exact: true }).fill("0");
  const acknowledged = page.getByLabel(
    "온라인·오프라인 매출과 경고를 모두 확인했습니다",
    { exact: true },
  );
  await acknowledged.check();
  await expect(
    page.getByRole("button", { name: CLOSE_DAY, exact: true }),
  ).toBeDisabled();
  expect(state.posts).toEqual([]);
  state.entries = [sale({ entryId: "sale_pending_001", status: "POSTED" })];
  state.warnings = ["ONLINE_PAYMENT_RESULT_PENDING"];
  await loadDay(page);
  await expect(page.getByTestId("ledger-entry-sale_pending_001")).toContainText("완료");
  await expect(page.getByLabel("마감 경고", { exact: true })).toContainText(
    "온라인 결제 결과가 확인 대기 중입니다",
  );
  await expect(acknowledged).toBeDisabled();
  await expect(
    page.getByRole("button", { name: CLOSE_DAY, exact: true }),
  ).toBeDisabled();
  expect(state.posts).toEqual([]);
  expect(state.stockMoves).toBe(0);
});

test("sales redesign: an empty successful report shows zero rather than fabricated sales", async ({
  page,
}) => {
  const state = await setup(page, { onlineEvents: [] });
  for (const label of [
    "온라인 순매출",
    "오프라인 카드 순매출",
    "오프라인 현금 순매출",
    "통합 순매출",
  ])
    await expect(metric(page, label).locator("strong")).toHaveText("0원");
  await expect(
    page.getByText("등록된 전표가 없습니다.", { exact: true }),
  ).toBeVisible();
  await expect(page.getByRole("button", { name: / 전표 선택$/ })).toHaveCount(0);
  expect(state.posts).toEqual([]);
  expect(state.stockMoves).toBe(0);
});

test("sales redesign: a failed query does not replace missing totals with zero or allow closing", async ({
  page,
}) => {
  const state = await setup(page, {
    load: false,
    readReply: { status: 503, body: { code: "SALES_OPERATION_UNAVAILABLE" } },
  });
  await page.getByLabel("영업일 (한국 시간)", { exact: true }).fill(DAY);
  await page.getByRole("button", { name: "장부 조회", exact: true }).click();
  await expect(
    page.getByRole("status").filter({ hasText: "장부를 조회하지 못했습니다" }),
  ).toBeVisible();
  await expect(metric(page, "통합 순매출")).toHaveCount(0);
  await expect(page.getByRole("button", { name: CLOSE_DAY, exact: true })).toHaveCount(
    0,
  );
  await expect(page.getByRole("button", { name: NEW_ENTRY, exact: true })).toHaveCount(
    0,
  );
  expect(state.gets).toBe(1);
  expect(state.posts).toEqual([]);
});

test("sales redesign: mobile ledger and editor reflow at 375 and 320 with usable controls", async ({
  page,
}, testInfo) => {
  await page.setViewportSize({ width: 375, height: 900 });
  const state = await setup(page, {
    entries: [
      sale({ entryId: "sale_mobile_001", reference: "CARD-MOBILE", status: "POSTED" }),
    ],
  });
  await expectNoDocumentOverflow(page);
  await page.screenshot({
    path: testInfo.outputPath("sales-redesign-mobile-375.png"),
    fullPage: true,
  });
  await page.getByRole("region", { name: "일마감", exact: true }).screenshot({
    path: testInfo.outputPath("sales-redesign-mobile-close-375.png"),
  });
  await newDraft(page, true);
  const panel = page.getByRole("region", { name: "매출·일마감 관리", exact: true });
  for (const width of [375, 320]) {
    await page.setViewportSize({ width, height: 900 });
    await expectNoDocumentOverflow(page);
    for (const name of [NEW_ENTRY, "초안 저장", "미매칭 줄 추가", CLOSE_DAY])
      expect(
        (await panel.getByRole("button", { name, exact: true }).boundingBox())?.height,
      ).toBeGreaterThanOrEqual(44);
    for (const label of [
      "영업일 (한국 시간)",
      "판매일시 (한국 시간)",
      "전표 참조번호",
      "전표 금액",
      "현금 순매출 수기 대조액",
    ])
      expect(
        (await panel.getByLabel(label, { exact: true }).boundingBox())?.height,
      ).toBeGreaterThanOrEqual(44);
  }
  await page.screenshot({
    path: testInfo.outputPath("sales-redesign-mobile-editor-320.png"),
    fullPage: true,
  });
  await page.getByRole("region", { name: "일마감", exact: true }).screenshot({
    path: testInfo.outputPath("sales-redesign-mobile-close-320.png"),
  });
  await expect(page.getByLabel("1번 상품명", { exact: true })).toHaveValue("Deck");
  expect(state.posts).toEqual([]);
  expect(state.stockMoves).toBe(0);
});

test("transfer: saved, posted and shown in gray apart from card and cash; cash comparison excludes it", async ({
  page,
}, testInfo) => {
  await page.setViewportSize({ width: 1440, height: 1000 });
  const state = await setup(page, {
    entries: [
      sale({ entryId: "sale_card_001", reference: "CARD-001", status: "POSTED" }),
      sale({
        entryId: "sale_cash_001",
        reference: "CASH-001",
        status: "POSTED",
        method: "CASH",
        amount: 7000,
      }),
    ],
    onlineEvents: [],
  });
  await newDraft(page, true);
  await page
    .getByRole("combobox", { name: "결제 구분", exact: true })
    .selectOption("TRANSFER");
  await page.getByLabel("전표 참조번호", { exact: true }).fill("TRANSFER-001");
  await page.getByRole("button", { name: "초안 저장", exact: true }).click();
  await expect.poll(() => state.entries.length).toBe(3);
  expect(state.posts[0]).toMatchObject({ action: "save", method: "TRANSFER" });
  await page.getByRole("button", { name: "재고 반영 미리보기", exact: true }).click();
  await page
    .getByLabel("상품·옵션·수량과 재고 변동을 확인했습니다", { exact: true })
    .check();
  await page.getByRole("button", { name: "판매 확정·재고 반영", exact: true }).click();
  await expect.poll(() => state.stock).toBe(9);

  const transferId = state.entries.find((e) => e.method === "TRANSFER")!.entryId;
  const chip = (id: string) =>
    page.getByTestId(`ledger-entry-${id}`).locator("[data-method]");
  await expect(chip(transferId)).toHaveText("이체");
  await expect(chip("sale_card_001")).toHaveText("카드");
  await expect(chip("sale_cash_001")).toHaveText("현금");
  const colors = await Promise.all(
    [transferId, "sale_card_001", "sale_cash_001"].map((id) =>
      chip(id).evaluate((el) => getComputedStyle(el).backgroundColor),
    ),
  );
  expect(colors).toEqual([
    "rgb(241, 243, 245)",
    "rgb(232, 241, 253)",
    "rgb(233, 247, 239)",
  ]);
  await expect(page.getByTestId(`ledger-entry-${transferId}`)).toContainText(
    "이체 판매",
  );

  for (const [label, amount] of [
    ["오프라인 카드 순매출", "10,000원"],
    ["오프라인 현금 순매출", "7,000원"],
    ["오프라인 이체 순매출", "10,000원"],
    ["통합 순매출", "27,000원"],
  ])
    await expect(metric(page, label).locator("strong")).toHaveText(amount);
  await expect(page.locator("dl").filter({ hasText: "이체 순매출" })).toContainText(
    "이체 순매출10,000원",
  );
  await page.screenshot({
    path: testInfo.outputPath("transfer-desktop.png"),
    fullPage: true,
  });
  await page.setViewportSize({ width: 375, height: 900 });
  await expectNoDocumentOverflow(page);
  await page.screenshot({
    path: testInfo.outputPath("transfer-mobile.png"),
    fullPage: true,
  });
  console.log(`Transfer screenshots: ${testInfo.outputPath()}`);
  await page.setViewportSize({ width: 1440, height: 1000 });
  await page.getByText("확정 매출 대조표·집계 기준", { exact: true }).click();
  const totals = page.getByRole("table", {
    name: "확정 매출 대조표 · 원화",
    exact: true,
  });
  await expect(
    totals.getByRole("row", {
      name: "오프라인 이체 10,000원 0원 10,000원",
      exact: true,
    }),
  ).toBeVisible();
  await expect(
    totals.getByRole("row", {
      name: "오프라인 합계 27,000원 0원 27,000원",
      exact: true,
    }),
  ).toBeVisible();

  const close = page.getByRole("button", { name: CLOSE_DAY, exact: true });
  const acknowledged = page.getByLabel(
    "온라인·오프라인 매출과 경고를 모두 확인했습니다",
    { exact: true },
  );
  // Cash plus transfer is not the cash amount; only cash compares.
  await page.getByLabel("현금 순매출 수기 대조액", { exact: true }).fill("17000");
  await acknowledged.check();
  await expect(close).toBeDisabled();
  await page.getByLabel("현금 순매출 수기 대조액", { exact: true }).fill("7000");
  await expect(acknowledged).not.toBeChecked();
  await acknowledged.check();
  await close.click();
  await expect.poll(() => state.status).toBe("CLOSED");
  expect(state.posts.at(-1)).toMatchObject({
    action: "close",
    cashComparedAmount: 7000,
  });
  expect(state.snapshots[0]!.totals.transfer).toBe(10000);
});
