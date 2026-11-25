// 역할: 매출 전표 저장·재고 차감 확인·취소/재입고·일 마감·불확실한 명령 재시도와 작업 단계·필수 입력을 검증함.
import { expect, test, type Page } from "@playwright/test";
import {
  DAY,
  FINGERPRINT,
  PREVIEW_TOKEN,
  NEW_ENTRY,
  CLOSE_DAY,
  sale,
  audits,
  openSales,
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

async function ledgerFlow(page: Page) {
  return page
    .getByRole("list", { name: "실제 매출 작업 흐름", exact: true })
    .getByRole("listitem")
    .evaluateAll((items) => items.map((item) => (item as HTMLElement).dataset.state));
}

test("unmatched draft saves the KST time without changing stock or guessing a product", async ({
  page,
}) => {
  const state = await setup(page);
  await newDraft(page, false);
  await page.getByRole("button", { name: "초안 저장", exact: true }).click();
  await expect.poll(() => state.posts.length).toBe(1);
  expect(state.posts[0]).toMatchObject({
    action: "save",
    expectedVersion: 0,
    method: "CARD",
    reference: "CARD-LOCAL-001",
    amount: 10000,
    lines: [
      {
        productId: null,
        name: "아직 연결하지 않은 상품",
        quantity: 1,
        unitAmount: 10000,
      },
    ],
  });
  const save = state.posts[0]!;
  expect(save.action).toBe("save");
  if (save.action === "save")
    expect(new Date(save.soldAt).toISOString()).toBe("2026-10-15T00:30:00.000Z");
  expect(state.entries[0]?.status).toBe("DRAFT");
  expect(state.stock).toBe(10);
  expect(state.stockMoves).toBe(0);
  await expect(
    page.getByRole("button", { name: "판매 확정·재고 반영", exact: true }),
  ).toHaveCount(0);
  const discard = page.getByRole("button", { name: "초안 폐기", exact: true });
  await expect(discard).toBeDisabled();
  await page.getByLabel("보류 전표 폐기 사유", { exact: true }).fill("중복 수기 초안");
  await discard.click();
  await expect.poll(() => state.entries[0]?.status).toBe("VOID");
  expect(state.posts[1]).toMatchObject({
    action: "void",
    reason: "중복 수기 초안",
    version: 1,
  });
  expect(state.stock).toBe(10);
  expect(state.stockMoves).toBe(0);
});

test("a product name entered on two lines is saved as one line in the sale line", async ({
  page,
}) => {
  // 장부 서버는 줄 이름의 줄바꿈 같은 제어 문자를 거부함.
  const state = await setup(page, { productName: "Synthetic\nDeck  \t8.25" });
  await page.getByRole("button", { name: NEW_ENTRY, exact: true }).click();
  await page.getByLabel("상품 이름 검색", { exact: true }).fill("Deck");
  await page
    .getByRole("button", { name: "Synthetic Deck 8.25 연결", exact: true })
    .click();
  await expect(page.getByLabel("1번 상품명", { exact: true })).toHaveValue(
    "Synthetic Deck 8.25",
  );
  await page.getByLabel("판매일시 (한국 시간)", { exact: true }).fill(`${DAY}T09:30`);
  await page
    .getByRole("combobox", { name: "결제 구분", exact: true })
    .selectOption("CARD");
  await page.getByLabel("전표 참조번호", { exact: true }).fill("CARD-LOCAL-002");
  await page.getByLabel("전표 금액", { exact: true }).fill("10000");
  await page.getByLabel("1번 수량", { exact: true }).fill("1");
  await page.getByLabel("1번 단가", { exact: true }).fill("10000");
  await page.getByRole("button", { name: "초안 저장", exact: true }).click();
  await expect.poll(() => state.posts.length).toBe(1);
  const save = state.posts[0]!;
  if (save.action !== "save") throw new Error(`expected a save, got ${save.action}`);
  const name = save.lines[0]!.name;
  expect(name).toBe("Synthetic Deck 8.25");
  expect(name).not.toMatch(/[\u0000-\u001f\u007f]/);
});

test("matched sale needs a stock preview and explicit confirmation before a single stock debit", async ({
  page,
}) => {
  const state = await setup(page);
  await newDraft(page, true);
  await page.getByRole("button", { name: "초안 저장", exact: true }).click();
  await expect.poll(() => state.entries.length).toBe(1);
  expect(state.stockMoves).toBe(0);
  const post = page.getByRole("button", { name: "판매 확정·재고 반영", exact: true });
  await expect(post).toHaveCount(0);
  await page.getByRole("button", { name: "재고 반영 미리보기", exact: true }).click();
  await expect
    .poll(() => state.posts.filter((item) => item.action === "preview").length)
    .toBe(1);
  await expect(post).toBeDisabled();
  expect(state.stock).toBe(10);
  await page
    .getByLabel("상품·옵션·수량과 재고 변동을 확인했습니다", { exact: true })
    .check();
  await post.click();
  await expect.poll(() => state.stock).toBe(9);
  expect(state.stockMoves).toBe(1);
  expect(state.posts.find((item) => item.action === "post")).toMatchObject({
    action: "post",
    entryId: state.entries[0]!.entryId,
    version: 1,
    previewToken: PREVIEW_TOKEN,
    confirmed: true,
  });
  await page.getByLabel("현금 순매출 수기 대조액", { exact: true }).fill("0");
  await page
    .getByLabel("온라인·오프라인 매출과 경고를 모두 확인했습니다", { exact: true })
    .check();
  await page.getByRole("button", { name: CLOSE_DAY, exact: true }).click();
  await expect.poll(() => state.status).toBe("CLOSED");
  expect(state.posts.map((command) => command.action)).toEqual([
    "save",
    "preview",
    "post",
    "close",
  ]);
  expect(state.stock).toBe(9);
  expect(state.stockMoves).toBe(1);
});

test("entries render in sale-time order with Korean times even in an American browser", async ({
  page,
}) => {
  await setup(page, {
    entries: [
      sale({
        entryId: "sale_late_001",
        reference: "CARD-LATE",
        soldAt: "2026-10-15T11:45:00.000Z",
      }),
      sale({
        entryId: "sale_early_001",
        reference: "CARD-EARLY",
        soldAt: "2026-10-14T15:05:00.000Z",
      }),
      sale({
        entryId: "sale_middle_001",
        reference: "CARD-MIDDLE",
        soldAt: "2026-10-15T00:30:00.000Z",
      }),
    ],
  });
  const choices = page.locator('button[aria-label$=" 전표 선택"]');
  await expect(choices).toHaveCount(3);
  expect(
    await choices.evaluateAll((buttons) =>
      buttons.map((button) => button.getAttribute("aria-label")),
    ),
  ).toEqual([
    "이어서 작성 · sale_early_001 전표 선택",
    "이어서 작성 · sale_middle_001 전표 선택",
    "이어서 작성 · sale_late_001 전표 선택",
  ]);
  await page
    .getByRole("button", {
      name: "이어서 작성 · sale_early_001 전표 선택",
      exact: true,
    })
    .click();
  await expect(page.getByLabel("판매일시 (한국 시간)", { exact: true })).toHaveValue(
    `${DAY}T00:05`,
  );
  await page
    .getByRole("button", { name: "이어서 작성 · sale_late_001 전표 선택", exact: true })
    .click();
  await expect(page.getByLabel("판매일시 (한국 시간)", { exact: true })).toHaveValue(
    `${DAY}T20:45`,
  );
});

test("money-only reversal and physically inspected restocking require separate choices", async ({
  page,
}) => {
  const state = await setup(page, {
    entries: [
      sale({ entryId: "sale_money_001", reference: "CARD-MONEY", status: "POSTED" }),
      sale({ entryId: "sale_stock_001", reference: "CARD-STOCK", status: "POSTED" }),
    ],
  });
  await page
    .getByRole("button", { name: "상세 · sale_money_001 전표 선택", exact: true })
    .click();
  await page.getByLabel("반대전표 사유", { exact: true }).fill("금액만 환불 기록");
  await page
    .getByLabel("반대전표 판매일시 (한국 시간)", { exact: true })
    .fill(`${DAY}T13:00`);
  const reverse = page.getByRole("button", { name: "반대전표 기록", exact: true });
  await expect(reverse).toBeDisabled();
  await page
    .getByLabel("원전표 전체 금액의 반대전표임을 확인했습니다", { exact: true })
    .check();
  await reverse.click();
  await expect
    .poll(() => state.posts.filter((item) => item.action === "reverse").length)
    .toBe(1);
  expect(state.posts[0]).toMatchObject({
    action: "reverse",
    originalId: "sale_money_001",
    restockInspected: false,
    confirmed: true,
  });
  expect(state.stock).toBe(10);
  await page
    .getByRole("button", { name: "상세 · sale_stock_001 전표 선택", exact: true })
    .click();
  await expect(
    page.getByLabel("원전표 전체 금액의 반대전표임을 확인했습니다", { exact: true }),
  ).not.toBeChecked();
  await expect(
    page.getByLabel("실물 입고·검수 완료 및 재판매 가능을 확인했습니다", {
      exact: true,
    }),
  ).not.toBeChecked();
  await page.getByLabel("반대전표 사유", { exact: true }).fill("실물 입고·검수 완료");
  await page
    .getByLabel("반대전표 판매일시 (한국 시간)", { exact: true })
    .fill(`${DAY}T14:00`);
  await page
    .getByLabel("실물 입고·검수 완료 및 재판매 가능을 확인했습니다", { exact: true })
    .check();
  await page
    .getByLabel("원전표 전체 금액의 반대전표임을 확인했습니다", { exact: true })
    .check();
  await reverse.click();
  await expect.poll(() => state.stock).toBe(11);
  expect(state.stockMoves).toBe(1);
  expect(state.posts[1]).toMatchObject({
    action: "reverse",
    originalId: "sale_stock_001",
    restockInspected: true,
    confirmed: true,
  });
});

test("day close is blocked by ledger warnings and requires cash comparison; reopening needs a reason", async ({
  page,
}) => {
  const state = await setup(page, {
    entries: [sale({ method: "CASH", status: "POSTED" })],
    warnings: ["UNPOSTED_SALES"],
  });
  const close = page.getByRole("button", { name: CLOSE_DAY, exact: true });
  await page.getByLabel("현금 순매출 수기 대조액", { exact: true }).fill("10000");
  await expect(
    page.getByLabel("온라인·오프라인 매출과 경고를 모두 확인했습니다", { exact: true }),
  ).toBeDisabled();
  await expect(close).toBeDisabled();
  expect(state.posts).toEqual([]);
  state.warnings = [];
  await loadDay(page);
  await page.getByLabel("현금 순매출 수기 대조액", { exact: true }).fill("10000");
  await page
    .getByLabel("온라인·오프라인 매출과 경고를 모두 확인했습니다", { exact: true })
    .check();
  await close.click();
  await expect.poll(() => state.status).toBe("CLOSED");
  expect(state.posts[0]).toMatchObject({
    action: "close",
    expectedVersion: 3,
    onlineFingerprint: FINGERPRINT,
    cashComparedAmount: 10000,
    confirmed: true,
  });
  const reopen = page.getByRole("button", { name: "마감 재개방", exact: true });
  await expect(reopen).toBeDisabled();
  await page.getByLabel("재개방 사유", { exact: true }).fill("마감 뒤 전표 확인");
  await reopen.click();
  await expect.poll(() => state.status).toBe("OPEN");
  expect(state.posts[1]).toMatchObject({
    action: "reopen",
    expectedVersion: 4,
    reason: "마감 뒤 전표 확인",
  });
});

test("unknown save locks writes and retries the identical request before releasing the lock", async ({
  page,
}) => {
  let failed = false;
  const state = await setup(page, {
    handle: (command) => {
      if (command.action === "save" && !failed) {
        failed = true;
        return { status: 503, body: { code: "SALES_OPERATION_UNAVAILABLE" } };
      }
    },
  });
  await newDraft(page, false);
  await page.getByRole("button", { name: "초안 저장", exact: true }).click();
  await expect(
    page.getByRole("button", { name: "같은 요청 재시도", exact: true }),
  ).toBeVisible();
  await expect(page.getByRole("region", { name: "미확정 요청 보호" })).toBeVisible();
  await expect(
    page.getByRole("heading", { name: "처리 결과 확인 필요", exact: true }),
  ).toBeVisible();
  await expect(
    page.getByRole("button", { name: "모드 선택으로 돌아가기", exact: true }),
  ).toBeDisabled();
  await expect(
    page.getByRole("button", { name: NEW_ENTRY, exact: true }),
  ).toBeDisabled();
  await expect(
    page.getByRole("button", { name: "초안 저장", exact: true }),
  ).toBeDisabled();
  await expect(page.getByLabel("전표 금액", { exact: true })).toBeDisabled();
  await page.getByRole("button", { name: "같은 요청 재시도", exact: true }).click();
  await expect.poll(() => state.posts.length).toBe(2);
  expect(state.rawPosts[1]).toBe(state.rawPosts[0]);
  expect(state.posts[1]).toEqual(state.posts[0]);
  await expect(
    page.getByRole("button", { name: NEW_ENTRY, exact: true }),
  ).toBeEnabled();
  expect(state.entries).toHaveLength(1);
  expect(state.stockMoves).toBe(0);
});

test("unknown operation survives refresh; a report read alone cannot unlock a new write", async ({
  page,
}) => {
  const state = await setup(page, {
    handle: (command) => (command.action === "save" ? { abort: true } : undefined),
  });
  await newDraft(page, false);
  await page.getByRole("button", { name: "초안 저장", exact: true }).click();
  await expect(
    page.getByRole("button", { name: "결과 재조회", exact: true }),
  ).toBeVisible();
  await page.reload();
  await openSales(page);
  await expect(
    page.getByRole("button", { name: "결과 재조회", exact: true }),
  ).toBeVisible();
  await expect(page.getByRole("button", { name: NEW_ENTRY, exact: true })).toHaveCount(
    0,
  );
  const unlock = page.getByRole("button", {
    name: "미확정 요청 잠금 해제",
    exact: true,
  });
  await expect(unlock).toBeDisabled();
  const beforeRead = state.gets;
  await page.getByRole("button", { name: "결과 재조회", exact: true }).click();
  await expect.poll(() => state.gets).toBeGreaterThan(beforeRead);
  await expect(
    page.getByRole("button", { name: NEW_ENTRY, exact: true }),
  ).toBeDisabled();
  await expect(unlock).toBeDisabled();
  await page
    .getByLabel("재조회한 장부에서 처리 결과를 직접 확인했습니다", { exact: true })
    .check();
  await unlock.click();
  await expect(
    page.getByRole("button", { name: NEW_ENTRY, exact: true }),
  ).toBeEnabled();
  expect(state.posts).toHaveLength(1);
  expect(state.stockMoves).toBe(0);
});

test("work flow: actual sales steps follow drafts and the server close status", async ({
  page,
}) => {
  const state = await setup(page, {
    entries: [sale({ entryId: "sale_draft_001", status: "DRAFT" })],
  });
  await expect
    .poll(() => ledgerFlow(page))
    .toEqual(["complete", "current", "upcoming"]);
  state.entries = [sale({ method: "CASH", status: "POSTED" })];
  await loadDay(page);
  await expect
    .poll(() => ledgerFlow(page))
    .toEqual(["complete", "complete", "current"]);
  await page.getByLabel("현금 순매출 수기 대조액", { exact: true }).fill("10000");
  await page
    .getByLabel("온라인·오프라인 매출과 경고를 모두 확인했습니다", { exact: true })
    .check();
  await page.getByRole("button", { name: CLOSE_DAY, exact: true }).click();
  await expect.poll(() => state.status).toBe("CLOSED");
  await expect
    .poll(() => ledgerFlow(page))
    .toEqual(["complete", "complete", "complete"]);
  expect(state.stockMoves).toBe(0);
});

test("required fields: empty sales inputs that block a step use the selected-box blue until filled", async ({
  page,
}) => {
  await setup(page, { entries: [sale({ method: "CASH", status: "POSTED" })] });
  const look = (label: string) =>
    page.getByLabel(label, { exact: true }).evaluate((element) => {
      const style = getComputedStyle(element);
      return [style.backgroundColor, style.borderTopColor];
    });
  const required = ["rgb(242, 246, 250)", "rgb(40, 100, 180)"];
  const cash = page.getByLabel("현금 순매출 수기 대조액", { exact: true });
  await expect(cash).toHaveAttribute("required", "");
  expect(await look("현금 순매출 수기 대조액")).toEqual(required);
  await cash.fill("10000");
  expect(await look("현금 순매출 수기 대조액")).not.toEqual(required);
  // 선택 입력인 메모는 파랗게 바뀌지 않음.
  await page.getByRole("button", { name: NEW_ENTRY, exact: true }).click();
  expect(await look("메모")).not.toEqual(required);
  expect(await look("전표 참조번호")).toEqual(required);
});
