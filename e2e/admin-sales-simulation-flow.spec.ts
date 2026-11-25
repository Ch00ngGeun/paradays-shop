// 역할: 매출 모의 실행의 전표·재고 차감·마감 계산과 메모리 유지·폐기, 이체·모바일·작업 단계를 검증함.
import { expect, test } from "@playwright/test";
import {
  ORIGIN,
  audits,
  setup,
  selectMenu,
  openSales,
  snapshotStorage,
  trackStorageWrites,
  expectNoStorageWrites,
  startSimulation,
  expectStock,
  postSample,
} from "./admin-sales-simulation-fixtures";

test.afterEach(async ({ page }) => {
  const audit = audits.get(page);
  if (audit) {
    expect(audit.forbidden).toEqual([]);
    expect(audit.unexpected).toEqual([]);
    expect(audit.simulationRequests).toEqual([]);
  }
});

test("explicit synthetic mode separates actual controls and never persists or requests production sales", async ({
  page,
}) => {
  const audit = await setup(page);
  await openSales(page);
  const before = await snapshotStorage(page);
  await trackStorageWrites(page);
  await startSimulation(page, audit);
  await expectStock(page, 10, 5);
  await expect(page.getByRole("note")).toContainText("실제");
  expect(audit.salesRequests).toEqual([]);
  expect(await snapshotStorage(page)).toEqual(before);
  await expectNoStorageWrites(page);
  expect(page.url()).toBe(`${ORIGIN}/admin?section=sales`);
});

test("card draft/preview do not deduct; double confirmation deducts once and cash makes 25000", async ({
  page,
}) => {
  const audit = await setup(page);
  await openSales(page);
  const before = await snapshotStorage(page);
  await trackStorageWrites(page);
  await startSimulation(page, audit);
  await page.getByRole("button", { name: "카드 예시 불러오기", exact: true }).click();
  await expectStock(page, 10, 5);
  await page.getByRole("button", { name: "모의 초안 저장", exact: true }).click();
  await expectStock(page, 10, 5);
  await expect(page.getByLabel("모의 통합 매출", { exact: true })).toHaveText("0원");
  await page
    .getByRole("button", { name: "가상 재고 예정표 확인", exact: true })
    .click();
  await expectStock(page, 10, 5);
  const confirm = page.getByRole("button", { name: "모의 판매 확정", exact: true });
  await expect(confirm).toBeDisabled();
  await page
    .getByLabel("예정표의 가상 재고 차감을 확인했습니다", { exact: true })
    .check();
  await confirm.evaluate((button) => {
    (button as HTMLButtonElement).click();
    (button as HTMLButtonElement).click();
  });
  await expectStock(page, 8, 5);
  await expect(page.getByLabel("모의 카드 매출", { exact: true })).toHaveText(
    "20,000원",
  );
  await postSample(page, "현금");
  await expectStock(page, 8, 4);
  await expect(page.getByLabel("모의 현금 매출", { exact: true })).toHaveText(
    "5,000원",
  );
  await expect(page.getByLabel("모의 온라인 매출", { exact: true })).toHaveText("0원");
  await expect(page.getByLabel("모의 통합 매출", { exact: true })).toHaveText(
    "25,000원",
  );
  expect(await snapshotStorage(page)).toEqual(before);
  await expectNoStorageWrites(page);
});

test("closing requires all drafts posted and matching cash; duplicate close and reopen never deduct again", async ({
  page,
}) => {
  const audit = await setup(page);
  await openSales(page);
  const before = await snapshotStorage(page);
  await trackStorageWrites(page);
  await startSimulation(page, audit);
  await page.getByRole("button", { name: "카드 예시 불러오기", exact: true }).click();
  await page.getByRole("button", { name: "모의 초안 저장", exact: true }).click();
  await page.getByLabel("모의 현금 수기 대조액 (원)", { exact: true }).fill("0");
  await page
    .getByLabel("모의 합계와 현금 대조액을 확인했습니다", { exact: true })
    .check();
  const close = page.getByRole("button", { name: "모의 일마감 확정", exact: true });
  await expect(close).toBeDisabled();
  await expectStock(page, 10, 5);
  await page
    .getByRole("button", { name: "가상 재고 예정표 확인", exact: true })
    .click();
  await page
    .getByLabel("예정표의 가상 재고 차감을 확인했습니다", { exact: true })
    .check();
  await page.getByRole("button", { name: "모의 판매 확정", exact: true }).click();
  await postSample(page, "현금");
  await page.getByLabel("모의 현금 수기 대조액 (원)", { exact: true }).fill("4999");
  await page
    .getByLabel("모의 합계와 현금 대조액을 확인했습니다", { exact: true })
    .check();
  await expect(close).toBeDisabled();
  await page.getByLabel("모의 현금 수기 대조액 (원)", { exact: true }).fill("5000");
  await expect(close).toBeDisabled();
  await page
    .getByLabel("모의 합계와 현금 대조액을 확인했습니다", { exact: true })
    .check();
  await close.evaluate((button) => {
    (button as HTMLButtonElement).click();
    (button as HTMLButtonElement).click();
  });
  await expect(
    page.getByRole("heading", { name: "가상 영업일 · 모의 마감 완료", exact: true }),
  ).toBeVisible();
  const snapshots = page.getByRole("region", { name: "모의 마감 스냅샷", exact: true });
  await expect(snapshots.getByRole("heading", { level: 4 })).toHaveCount(1);
  await expect(snapshots).toContainText("통합 25,000원");
  await expectStock(page, 8, 4);
  await page.getByLabel("모의 재개방 사유", { exact: true }).fill("TEST_RECHECK");
  await page.getByRole("button", { name: "모의 영업일 재개방", exact: true }).click();
  await expectStock(page, 8, 4);
  await page.getByLabel("모의 현금 수기 대조액 (원)", { exact: true }).fill("5000");
  await page
    .getByLabel("모의 합계와 현금 대조액을 확인했습니다", { exact: true })
    .check();
  await close.click();
  await expect(snapshots.getByRole("heading", { level: 4 })).toHaveCount(2);
  await expectStock(page, 8, 4);
  expect(await snapshotStorage(page)).toEqual(before);
  await expectNoStorageWrites(page);
});

test("menu changes keep memory; reset, exit and refresh discard all synthetic entries and confirmations", async ({
  page,
}) => {
  const audit = await setup(page);
  await openSales(page);
  await startSimulation(page, audit);
  await postSample(page, "카드");
  await expectStock(page, 8, 5);
  await selectMenu(page, "브랜드");
  await openSales(page);
  await expectStock(page, 8, 5);
  await expect(
    page.getByRole("button", { name: "TEST_SALE_001 모의 전표 선택", exact: true }),
  ).toBeVisible();
  await page.getByRole("button", { name: "모의 데이터 초기화", exact: true }).click();
  await expectStock(page, 10, 5);
  await expect(
    page.getByRole("button", { name: "TEST_SALE_001 모의 전표 선택", exact: true }),
  ).toHaveCount(0);
  await expect(
    page.getByRole("button", { name: "모의 판매 확정", exact: true }),
  ).toHaveCount(0);
  await expect(page.getByLabel("모의 통합 매출", { exact: true })).toHaveText("0원");
  await postSample(page, "현금");
  await page.getByRole("button", { name: "모의 체험 종료", exact: true }).click();
  await expect(page.getByLabel("가상 데크 재고", { exact: true })).toHaveCount(0);
  await startSimulation(page, audit);
  await expectStock(page, 10, 5);
  await postSample(page, "카드");
  audit.simulation = false;
  await page.reload();
  await page.waitForLoadState("networkidle");
  await openSales(page);
  await expect(page.getByLabel("가상 데크 재고", { exact: true })).toHaveCount(0);
  await startSimulation(page, audit);
  await expectStock(page, 10, 5);
  await expect(
    page.getByRole("button", { name: "TEST_SALE_001 모의 전표 선택", exact: true }),
  ).toHaveCount(0);
  expect(
    (await snapshotStorage(page)).session.some(([, value]) =>
      value?.includes("TEST_SALE_001"),
    ),
  ).toBe(false);
});

test("mobile simulation keeps the warning and core controls within the viewport", async ({
  page,
}, info) => {
  await page.setViewportSize({ width: 390, height: 844 });
  const audit = await setup(page);
  await openSales(page);
  await startSimulation(page, audit);
  await postSample(page, "카드");
  await expectStock(page, 8, 5);
  await expect(page.getByRole("note")).toBeVisible();
  const panel = page.getByRole("region", {
    name: "모의 매출·일마감 체험",
    exact: true,
  });
  expect((await panel.boundingBox())!.width).toBeLessThanOrEqual(390);
  expect(
    await page.evaluate(() => document.documentElement.scrollWidth),
  ).toBeLessThanOrEqual(390);
  await panel.screenshot({ path: info.outputPath("sales-simulation-mobile.png") });
});

test("transfer: synthetic transfer posts once, shows gray and stays out of the cash comparison", async ({
  page,
}) => {
  const audit = await setup(page);
  await openSales(page);
  const before = await snapshotStorage(page);
  await trackStorageWrites(page);
  await startSimulation(page, audit);
  await postSample(page, "현금");
  await postSample(page, "이체");
  await expectStock(page, 10, 3);
  await expect(page.getByLabel("모의 현금 매출", { exact: true })).toHaveText(
    "5,000원",
  );
  await expect(page.getByLabel("모의 이체 매출", { exact: true })).toHaveText(
    "5,000원",
  );
  await expect(page.getByLabel("모의 통합 매출", { exact: true })).toHaveText(
    "10,000원",
  );
  const chips = page
    .getByRole("table", { name: "합성 TEST 판매 전표", exact: true })
    .locator("[data-method]");
  await expect(chips).toHaveText(["현금", "이체"]);
  expect(
    await chips.last().evaluate((el) => getComputedStyle(el).backgroundColor),
  ).toBe("rgb(241, 243, 245)");
  const close = page.getByRole("button", { name: "모의 일마감 확정", exact: true });
  const confirm = page.getByLabel("모의 합계와 현금 대조액을 확인했습니다", {
    exact: true,
  });
  await page.getByLabel("모의 현금 수기 대조액 (원)", { exact: true }).fill("10000");
  await confirm.check();
  await expect(close).toBeDisabled();
  await page.getByLabel("모의 현금 수기 대조액 (원)", { exact: true }).fill("5000");
  await confirm.check();
  await close.click();
  const snapshots = page.getByRole("region", { name: "모의 마감 스냅샷", exact: true });
  await expect(snapshots).toContainText("이체 5,000원");
  await expect(snapshots).toContainText("확인 현금 5,000원");
  await expectStock(page, 10, 3);
  expect(await snapshotStorage(page)).toEqual(before);
  await expectNoStorageWrites(page);
});

test("work flow: synthetic sales steps follow drafts, posting and the synthetic close", async ({
  page,
}) => {
  const audit = await setup(page);
  await openSales(page);
  await startSimulation(page, audit);
  const flow = () =>
    page
      .getByRole("list", { name: "모의 매출 작업 흐름", exact: true })
      .getByRole("listitem")
      .evaluateAll((items) => items.map((item) => (item as HTMLElement).dataset.state));
  await expect.poll(flow).toEqual(["current", "upcoming", "upcoming"]);
  await page.getByRole("button", { name: "현금 예시 불러오기", exact: true }).click();
  await page.getByRole("button", { name: "모의 초안 저장", exact: true }).click();
  await expect.poll(flow).toEqual(["complete", "current", "upcoming"]);
  await page
    .getByRole("button", { name: "가상 재고 예정표 확인", exact: true })
    .click();
  await page
    .getByLabel("예정표의 가상 재고 차감을 확인했습니다", { exact: true })
    .check();
  await page.getByRole("button", { name: "모의 판매 확정", exact: true }).click();
  await expect.poll(flow).toEqual(["complete", "complete", "current"]);
  await page.getByLabel("모의 현금 수기 대조액 (원)", { exact: true }).fill("5000");
  await page
    .getByLabel("모의 합계와 현금 대조액을 확인했습니다", { exact: true })
    .check();
  await page.getByRole("button", { name: "모의 일마감 확정", exact: true }).click();
  await expect.poll(flow).toEqual(["complete", "complete", "complete"]);
});
