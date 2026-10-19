import { expect, test, type Page, type Route } from "@playwright/test";

const ORIGIN = "http://127.0.0.1:3139";
const API = "https://api.sales.test/prod/";
const SUBJECT = "sales-simulation-synthetic-admin";
const DAY = "2026-10-15";
const PENDING_KEY = `paradays.admin-sales.pending.${SUBJECT}`;
const pendingAttempt = JSON.stringify({
  day: DAY,
  command: {
    action: "save",
    entryId: "sale_synthetic_pending",
    expectedVersion: 0,
    soldAt: `${DAY}T01:00:00.000Z`,
    method: "CARD",
    reference: "TEST_PENDING_001",
    amount: 10_000,
    memo: "Synthetic unresolved fixture",
    lines: [],
  },
});
const emptyReport = {
  businessDay: DAY,
  timezone: "Asia/Seoul",
  version: 1,
  status: "OPEN",
  asOf: `${DAY}T14:00:00.000Z`,
  entries: [],
  onlineEvents: [],
  totals: {
    card: 0,
    cash: 0,
    offlineRefunds: 0,
    offlineNet: 0,
    onlineGross: 0,
    onlineRefunds: 0,
    onlineNet: 0,
    combinedNet: 0,
  },
  warnings: [],
  onlineFingerprint: "a".repeat(64),
  snapshots: [],
  history: [],
  complete: true,
};
const token = (sub: string, groups: readonly string[]) =>
  [
    Buffer.from(JSON.stringify({ alg: "none", typ: "JWT" })).toString("base64url"),
    Buffer.from(
      JSON.stringify({ sub, exp: 4102444800, "cognito:groups": groups }),
    ).toString("base64url"),
    "test-only-signature",
  ].join(".");
type Audit = {
  forbidden: string[];
  unexpected: string[];
  simulationRequests: string[];
  salesRequests: string[];
  simulation: boolean;
  allowActualSales: boolean;
};
const audits = new WeakMap<Page, Audit>();

function json(route: Route, body: unknown, status = 200) {
  return route.fulfill({
    status,
    json: body,
    headers: {
      "access-control-allow-origin": "*",
      "access-control-allow-methods": "GET,POST,OPTIONS",
      "access-control-allow-headers": "authorization,content-type",
    },
  });
}

async function setup(
  page: Page,
  options: {
    groups?: readonly string[];
    anonymous?: boolean;
    pending?: string;
    accountLogout?: boolean;
    handleSales?: (route: Route) => Promise<void>;
  } = {},
) {
  const groups = options.groups ?? ["admin"];
  const audit: Audit = {
    forbidden: [],
    unexpected: [],
    simulationRequests: [],
    salesRequests: [],
    simulation: false,
    allowActualSales: false,
  };
  audits.set(page, audit);
  await page.route("**/*", async (route) => {
    const request = route.request();
    const url = new URL(request.url());
    const description = `${request.method()} ${url.origin}${url.pathname}`;
    if (url.origin === ORIGIN) {
      if (request.method() === "GET" || request.method() === "HEAD")
        return route.continue();
      audit.unexpected.push(description);
      return route.abort();
    }
    if (url.origin === "https://auth.sales.test" && url.pathname === "/logout")
      return route.fulfill({ status: 302, headers: { location: `${ORIGIN}/` } });
    if (!request.url().startsWith(API)) {
      audit.unexpected.push(description);
      return route.abort();
    }
    if (audit.simulation) audit.simulationRequests.push(description);
    if (
      options.accountLogout &&
      !audit.simulation &&
      url.pathname === "/prod/orders" &&
      ["GET", "OPTIONS"].includes(request.method())
    )
      return json(route, { orders: [] });
    if (
      /\/(admin\/orders|orders|checkout|payments)(\/|$)/.test(url.pathname) ||
      (url.pathname.includes("/catalog/") &&
        !["GET", "OPTIONS"].includes(request.method()))
    ) {
      audit.forbidden.push(description);
      return route.abort();
    }
    if (url.pathname.startsWith("/prod/admin/sales/")) {
      audit.salesRequests.push(description);
      if (!audit.allowActualSales || audit.simulation) {
        audit.forbidden.push(description);
        return route.abort();
      }
      if (options.handleSales) return options.handleSales(route);
      audit.forbidden.push(description);
      return route.abort();
    }
    if (!["GET", "OPTIONS"].includes(request.method())) {
      audit.forbidden.push(description);
      return route.abort();
    }
    if (request.method() === "OPTIONS") return json(route, {});
    if (url.pathname === "/prod/me")
      return json(route, { userSub: SUBJECT, marketingConsent: false });
    if (url.pathname === "/prod/admin/overview")
      return json(route, {
        asOf: "2026-10-15T14:00:00.000Z",
        timezone: "Asia/Seoul",
        todayOrderCount: 0,
        lowStockCount: 0,
        lowStockThreshold: 3,
        activeCouponCount: 0,
        marketingConsentCount: 0,
      });
    if (
      url.pathname === "/prod/admin/catalog/products" ||
      url.pathname === "/prod/catalog/products"
    )
      return json(route, { products: [] });
    audit.unexpected.push(description);
    return route.abort();
  });
  await page.addInitScript(
    ({ session, anonymous, pending, pendingKey }) => {
      if (!sessionStorage.getItem("synthetic_sales_bootstrapped")) {
        if (!anonymous)
          sessionStorage.setItem("paradays.auth.session", JSON.stringify(session));
        if (pending) sessionStorage.setItem(pendingKey, pending);
        sessionStorage.setItem("synthetic_sales_bootstrapped", "yes");
      }
      localStorage.setItem("paradays-locale", "ko");
    },
    {
      session: {
        accessToken: token(SUBJECT, groups),
        expiresAt: 4102444800000,
        user: { sub: SUBJECT, username: "synthetic-admin", groups },
      },
      anonymous: options.anonymous ?? false,
      pending: options.pending,
      pendingKey: PENDING_KEY,
    },
  );
  await page.clock.setFixedTime(new Date("2026-10-15T14:00:00.000Z"));
  await page.goto("/admin");
  await page.waitForLoadState("networkidle");
  return audit;
}

async function selectMenu(page: Page, name: string) {
  const tab = page.getByRole("tab", { name, exact: true, includeHidden: true });
  await expect(tab).toBeAttached();
  if (await page.evaluate(() => matchMedia("(min-width: 1024px)").matches))
    await expect(tab).toBeVisible();
  else if (!(await tab.isVisible()))
    await page.getByRole("button", { name: "운영 메뉴 열기", exact: true }).click();
  await tab.click();
}

async function openSales(page: Page) {
  await selectMenu(page, "매출·일마감");
}

async function snapshotStorage(page: Page) {
  return page.evaluate(() => {
    const read = (storage: Storage) =>
      Array.from({ length: storage.length }, (_, index) => storage.key(index)!)
        .sort()
        .map((key) => [key, storage.getItem(key)]);
    return { local: read(localStorage), session: read(sessionStorage) };
  });
}

async function trackStorageWrites(page: Page) {
  await page.evaluate(() => {
    const state = window as unknown as { simulationStorageWrites: string[] };
    state.simulationStorageWrites = [];
    const originalSet = Storage.prototype.setItem;
    const originalRemove = Storage.prototype.removeItem;
    const originalClear = Storage.prototype.clear;
    Storage.prototype.setItem = function (key, value) {
      state.simulationStorageWrites.push(`set:${key}`);
      return originalSet.call(this, key, value);
    };
    Storage.prototype.removeItem = function (key) {
      state.simulationStorageWrites.push(`remove:${key}`);
      return originalRemove.call(this, key);
    };
    Storage.prototype.clear = function () {
      state.simulationStorageWrites.push("clear");
      return originalClear.call(this);
    };
  });
}

async function expectNoStorageWrites(page: Page) {
  expect(
    await page.evaluate(
      () =>
        (window as unknown as { simulationStorageWrites: string[] })
          .simulationStorageWrites,
    ),
  ).toEqual([]);
}

async function startSimulation(page: Page, audit: Audit) {
  await expect(
    page.getByRole("heading", { name: "매출·일마감 모드 선택", exact: true }),
  ).toBeVisible();
  const start = page.getByRole("button", {
    name: "모의 매출·일마감 체험",
    exact: true,
  });
  await expect(start).toBeDisabled();
  await expect(
    page.getByRole("button", { name: "장부 조회", exact: true }),
  ).toHaveCount(0);
  await page
    .getByLabel("실제 장부와 재고를 바꾸지 않는 모의 체험임을 확인했습니다", {
      exact: true,
    })
    .check();
  audit.simulation = true;
  await start.click();
  await expect(
    page.getByRole("heading", { name: "모의 매출·일마감 체험", exact: true }),
  ).toBeVisible();
  await expect(
    page.getByRole("heading", { name: "매출·일마감 관리", exact: true }),
  ).toHaveCount(0);
}

async function expectStock(page: Page, deck: number, grip: number) {
  await expect(page.getByLabel("가상 데크 재고", { exact: true })).toHaveText(
    `${deck}개`,
  );
  await expect(page.getByLabel("가상 그립 재고", { exact: true })).toHaveText(
    `${grip}개`,
  );
}

async function postSample(page: Page, method: "카드" | "현금") {
  await page
    .getByRole("button", { name: `${method} 예시 불러오기`, exact: true })
    .click();
  await page.getByRole("button", { name: "모의 초안 저장", exact: true }).click();
  await page
    .getByRole("button", { name: "가상 재고 예정표 확인", exact: true })
    .click();
  const confirm = page.getByRole("button", { name: "모의 판매 확정", exact: true });
  await expect(confirm).toBeDisabled();
  await page
    .getByLabel("예정표의 가상 재고 차감을 확인했습니다", { exact: true })
    .check();
  await confirm.evaluate((button) => {
    (button as HTMLButtonElement).click();
    (button as HTMLButtonElement).click();
  });
}

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
