import { expect, type Page, type Route } from "@playwright/test";

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

async function postSample(page: Page, method: "카드" | "현금" | "이체") {
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

export {
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
  DAY,
  PENDING_KEY,
  pendingAttempt,
  emptyReport,
  json,
};
