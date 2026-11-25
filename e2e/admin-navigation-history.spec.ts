import { expect, test } from "@playwright/test";
import {
  active,
  audits,
  emptyReport,
  ORIGIN,
  pending,
  PENDING_KEY,
  respond,
  sections,
  select,
  setup,
  startMock,
} from "./admin-navigation-base-fixtures";

test.afterEach(async ({ page }) => {
  expect(audits.get(page)?.blocked ?? []).toEqual([]);
});

test("shop to overview to inventory: Back restores overview before leaving admin and Forward restores inventory", async ({
  page,
}) => {
  await setup(page, { path: "/" });
  await page.getByRole("link", { name: "관리자페이지", exact: true }).click();
  await active(page, "overview");
  await select(page, "inventory");
  await expect(page).toHaveURL(`${ORIGIN}/admin?section=inventory`);
  await page.goBack();
  await active(page, "overview");
  await page.goForward();
  await active(page, "inventory");
  await page.goBack();
  await active(page, "overview");
  await page.goBack();
  await expect(page).toHaveURL(`${ORIGIN}/`);
  await page.goForward();
  await active(page, "overview");
  await page.goForward();
  await active(page, "inventory");
});

test("all nine menu states follow history; repeated same selection creates no extra entry", async ({
  page,
}) => {
  await setup(page);
  const initialLength = await page.evaluate(() => history.length);
  for (const [id] of sections.slice(1)) {
    await select(page, id);
    const length = await page.evaluate(() => history.length);
    await select(page, id);
    expect(await page.evaluate(() => history.length)).toBe(length);
  }
  expect(await page.evaluate(() => history.length)).toBe(initialLength + 8);
  for (const [id] of [...sections.slice(0, -1)].reverse()) {
    await page.goBack();
    await active(page, id);
  }
  for (const [id] of sections.slice(1)) {
    await page.goForward();
    await active(page, id);
  }
});

test("direct section URLs and reload restore the requested section; malformed sections safely show overview", async ({
  page,
}) => {
  await setup(page, { path: "/admin?section=inventory" });
  await active(page, "inventory");
  await page.reload();
  await active(page, "inventory");
  for (const query of [
    "section=invalid",
    "section=",
    "section=inventory&section=members",
    "section=%3Cscript%3E",
  ]) {
    await page.goto(`/admin?${query}`);
    await active(page, "overview");
    const length = await page.evaluate(() => history.length);
    await select(page, "overview");
    expect(await page.evaluate(() => history.length)).toBe(length);
    expect(new URL(page.url()).searchParams.has("section")).toBe(false);
  }
});

test("other search parameters and hash survive menu changes, keyboard navigation and Back", async ({
  page,
}) => {
  await setup(page, { path: "/admin?keep=one&keep=two#navigation-marker" });
  await select(page, "inventory");
  let url = new URL(page.url());
  expect(url.searchParams.getAll("keep")).toEqual(["one", "two"]);
  expect(url.hash).toBe("#navigation-marker");
  const inventory = page.getByRole("tab", { name: "재고 수정", exact: true });
  if (!(await inventory.isVisible()))
    await page.getByRole("button", { name: "운영 메뉴 열기", exact: true }).click();
  await inventory.focus();
  await inventory.press("ArrowDown");
  await active(page, "sales");
  await page.goBack();
  await active(page, "inventory");
  await select(page, "overview");
  url = new URL(page.url());
  expect(url.searchParams.has("section")).toBe(false);
  expect(url.searchParams.getAll("keep")).toEqual(["one", "two"]);
  expect(url.hash).toBe("#navigation-marker");
});

test("member and anonymous deep links cannot mount the navigation workspace", async ({
  page,
}) => {
  await setup(page, { path: "/admin?section=inventory", groups: [] });
  await expect(
    page.getByRole("heading", { name: "관리자 권한이 없습니다", exact: true }),
  ).toBeVisible();
  await expect(page.locator("#admin-panel-inventory")).toHaveCount(0);
  await page.evaluate(() => {
    sessionStorage.removeItem("paradays.auth.session");
    localStorage.removeItem("paradays.auth.session");
  });
  await page.goto("/admin?section=sales&keep=login#return-target");
  await expect(
    page.getByRole("heading", { name: "관리자 로그인이 필요합니다", exact: true }),
  ).toBeVisible();
  await expect(page.locator("#admin-panel-sales")).toHaveCount(0);
  await page.getByRole("link", { name: "관리자 로그인", exact: true }).click();
  await expect(page).toHaveURL(`${ORIGIN}/login`);
  expect(
    await page.evaluate(() => sessionStorage.getItem("paradays-auth-return-to")),
  ).toBe("/admin?section=sales&keep=login#return-target");
});

test("Back and Forward preserve mock memory within admin; reload discards it without sales requests", async ({
  page,
}) => {
  const audit = await setup(page);
  await select(page, "sales");
  await startMock(page);
  await page.getByRole("button", { name: "카드 예시 불러오기", exact: true }).click();
  await page.getByRole("button", { name: "모의 초안 저장", exact: true }).click();
  await page
    .getByRole("button", { name: "가상 재고 예정표 확인", exact: true })
    .click();
  await page
    .getByLabel("예정표의 가상 재고 차감을 확인했습니다", { exact: true })
    .check();
  await page.getByRole("button", { name: "모의 판매 확정", exact: true }).click();
  await expect(page.getByLabel("가상 데크 재고", { exact: true })).toHaveText("8개");
  await select(page, "brands");
  await page.goBack();
  await active(page, "sales");
  await expect(page.getByLabel("가상 데크 재고", { exact: true })).toHaveText("8개");
  await page.goForward();
  await active(page, "brands");
  await page.goBack();
  await active(page, "sales");
  await page.reload();
  await active(page, "sales");
  await expect(
    page.getByRole("heading", { name: "매출·일마감 모드 선택", exact: true }),
  ).toBeVisible();
  await startMock(page);
  expect(audit.reads.filter((url) => url.startsWith("/prod/admin/sales/"))).toEqual([]);
});

test("history navigation keeps unresolved real attempts byte-for-byte and does not retry them", async ({
  page,
}) => {
  const audit = await setup(page, { pending: true });
  await select(page, "sales");
  await page
    .getByRole("button", {
      name: "실제 운영 열기 · 실제 매출·일마감 열기",
      exact: true,
    })
    .click();
  await expect(
    page.getByRole("button", { name: "같은 요청 재시도", exact: true }),
  ).toBeVisible();
  await select(page, "brands");
  await page.goBack();
  await active(page, "sales");
  await expect(
    page.getByRole("button", { name: "같은 요청 재시도", exact: true }),
  ).toBeVisible();
  await expect(
    page.getByRole("button", { name: "모드 선택으로 돌아가기", exact: true }),
  ).toBeDisabled();
  expect(await page.evaluate((key) => sessionStorage.getItem(key), PENDING_KEY)).toBe(
    pending,
  );
  expect(audit.reads.filter((url) => url.startsWith("/prod/admin/sales/"))).toEqual([]);
});

test("synthetic logout prevents history deep links from reopening admin or mock data", async ({
  page,
}) => {
  await setup(page, { path: "/admin?section=sales" });
  await active(page, "sales");
  await startMock(page);
  await page.goto("/account");
  await page.getByRole("button", { name: "로그아웃", exact: true }).click();
  await page.waitForURL(`${ORIGIN}/`);
  await page.goto("/admin?section=sales");
  await expect(
    page.getByRole("heading", { name: "관리자 로그인이 필요합니다", exact: true }),
  ).toBeVisible();
  await expect(
    page.getByRole("heading", { name: "모의 매출·일마감 체험", exact: true }),
  ).toHaveCount(0);
});

test("an in-flight actual read stays mounted and locked across history navigation without duplicate requests", async ({
  page,
}) => {
  let release!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const audit = await setup(page, {
    handleSales: async (route) => {
      await gate;
      await respond(route, { report: emptyReport });
    },
  });
  await select(page, "sales");
  await page
    .getByRole("button", {
      name: "실제 운영 열기 · 실제 매출·일마감 열기",
      exact: true,
    })
    .click();
  await page.getByRole("button", { name: "장부 조회", exact: true }).click();
  const leave = page.getByRole("button", {
    name: "모드 선택으로 돌아가기",
    exact: true,
  });
  await expect(leave).toBeDisabled();
  await select(page, "brands");
  await page.goBack();
  await active(page, "sales");
  await expect(leave).toBeDisabled();
  expect(
    audit.reads.filter((url) => url.startsWith("/prod/admin/sales/")),
  ).toHaveLength(1);
  release();
  await expect(leave).toBeEnabled();
  await expect(
    page.getByRole("heading", { name: "매출·일마감 관리", exact: true }),
  ).toBeVisible();
});

test("mobile menu navigation closes the drawer and Back restores the visible section", async ({
  page,
}) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await setup(page);
  await select(page, "inventory");
  await expect(
    page.getByRole("button", { name: "운영 메뉴 열기", exact: true }),
  ).toHaveAttribute("aria-expanded", "false");
  await page.goBack();
  await active(page, "overview");
  await page.goForward();
  await active(page, "inventory");
  expect(
    await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth),
  ).toBe(true);
});
