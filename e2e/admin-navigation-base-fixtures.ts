import { expect, type Page, type Route } from "@playwright/test";

const ORIGIN = "http://127.0.0.1:3139";

const API = "https://api.sales.test/prod/";

const SUBJECT = "history-synthetic-admin";

const DAY = "2026-10-15";

const PENDING_KEY = `paradays.admin-sales.pending.${SUBJECT}`;

const pending = JSON.stringify({
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

const sections = [
  ["overview", "홈(운영현황)"],
  ["products", "상품 등록"],
  ["inventory", "재고 수정"],
  ["sales", "매출·일마감"],
  ["brands", "브랜드"],
  ["members", "회원"],
  ["coupons", "쿠폰"],
  ["marketing", "마케팅"],
  ["ocr", "입고 OCR"],
] as const;

type Audit = { blocked: string[]; reads: string[]; syntheticWrites: string[] };

const audits = new WeakMap<Page, Audit>();

const products = ["A", "B"].map((suffix) => ({
  productId: `prd_synthetic_${suffix}`,
  name: `[TEST] History product ${suffix}`,
  brandName: "TEST",
  category: "Deck",
  price: 10_000,
  inventoryQuantity: 10,
  status: "DRAFT",
  featured: false,
  version: 1,
  description: [`Synthetic product ${suffix}`],
  sizes: ["TEST"],
}));

const returnProduct = {
  id: "prd_redesign_return",
  slug: "synthetic-redesign-deck",
  name: "[TEST] Redesign return deck",
  brand: "TEST",
  category: "Deck",
  price: 10_000,
  inventoryQuantity: 10,
  image: "/images/product-placeholder.svg",
  description: ["Synthetic redesign round-trip fixture"],
  sizes: ["TEST"],
};

function respond(route: Route, body: unknown, status = 200) {
  return route.fulfill({
    status,
    json: body,
    headers: {
      "access-control-allow-origin": "*",
      "access-control-allow-methods": "GET,OPTIONS,POST,PATCH,DELETE",
      "access-control-allow-headers": "authorization,content-type",
    },
  });
}

async function setup(
  page: Page,
  options: {
    path?: string;
    groups?: readonly string[];
    anonymous?: boolean;
    pending?: boolean;
    products?: boolean;
    catalogProducts?: readonly Record<string, unknown>[];
    handleCatalog?: (route: Route) => Promise<void>;
    productImageFixture?: boolean;
    storefrontProduct?: boolean;
    handleOverview?: (route: Route) => Promise<void>;
    waitForIdle?: boolean;
    handleSales?: (route: Route) => Promise<void>;
    handleBrandMutation?: (route: Route) => Promise<void>;
    handleCouponMutation?: (route: Route) => Promise<void>;
    handleCampaignMutation?: (route: Route) => Promise<void>;
    handleMembers?: (route: Route) => Promise<void>;
    handleMemberMutation?: (route: Route) => Promise<void>;
    handleProductMutation?: (route: Route) => Promise<void>;
  } = {},
) {
  const audit: Audit = { blocked: [], reads: [], syntheticWrites: [] };
  audits.set(page, audit);
  await page.route("**/*", async (route) => {
    const request = route.request();
    const url = new URL(request.url());
    const description = `${request.method()} ${url.origin}${url.pathname}`;
    if (url.origin === ORIGIN && ["GET", "HEAD"].includes(request.method()))
      return route.continue();
    if (url.origin === "https://auth.sales.test" && url.pathname === "/logout")
      return route.fulfill({ status: 302, headers: { location: `${ORIGIN}/` } });
    if (
      options.handleCampaignMutation &&
      url.origin === "https://api.sales.test" &&
      url.pathname === "/prod/admin/campaigns" &&
      request.method() === "POST"
    ) {
      audit.syntheticWrites.push(description);
      return options.handleCampaignMutation(route);
    }
    if (
      options.handleCouponMutation &&
      url.origin === "https://api.sales.test" &&
      url.pathname === "/prod/admin/coupons" &&
      request.method() === "POST"
    ) {
      audit.syntheticWrites.push(description);
      return options.handleCouponMutation(route);
    }
    if (
      options.handleMemberMutation &&
      url.origin === "https://api.sales.test" &&
      /^\/prod\/admin\/members\/(?:synthetic-admin|member%2Balex%40example\.test|synthetic-support)\/groups$/.test(
        url.pathname,
      ) &&
      ["POST", "DELETE"].includes(request.method())
    ) {
      audit.syntheticWrites.push(description);
      return options.handleMemberMutation(route);
    }
    if (
      options.handleBrandMutation &&
      url.origin === "https://api.sales.test" &&
      url.pathname === "/prod/admin/brands" &&
      request.method() === "POST"
    ) {
      audit.syntheticWrites.push(description);
      return options.handleBrandMutation(route);
    }
    if (
      options.handleProductMutation &&
      request.method() === "GET" &&
      url.origin === "https://api.mymemory.translated.net" &&
      url.pathname === "/get"
    )
      return respond(route, {
        responseData: { translatedText: url.searchParams.get("q") },
      });
    if (
      options.handleProductMutation &&
      url.origin === "https://api.sales.test" &&
      /^\/prod\/admin\/catalog\/products(?:\/prd_synthetic_[AB])?$/.test(
        url.pathname,
      ) &&
      ["POST", "PATCH", "DELETE"].includes(request.method())
    ) {
      audit.syntheticWrites.push(description);
      return options.handleProductMutation(route);
    }
    if (
      options.productImageFixture &&
      url.origin === "https://api.sales.test" &&
      url.pathname === "/prod/admin/catalog/uploads" &&
      request.method() === "POST"
    ) {
      audit.syntheticWrites.push(description);
      return respond(route, {
        uploadUrl: "https://upload.redesign.test/image",
        publicUrl: "https://cdn.redesign.test/product.png",
      });
    }
    if (
      options.productImageFixture &&
      url.origin === "https://upload.redesign.test" &&
      url.pathname === "/image" &&
      request.method() === "PUT"
    ) {
      audit.syntheticWrites.push(description);
      return route.fulfill({ status: 200, body: "" });
    }
    if (
      options.productImageFixture &&
      url.origin === "https://cdn.redesign.test" &&
      url.pathname === "/product.png" &&
      request.method() === "GET"
    )
      return route.fulfill({
        status: 200,
        contentType: "image/png",
        body: Buffer.from(
          "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aRfsAAAAASUVORK5CYII=",
          "base64",
        ),
      });
    if (
      !request.url().startsWith(API) ||
      !["GET", "OPTIONS"].includes(request.method())
    ) {
      audit.blocked.push(description);
      return route.abort();
    }
    if (request.method() === "OPTIONS") return respond(route, {});
    audit.reads.push(url.pathname);
    if (url.pathname.startsWith("/prod/admin/sales/") && options.handleSales)
      return options.handleSales(route);
    if (url.pathname === "/prod/me")
      return respond(route, { userSub: SUBJECT, marketingConsent: false });
    if (url.pathname === "/prod/admin/members" && options.handleMembers)
      return options.handleMembers(route);
    if (url.pathname === "/prod/orders") return respond(route, { orders: [] });
    if (url.pathname === "/prod/admin/overview" && options.handleOverview)
      return options.handleOverview(route);
    if (url.pathname === "/prod/admin/overview")
      return respond(route, {
        asOf: `${DAY}T14:00:00.000Z`,
        timezone: "Asia/Seoul",
        todayOrderCount: 0,
        lowStockCount: 0,
        lowStockThreshold: 3,
        activeCouponCount: 0,
        marketingConsentCount: 0,
      });
    if (url.pathname === "/prod/catalog/products" && options.storefrontProduct)
      return url.searchParams.has("slug")
        ? respond(route, { product: returnProduct })
        : respond(route, { products: [returnProduct] });
    if (url.pathname === "/prod/admin/catalog/products" && options.handleCatalog)
      return options.handleCatalog(route);
    if (
      ["/prod/admin/catalog/products", "/prod/catalog/products"].includes(url.pathname)
    )
      return respond(route, {
        products: options.catalogProducts ?? (options.products ? products : []),
      });
    audit.blocked.push(description);
    return route.abort();
  });
  const groups = options.groups ?? ["admin"];
  const accessToken = [
    Buffer.from(JSON.stringify({ alg: "none", typ: "JWT" })).toString("base64url"),
    Buffer.from(
      JSON.stringify({ sub: SUBJECT, exp: 4102444800, "cognito:groups": groups }),
    ).toString("base64url"),
    "test-only-signature",
  ].join(".");
  await page.addInitScript(
    ({ session, anonymous, pendingValue, pendingKey }) => {
      if (!sessionStorage.getItem("synthetic_history_bootstrapped")) {
        if (!anonymous)
          sessionStorage.setItem("paradays.auth.session", JSON.stringify(session));
        if (pendingValue) sessionStorage.setItem(pendingKey, pendingValue);
        sessionStorage.setItem("synthetic_history_bootstrapped", "yes");
      }
      localStorage.setItem("paradays-locale", "ko");
    },
    {
      session: {
        accessToken,
        expiresAt: 4102444800000,
        user: { sub: SUBJECT, username: "synthetic-admin", groups },
      },
      anonymous: options.anonymous ?? false,
      pendingValue: options.pending ? pending : null,
      pendingKey: PENDING_KEY,
    },
  );
  await page.clock.setFixedTime(new Date(`${DAY}T14:00:00.000Z`));
  await page.goto(options.path ?? "/admin");
  if (options.waitForIdle !== false) await page.waitForLoadState("networkidle");
  return audit;
}

async function select(page: Page, id: (typeof sections)[number][0]) {
  const item = sections.find(([section]) => section === id)!;
  const tab = page.getByRole("tab", { name: item[1], exact: true });
  if (!(await tab.isVisible()))
    await page.getByRole("button", { name: "운영 메뉴 열기", exact: true }).click();
  await tab.click();
  await active(page, id);
}

async function active(page: Page, id: string) {
  await expect(page.locator(`#admin-panel-${id}`)).toBeVisible();
  await expect(page.locator(`#admin-tab-${id}`)).toHaveAttribute(
    "aria-selected",
    "true",
  );
  expect(new URL(page.url()).pathname).toBe("/admin");
}

async function startMock(page: Page) {
  await page
    .getByLabel("실제 장부와 재고를 바꾸지 않는 모의 체험임을 확인했습니다", {
      exact: true,
    })
    .check();
  await page
    .getByRole("button", { name: "모의 매출·일마감 체험", exact: true })
    .click();
  await expect(page.getByLabel("가상 데크 재고", { exact: true })).toHaveText("10개");
}

export {
  active,
  type Audit,
  audits,
  DAY,
  emptyReport,
  ORIGIN,
  pending,
  PENDING_KEY,
  products,
  respond,
  returnProduct,
  sections,
  select,
  setup,
  startMock,
  SUBJECT,
};
