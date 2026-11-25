// 역할: 매출 모의 실행이 권한 없는 세션에서 켜지지 않고, 실제 진행 중·미확정 작업과 로그아웃 처리를 보존하는지 검증함.
import { expect, test } from "@playwright/test";
import {
  ORIGIN,
  DAY,
  PENDING_KEY,
  pendingAttempt,
  emptyReport,
  audits,
  json,
  setup,
  selectMenu,
  openSales,
  snapshotStorage,
  trackStorageWrites,
  expectNoStorageWrites,
  startSimulation,
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

test("member and anonymous sessions cannot activate through URL or stored mode flags", async ({
  page,
}) => {
  await setup(page, { groups: [] });
  await page.evaluate(() => localStorage.setItem("salesSimulationEnabled", "true"));
  await page.goto("/admin?salesSimulation=true&mode=test");
  await expect(
    page.getByRole("heading", { name: "관리자 권한이 없습니다", exact: true }),
  ).toBeVisible();
  await expect(
    page.getByRole("heading", { name: "매출·일마감 모드 선택", exact: true }),
  ).toHaveCount(0);
  await expect(
    page.getByRole("button", { name: "모의 매출·일마감 체험", exact: true }),
  ).toHaveCount(0);
  await page.evaluate(() => {
    sessionStorage.removeItem("paradays.auth.session");
    localStorage.removeItem("paradays.auth.session");
  });
  await page.reload();
  await expect(
    page.getByRole("button", { name: "모의 매출·일마감 체험", exact: true }),
  ).toHaveCount(0);
});

test("an existing actual pending command remains byte-for-byte intact through simulation and blocks leaving actual mode", async ({
  page,
}) => {
  const audit = await setup(page, { pending: pendingAttempt });
  await openSales(page);
  const before = await snapshotStorage(page);
  await trackStorageWrites(page);
  await startSimulation(page, audit);
  await postSample(page, "카드");
  await page.getByRole("button", { name: "모의 체험 종료", exact: true }).click();
  expect(await snapshotStorage(page)).toEqual(before);
  await expectNoStorageWrites(page);
  audit.simulation = false;
  await page
    .getByRole("button", {
      name: "실제 운영 열기 · 실제 매출·일마감 열기",
      exact: true,
    })
    .click();
  await expect(
    page.getByRole("button", { name: "결과 재조회", exact: true }),
  ).toBeVisible();
  await expect(
    page.getByRole("button", { name: "같은 요청 재시도", exact: true }),
  ).toBeVisible();
  const leave = page.getByRole("button", {
    name: "모드 선택으로 돌아가기",
    exact: true,
  });
  await expect(leave).toBeDisabled();
  await leave.evaluate((button) => (button as HTMLButtonElement).click());
  await expect(
    page.getByRole("heading", { name: "매출·일마감 관리", exact: true }),
  ).toBeVisible();
  expect(await page.evaluate((key) => sessionStorage.getItem(key), PENDING_KEY)).toBe(
    pendingAttempt,
  );
  expect(audit.salesRequests).toEqual([]);
});

test("actual in-flight requests and memory-only uncertain writes cannot be lost by switching modes", async ({
  page,
}) => {
  let releaseRead!: () => void;
  const readGate = new Promise<void>((resolve) => {
    releaseRead = resolve;
  });
  let deferRead = true;
  const audit = await setup(page, {
    handleSales: async (route) => {
      if (route.request().method() === "OPTIONS") return json(route, {});
      if (route.request().method() === "GET") {
        if (deferRead) await readGate;
        return json(route, { report: emptyReport });
      }
      if (route.request().method() === "POST")
        return json(route, { code: "SALES_OPERATION_UNAVAILABLE" }, 503);
      audit.forbidden.push(route.request().method());
      return route.abort();
    },
  });
  await openSales(page);
  audit.allowActualSales = true;
  await page
    .getByRole("button", {
      name: "실제 운영 열기 · 실제 매출·일마감 열기",
      exact: true,
    })
    .click();
  await page.getByLabel("영업일 (한국 시간)", { exact: true }).fill(DAY);
  await page.getByRole("button", { name: "장부 조회", exact: true }).click();
  const leave = page.getByRole("button", {
    name: "모드 선택으로 돌아가기",
    exact: true,
  });
  await expect
    .poll(() => audit.salesRequests.some((value) => value.startsWith("GET ")))
    .toBe(true);
  await expect(leave).toBeDisabled();
  await leave.evaluate((button) => (button as HTMLButtonElement).click());
  await expect(
    page.getByRole("heading", { name: "매출·일마감 관리", exact: true }),
  ).toBeVisible();
  deferRead = false;
  releaseRead();
  await expect(leave).toBeEnabled();
  await page.evaluate((pendingKey) => {
    const originalSet = Storage.prototype.setItem;
    Storage.prototype.setItem = function (key, value) {
      if (key === pendingKey) throw new Error("synthetic blocked pending storage");
      return originalSet.call(this, key, value);
    };
  }, PENDING_KEY);
  await page.getByRole("button", { name: "판매 등록 · 새 전표", exact: true }).click();
  await page.getByLabel("판매일시 (한국 시간)", { exact: true }).fill(`${DAY}T09:00`);
  await page.getByLabel("전표 참조번호", { exact: true }).fill("TEST_MEMORY_PENDING");
  await page.getByLabel("전표 금액", { exact: true }).fill("10000");
  await page.getByRole("button", { name: "초안 저장", exact: true }).click();
  await expect(
    page.getByRole("button", { name: "같은 요청 재시도", exact: true }),
  ).toBeVisible();
  expect(
    await page.evaluate((key) => sessionStorage.getItem(key), PENDING_KEY),
  ).toBeNull();
  await expect(leave).toBeDisabled();
  await selectMenu(page, "홈(운영현황)");
  await openSales(page);
  await expect(
    page.getByRole("button", { name: "같은 요청 재시도", exact: true }),
  ).toBeVisible();
  await expect(leave).toBeDisabled();
  await leave.evaluate((button) => (button as HTMLButtonElement).click());
  await expect(
    page.getByRole("button", { name: "같은 요청 재시도", exact: true }),
  ).toBeVisible();
});

test("logout removes the synthetic session and all simulation controls", async ({
  page,
}) => {
  const audit = await setup(page, { accountLogout: true });
  await openSales(page);
  await startSimulation(page, audit);
  await postSample(page, "카드");
  audit.simulation = false;
  await page.goto("/account");
  await page.getByRole("button", { name: "로그아웃", exact: true }).click();
  await page.waitForURL(`${ORIGIN}/`);
  await page.goto("/admin");
  await expect(
    page.getByRole("heading", { name: "매출·일마감 모드 선택", exact: true }),
  ).toHaveCount(0);
  await expect(
    page.getByRole("heading", { name: "모의 매출·일마감 체험", exact: true }),
  ).toHaveCount(0);
  expect(
    await page.evaluate(() => sessionStorage.getItem("paradays.auth.session")),
  ).toBeNull();
});
