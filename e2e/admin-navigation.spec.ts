import { expect, test, type Page, type Route } from "@playwright/test";

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

test("product list/create history restores the same private draft and file without persisting them in URL, history or storage", async ({
  page,
}) => {
  await setup(page, { products: true });
  await select(page, "products");
  await page.getByRole("button", { name: "새 상품 등록", exact: true }).click();
  const draftName = "UNSAVED_PRIVATE_HISTORY_DRAFT";
  await page.getByRole("textbox", { name: "상품명", exact: false }).fill(draftName);
  await page.getByLabel("대표 이미지", { exact: false }).setInputFiles({
    name: "synthetic-private-upload.png",
    mimeType: "image/png",
    buffer: Buffer.from(
      "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aRfsAAAAASUVORK5CYII=",
      "base64",
    ),
  });
  const editorUrl = page.url();
  const editor = new URL(editorUrl).searchParams.get("editor");
  expect(editor).toMatch(
    /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i,
  );
  const privateSurface = await page.evaluate(() =>
    JSON.stringify({
      href: location.href,
      history: history.state,
      session: { ...sessionStorage },
      local: { ...localStorage },
    }),
  );
  expect(privateSurface).not.toContain(draftName);
  expect(privateSurface).not.toContain("synthetic-private-upload.png");
  expect(privateSurface).not.toContain("blob:");
  await page.goBack();
  await expect(
    page.getByRole("button", { name: "새 상품 등록", exact: true }),
  ).toBeVisible();
  await page.goForward();
  await expect(page).toHaveURL(editorUrl);
  await expect(page.getByRole("textbox", { name: "상품명", exact: false })).toHaveValue(
    draftName,
  );
  await expect(
    page.getByAltText(`${draftName} 상품 이미지 미리보기`, { exact: true }),
  ).toHaveAttribute("src", /^blob:/);
  await page.getByRole("button", { name: "← 목록으로", exact: true }).click();
  await expect(
    page.getByRole("button", { name: "새 상품 등록", exact: true }),
  ).toBeVisible();
  await page.evaluate((url) => {
    history.pushState(null, "", url);
    dispatchEvent(new PopStateEvent("popstate"));
  }, editorUrl);
  await expect(
    page.getByRole("button", { name: "새 상품 등록", exact: true }),
  ).toBeVisible();
  await expect(page.getByRole("textbox", { name: "상품명", exact: false })).toHaveCount(
    0,
  );
});

test("separate product editors restore A and B independently across Back and Forward", async ({
  page,
}) => {
  await setup(page, { products: true });
  await select(page, "products");
  await page
    .getByRole("listitem")
    .filter({ hasText: products[0]!.name })
    .getByRole("button", { name: "수정", exact: true })
    .click();
  await page
    .getByRole("textbox", { name: "상품명", exact: false })
    .fill("PRIVATE_EDIT_A");
  const editorA = page.url();
  await select(page, "brands");
  await select(page, "products");
  await page
    .getByRole("listitem")
    .filter({ hasText: products[1]!.name })
    .getByRole("button", { name: "수정", exact: true })
    .click();
  await page
    .getByRole("textbox", { name: "상품명", exact: false })
    .fill("PRIVATE_EDIT_B");
  const editorB = page.url();
  expect(editorB).not.toBe(editorA);
  await page.goBack();
  await expect(
    page.getByRole("button", { name: "새 상품 등록", exact: true }),
  ).toBeVisible();
  await page.goBack();
  await active(page, "brands");
  await page.goBack();
  await expect(page).toHaveURL(editorA);
  await expect(page.getByRole("textbox", { name: "상품명", exact: false })).toHaveValue(
    "PRIVATE_EDIT_A",
  );
  await page.goForward();
  await active(page, "brands");
  await page.goForward();
  await expect(
    page.getByRole("button", { name: "새 상품 등록", exact: true }),
  ).toBeVisible();
  await page.goForward();
  await expect(page).toHaveURL(editorB);
  await expect(page.getByRole("textbox", { name: "상품명", exact: false })).toHaveValue(
    "PRIVATE_EDIT_B",
  );
});

test("reload and direct or invalid editor identities fall back to product list without selecting a different product", async ({
  page,
}) => {
  await setup(page, { products: true });
  await select(page, "products");
  await page
    .getByRole("listitem")
    .filter({ hasText: products[0]!.name })
    .getByRole("button", { name: "수정", exact: true })
    .click();
  const editorUrl = page.url();
  await page.reload();
  await active(page, "products");
  await expect(
    page.getByRole("button", { name: "새 상품 등록", exact: true }),
  ).toBeVisible();
  for (const url of [
    editorUrl,
    "/admin?section=products&editor=invalid",
    "/admin?section=products&editor=11111111-1111-4111-8111-111111111111",
  ]) {
    await page.goto(url);
    await active(page, "products");
    await expect(
      page.getByRole("button", { name: "새 상품 등록", exact: true }),
    ).toBeVisible();
    await expect(
      page.getByRole("textbox", { name: "상품명", exact: false }),
    ).toHaveCount(0);
  }
});

test("a synthetic product save completed after moving away leaves the current menu unchanged and invalidates the old editor", async ({
  page,
}) => {
  let release!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const audit = await setup(page, {
    products: true,
    handleProductMutation: async (route) => {
      await gate;
      await respond(route, {});
    },
  });
  await select(page, "products");
  await page
    .getByRole("listitem")
    .filter({ hasText: products[0]!.name })
    .getByRole("button", { name: "수정", exact: true })
    .click();
  await page.getByRole("button", { name: /^(?:수정 저장|비공개 수정 저장)$/ }).click();
  await expect.poll(() => audit.syntheticWrites.length).toBe(1);
  await select(page, "brands");
  const brandsUrl = page.url();
  release();
  await expect
    .poll(
      () => audit.reads.filter((url) => url === "/prod/admin/catalog/products").length,
    )
    .toBe(2);
  await expect(page).toHaveURL(brandsUrl);
  await active(page, "brands");
  await page.goBack();
  await active(page, "products");
  await expect(
    page.getByRole("button", { name: "새 상품 등록", exact: true }),
  ).toBeVisible();
  expect(audit.syntheticWrites).toEqual([
    "PATCH https://api.sales.test/prod/admin/catalog/products/prd_synthetic_A",
  ]);
});

const completeOverview = {
  asOf: `${DAY}T14:00:00.000Z`,
  timezone: "Asia/Seoul",
  todayOrderCount: 3,
  todayPaidRevenue: 139_000,
  todaySoldItemCount: 5,
  todayNewMemberCount: 2,
  lowStockCount: 4,
  lowStockThreshold: 3,
  activeCouponCount: 7,
  marketingConsentCount: 11,
};

function overviewMetric(page: Page, label: string) {
  return page
    .locator("#admin-panel-overview article")
    .filter({ has: page.getByText(label, { exact: true }) });
}

function expectNoHomePrivateReads(audit: Audit) {
  expect(
    audit.reads.filter((path) =>
      /^\/prod\/(?:admin\/(?:members|sales|orders)(?:\/|$)|orders(?:\/|$))/u.test(path),
    ),
  ).toEqual([]);
}

async function checkHomePrivateCreateHistory(page: Page, audit: Audit) {
  const home = page.url();
  const initialLength = await page.evaluate(() => history.length);
  const create = page.getByRole("button", { name: "새 상품", exact: true });
  await create.focus();
  await create.press("Enter");
  await active(page, "products");
  await expect(
    page.getByRole("heading", { name: "새 상품", exact: true }),
  ).toBeVisible();
  await expect(
    page.getByRole("checkbox", { name: "저장 후 스토어에 공개", exact: true }),
  ).not.toBeChecked();
  await expect(
    page.getByRole("button", { name: "비공개로 저장", exact: true }),
  ).toBeVisible();
  await expect(productPreview(page)).toContainText("아직 고객에게 보이지 않습니다");
  const editorUrl = page.url();
  expect(new URL(editorUrl).searchParams.get("editor")).toMatch(
    /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i,
  );
  // A prior shortcut may leave a Forward entry that this new editor replaces.
  // Back must still return directly to Home, not to a second editor entry.
  expect(await page.evaluate(() => history.length)).toBeLessThanOrEqual(
    initialLength + 1,
  );
  expect(await page.evaluate(() => history.length)).toBeGreaterThanOrEqual(
    initialLength,
  );
  const name = "HOME_CTA_UNSAVED_PRIVATE_DRAFT";
  await page.getByRole("textbox", { name: "상품명", exact: false }).fill(name);
  const persisted = await page.evaluate(() =>
    JSON.stringify({
      href: location.href,
      history: history.state,
      session: { ...sessionStorage },
      local: { ...localStorage },
    }),
  );
  expect(persisted).not.toContain(name);
  await page.goBack();
  await active(page, "overview");
  await expect(page).toHaveURL(home);
  await page.goForward();
  await active(page, "products");
  await expect(page).toHaveURL(editorUrl);
  await expect(page.getByRole("textbox", { name: "상품명", exact: false })).toHaveValue(
    name,
  );
  await expect(
    page.getByRole("checkbox", { name: "저장 후 스토어에 공개", exact: true }),
  ).not.toBeChecked();
  await page.goBack();
  await active(page, "overview");
  expect(audit.syntheticWrites).toEqual([]);
  expectNoHomePrivateReads(audit);
}

test("home redesign: desktop presents three primary metrics and persistent accessible navigation without invented totals", async ({
  page,
}, testInfo) => {
  await page.setViewportSize({ width: 1440, height: 1000 });
  const audit = await setup(page, {
    handleOverview: (route) => respond(route, completeOverview),
  });
  await expect(overviewMetric(page, "오늘 매출").locator("strong")).toHaveText(
    /139,000/,
  );
  await expect(overviewMetric(page, "오늘 주문(건)").locator("strong")).toHaveText(
    /^3(?:건)?$/,
  );
  await expect(overviewMetric(page, "판매 상품 수량(개)").locator("strong")).toHaveText(
    /^5(?:개)?$/,
  );
  await expect(overviewMetric(page, "신규 회원").locator("strong")).toHaveText(
    /^2(?:명)?$/,
  );
  await expect(overviewMetric(page, "등록 쿠폰").locator("strong")).toHaveText("7");
  await expect(overviewMetric(page, "등록 쿠폰")).toContainText("초안 포함");
  await expect(overviewMetric(page, "마케팅 대상").locator("strong")).toHaveText("11");
  await expect(overviewMetric(page, "오늘 매출")).toContainText("온라인 결제완료");
  await expect(
    page.getByRole("heading", { name: "운영 현황", exact: true }),
  ).toBeVisible();
  await expect(page.getByText("집계 기준", { exact: false }).first()).toContainText(
    "KST",
  );
  for (const [, label] of sections) {
    const tab = page.getByRole("tab", { name: label, exact: true });
    await expect(tab).toBeVisible();
    const size = await tab.boundingBox();
    expect(size!.height).toBeGreaterThanOrEqual(44);
  }
  await expect(
    page.getByRole("button", { name: "운영 메뉴 열기", exact: true }),
  ).not.toBeVisible();
  await expect(
    page.getByRole("heading", { name: "운영 바로가기", exact: true }),
  ).toBeVisible();
  await expect(page.getByText("1,240,000원", { exact: true })).toHaveCount(0);
  await expect(page.getByText("최근 운영 기록", { exact: true })).toHaveCount(0);
  await expect(page.getByText("일마감 미완료", { exact: true })).toHaveCount(0);
  await expect(
    page.getByRole("heading", { name: "주문 취소·반품 재고 관리" }),
  ).toBeVisible();
  expect(audit.syntheticWrites).toEqual([]);
  expectNoHomePrivateReads(audit);
  expect(
    await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth),
  ).toBe(true);
  const screenshot = testInfo.outputPath("home-redesign-desktop-1440.png");
  await page.screenshot({ path: screenshot });
  console.log(`Home redesign desktop screenshot: ${screenshot}`);
  for (const [name, id] of [
    ["입고 검토 시작", "ocr"],
    ["재고 확인", "inventory"],
    ["매출·마감 확인", "sales"],
  ] as const) {
    const action = page.getByRole("button", { name, exact: true });
    const size = await action.boundingBox();
    expect(size!.height).toBeGreaterThanOrEqual(44);
    await action.click();
    await active(page, id);
    await page.goBack();
    await active(page, "overview");
  }
  await page.getByText("집계 기준·개인정보 안내", { exact: true }).click();
  const help = page
    .locator("details[open]")
    .filter({ has: page.getByText("집계 기준·개인정보 안내", { exact: true }) });
  await expect(help).toContainText("오프라인을 포함한 매출은 매출·일마감에서");
  await expect(help).toContainText(
    "오늘 주문은 오늘(KST) 생성된 주문 건수로 결제 여부와 무관",
  );
  await expect(help).toContainText(
    "현재 결제완료(PAID) 상태이며 오늘(KST) 결제된 온라인 주문",
  );
  await expect(help).toContainText("등록 쿠폰에는 초안과 일시중지 쿠폰도 포함");
  await expect(help).toContainText(
    "회원 정보와 수신 동의는 관리자 권한을 확인한 API에서만",
  );
  await expect(help).toContainText("채널별 발송 가능 수신자 수가 아닙니다");
  await checkHomePrivateCreateHistory(page, audit);
});

test("home redesign: legitimate zero is distinct from a missing optional aggregation", async ({
  page,
}) => {
  const audit = await setup(page, {
    handleOverview: (route) =>
      respond(route, {
        ...completeOverview,
        todayOrderCount: 0,
        todayPaidRevenue: 0,
        todaySoldItemCount: 0,
        todayNewMemberCount: 0,
      }),
  });
  await expect(overviewMetric(page, "오늘 매출").locator("strong")).toHaveText(
    /^(?:₩|￦)?0(?:원)?$/,
  );
  await expect(overviewMetric(page, "오늘 주문(건)").locator("strong")).toHaveText(
    /^0(?:건)?$/,
  );
  await expect(overviewMetric(page, "판매 상품 수량(개)").locator("strong")).toHaveText(
    /^0(?:개)?$/,
  );
  await expect(overviewMetric(page, "신규 회원").locator("strong")).toHaveText(
    /^0(?:명)?$/,
  );
  expect(audit.syntheticWrites).toEqual([]);
  expectNoHomePrivateReads(audit);
});

test("home redesign: old overview responses keep absent revenue sales units and new members pending rather than zero", async ({
  page,
}) => {
  const audit = await setup(page);
  for (const label of ["오늘 매출", "판매 상품 수량(개)", "신규 회원"]) {
    const metric = overviewMetric(page, label);
    await expect(metric.locator("strong")).toHaveText("—");
    await expect(metric).toContainText("집계 준비 중");
  }
  await expect(overviewMetric(page, "오늘 주문(건)").locator("strong")).toHaveText(
    /^0(?:건)?$/,
  );
  expect(audit.syntheticWrites).toEqual([]);
});

test("home redesign: a failed overview fetch shows unavailable values without sample data or automatic writes", async ({
  page,
}) => {
  const audit = await setup(page, {
    handleOverview: (route) =>
      route.fulfill({
        status: 503,
        json: { code: "SYNTHETIC_UNAVAILABLE" },
        headers: { "access-control-allow-origin": "*" },
      }),
  });
  for (const label of [
    "오늘 매출",
    "오늘 주문(건)",
    "판매 상품 수량(개)",
    "신규 회원",
  ]) {
    const metric = overviewMetric(page, label);
    await expect(metric.locator("strong")).toHaveText("—");
    await expect(metric).toContainText("지표 조회 실패 · 연결·권한 확인 필요");
  }
  await expect(
    page.getByRole("alert").filter({ hasText: "운영 지표를 불러오지 못했습니다" }),
  ).toBeVisible();
  await expect(page.getByText("SYNTHETIC_UNAVAILABLE", { exact: true })).toHaveCount(0);
  await expect(page.getByText("1,240,000원", { exact: true })).toHaveCount(0);
  expect(audit.syntheticWrites).toEqual([]);
});

test("home redesign: slow overview remains loading until its own fixture resolves", async ({
  page,
}) => {
  let release!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const audit = await setup(page, {
    waitForIdle: false,
    handleOverview: async (route) => {
      await gate;
      await respond(route, completeOverview);
    },
  });
  try {
    await expect(overviewMetric(page, "오늘 매출").locator("strong")).toHaveText("…");
    await expect(overviewMetric(page, "오늘 매출")).toContainText("불러오는 중");
  } finally {
    release();
  }
  await expect(overviewMetric(page, "오늘 매출").locator("strong")).toHaveText(
    /139,000/,
  );
  expect(audit.syntheticWrites).toEqual([]);
});

test("home redesign: desktop keyboard navigation and store return preserve the explicit destination and menu", async ({
  page,
}) => {
  const audit = await setup(page, {
    path: "/admin?returnTo=%2Fproducts%3Fslug%3Dsynthetic-deck",
  });
  const overview = page.getByRole("tab", { name: "홈(운영현황)", exact: true });
  await overview.focus();
  await expect(overview).toBeFocused();
  await overview.press("End");
  await active(page, "ocr");
  await page.getByRole("tab", { name: "입고 OCR", exact: true }).press("Home");
  await active(page, "overview");
  await select(page, "brands");
  const back = page.getByRole("link", { name: "스토어로 돌아가기", exact: true });
  const destination = new URL((await back.getAttribute("href"))!, ORIGIN);
  expect(destination.pathname).toBe("/products");
  expect(destination.searchParams.get("slug")).toBe("synthetic-deck");
  expect(destination.searchParams.get("adminSection")).toBe("brands");
  expect(audit.syntheticWrites).toEqual([]);
});

test("home redesign: mobile drawer is explicit dismissible and keeps the page within 375 CSS pixels", async ({
  page,
}, testInfo) => {
  await page.setViewportSize({ width: 375, height: 844 });
  const audit = await setup(page, {
    handleOverview: (route) => respond(route, completeOverview),
  });
  const opener = page.getByRole("button", { name: "운영 메뉴 열기", exact: true });
  await expect(opener).toBeVisible();
  await expect(opener).toHaveAttribute("aria-expanded", "false");
  await expect(
    page.getByRole("tab", { name: "홈(운영현황)", exact: true }),
  ).not.toBeVisible();
  await opener.click();
  await expect(page.getByRole("tablist")).toBeVisible();
  await expect(page.getByRole("tab")).toHaveCount(9);
  await expect(
    page.getByRole("tab", { name: "홈(운영현황)", exact: true }),
  ).toBeFocused();
  const drawer = page.locator("#ops-menu-drawer");
  const first = drawer.getByRole("button", { name: "메뉴 닫기", exact: true });
  const last = drawer.getByRole("link", { name: "스토어로 돌아가기", exact: true });
  await last.focus();
  await page.keyboard.press("Tab");
  await expect(first).toBeFocused();
  await page.keyboard.press("Shift+Tab");
  await expect(last).toBeFocused();
  await page.keyboard.press("Escape");
  await expect(opener).toHaveAttribute("aria-expanded", "false");
  await expect(opener).toBeFocused();
  await select(page, "inventory");
  await expect(opener).toHaveAttribute("aria-expanded", "false");
  await page.goBack();
  await active(page, "overview");
  expect(
    await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth),
  ).toBe(true);
  expect(audit.syntheticWrites).toEqual([]);
  expectNoHomePrivateReads(audit);
  const screenshot = testInfo.outputPath("home-redesign-mobile-375.png");
  await page.screenshot({ path: screenshot });
  console.log(`Home redesign mobile screenshot: ${screenshot}`);
  await checkHomePrivateCreateHistory(page, audit);
});

for (const width of [1440, 375]) {
  test(`home redesign: ${width}px product-admin-store-admin round trip preserves original detail menu and catalog filter`, async ({
    page,
  }) => {
    await page.setViewportSize({ width, height: 900 });
    const audit = await setup(page, { path: "/", storefrontProduct: true });
    const menu = page.getByRole("button", { name: "Menu", exact: true });
    if (width < 768) await menu.click();
    else await menu.press("ArrowDown");
    await expect(menu).toHaveAttribute("aria-expanded", "true");
    const dropdown = page.locator("#store-menu-dropdown");
    await dropdown.getByRole("button", { name: "데크", exact: true }).press("Enter");
    await expect(
      dropdown.getByRole("button", { name: "데크", exact: true }),
    ).toHaveAttribute("aria-pressed", "true");
    await menu.press("Enter");
    await expect(menu).toHaveAttribute("aria-expanded", "false");
    const filter = await page.evaluate(() =>
      sessionStorage.getItem("paradays:catalog-filters:v1"),
    );
    expect(filter).not.toBeNull();
    const list = page.getByRole("list", { name: "PARADAYS products" });
    await expect(list).not.toHaveAttribute("aria-busy", "true");
    await list
      .getByRole("link", {
        name: `${returnProduct.name} 상품상세 보기`,
        exact: true,
      })
      .click();
    await page.waitForURL(
      (url) =>
        url.pathname === "/products" &&
        url.searchParams.get("slug") === returnProduct.slug,
    );
    await expect(
      page.getByRole("heading", { name: returnProduct.name, exact: true }),
    ).toBeVisible();
    const detail = new URL(page.url());
    await page.getByRole("link", { name: "관리자페이지", exact: true }).click();
    await active(page, "overview");
    await select(page, "inventory");
    await page.getByRole("link", { name: "스토어로 돌아가기", exact: true }).click();
    await page.waitForURL(
      (url) =>
        url.pathname === detail.pathname &&
        url.searchParams.get("slug") === detail.searchParams.get("slug") &&
        url.searchParams.get("adminSection") === "inventory",
    );
    const returned = new URL(page.url());
    expect(returned.pathname).toBe(detail.pathname);
    expect(returned.searchParams.get("slug")).toBe(detail.searchParams.get("slug"));
    expect(returned.searchParams.get("adminSection")).toBe("inventory");
    await expect(
      page.getByRole("heading", { name: returnProduct.name, exact: true }),
    ).toBeVisible();
    expect(
      await page.evaluate(() => sessionStorage.getItem("paradays:catalog-filters:v1")),
    ).toBe(filter);
    await page.getByRole("link", { name: "관리자페이지", exact: true }).click();
    await active(page, "inventory");
    expect(audit.syntheticWrites).toEqual([]);
  });
}

for (const viewport of [
  { width: 320, height: 900 },
  { width: 1024, height: 768 },
  { width: 1440, height: 500 },
]) {
  test(`home redesign: ${viewport.width}x${viewport.height} reflow keeps navigation and return link reachable`, async ({
    page,
  }, testInfo) => {
    await page.setViewportSize(viewport);
    const audit = await setup(page, {
      handleOverview: (route) => respond(route, completeOverview),
    });
    expect(
      await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth),
    ).toBe(true);
    for (const name of ["새 상품", "입고 검토 시작", "재고 확인", "매출·마감 확인"]) {
      const size = await page.getByRole("button", { name, exact: true }).boundingBox();
      expect(size!.height).toBeGreaterThanOrEqual(44);
      expect(size!.x).toBeGreaterThanOrEqual(0);
      expect(size!.x + size!.width).toBeLessThanOrEqual(viewport.width);
    }
    await page.screenshot({
      path: testInfo.outputPath(
        `home-redesign-${viewport.width}x${viewport.height}-layout.png`,
      ),
    });
    if (viewport.width < 1024)
      await page.getByRole("button", { name: "운영 메뉴 열기", exact: true }).click();
    const drawer = page.locator("#ops-menu-drawer");
    const lastTab = drawer.getByRole("tab", { name: "입고 OCR", exact: true });
    await lastTab.focus();
    await expect(lastTab).toBeFocused();
    let bounds = await lastTab.boundingBox();
    expect(bounds!.y).toBeGreaterThanOrEqual(0);
    expect(bounds!.y + bounds!.height).toBeLessThanOrEqual(viewport.height);
    await page.screenshot({
      path: testInfo.outputPath(
        `home-redesign-${viewport.width}x${viewport.height}-navigation.png`,
      ),
    });
    const back = drawer.getByRole("link", {
      name: "스토어로 돌아가기",
      exact: true,
    });
    await back.focus();
    await expect(back).toBeFocused();
    bounds = await back.boundingBox();
    expect(bounds!.y).toBeGreaterThanOrEqual(0);
    expect(bounds!.y + bounds!.height).toBeLessThanOrEqual(viewport.height);
    expect(audit.syntheticWrites).toEqual([]);
    expectNoHomePrivateReads(audit);
  });
}

async function newProduct(page: Page) {
  await active(page, "products");
  await page.getByRole("button", { name: "새 상품 등록", exact: true }).click();
  await expect(
    page.getByRole("heading", { name: "새 상품", exact: true }),
  ).toBeVisible();
}

async function fillProduct(page: Page, name = "SYNTHETIC_REDESIGN_DECK") {
  await page.getByRole("textbox", { name: "상품명", exact: false }).fill(name);
  await page
    .locator("#admin-panel-products")
    .getByRole("textbox", { name: "브랜드", exact: false })
    .fill("NOVA");
  const sku = await page.getByLabel("SKU / 관리 코드", { exact: true }).inputValue();
  expect(sku).toMatch(PRODUCT_SKU_UUID);
  await expect(page.getByLabel("SKU / 관리 코드", { exact: true })).toHaveAttribute(
    "readonly",
    "",
  );
  await page.getByRole("spinbutton", { name: "판매가", exact: false }).fill("89000");
  await page.getByRole("spinbutton", { name: /재고/ }).fill("13");
  await page
    .getByRole("textbox", { name: "사이즈 / 옵션", exact: false })
    .fill("8.25 inch, 8.5 inch");
  return sku;
}

const PRODUCT_SKU_UUID =
  /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

function productPreview(page: Page) {
  return page.locator("#admin-panel-products aside").first();
}

test("product redesign: desktop draft updates the customer preview while remaining private and unsaved", async ({
  page,
}, testInfo) => {
  await page.setViewportSize({ width: 1440, height: 1000 });
  const audit = await setup(page, { path: "/admin?section=products" });
  await newProduct(page);
  await fillProduct(page);
  const preview = productPreview(page);
  await expect(
    preview.getByRole("heading", { name: "SYNTHETIC_REDESIGN_DECK", exact: true }),
  ).toBeVisible();
  await expect(preview).toContainText("NOVA");
  await expect(preview).toContainText("89,000");
  await expect(preview).toContainText("8.25 inch");
  await expect(preview).toContainText("8.5 inch");
  await expect(preview).toContainText("비공개");
  await expect(page.getByRole("spinbutton", { name: /재고/ })).toHaveValue("13");
  await expect(page.getByRole("checkbox", { name: /스토어.*공개/ })).not.toBeChecked();
  await expect(
    page.getByRole("button", { name: "비공개로 저장", exact: true }),
  ).toBeVisible();
  expect(audit.syntheticWrites).toEqual([]);
  expect(
    await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth),
  ).toBe(true);
  await page.evaluate(() => scrollTo(0, 0));
  const screenshot = testInfo.outputPath("product-redesign-desktop-1440.png");
  await page.screenshot({ path: screenshot });
  console.log(`Product redesign desktop screenshot: ${screenshot}`);
});

test("product redesign: empty and missing-option public submissions do not write a product", async ({
  page,
}) => {
  const audit = await setup(page, { path: "/admin?section=products" });
  await newProduct(page);
  await page.getByRole("button", { name: "비공개로 저장", exact: true }).click();
  await expect(page.locator("#admin-panel-products").getByRole("alert")).toContainText(
    "상품명, 브랜드, 판매가",
  );
  await fillProduct(page);
  await page.getByRole("textbox", { name: "사이즈 / 옵션", exact: false }).fill("");
  await page.getByRole("checkbox", { name: /스토어.*공개/ }).check();
  page.on("dialog", (dialog) => void dialog.accept());
  await page.getByRole("button", { name: "저장 후 스토어 공개", exact: true }).click();
  await expect(page.locator("#admin-panel-products").getByRole("alert")).toContainText(
    "최소 한 개의 옵션",
  );
  expect(audit.syntheticWrites).toEqual([]);
});

test("product redesign: a private create sends the generated SKU stock options and translated fields exactly once", async ({
  page,
}) => {
  const commands: Record<string, unknown>[] = [];
  const audit = await setup(page, {
    path: "/admin?section=products",
    handleProductMutation: async (route) => {
      expect(route.request().method()).toBe("POST");
      expect(route.request().headers().authorization).toMatch(/^Bearer /);
      commands.push(route.request().postDataJSON() as Record<string, unknown>);
      await respond(route, {});
    },
  });
  await newProduct(page);
  const sku = await fillProduct(page);
  await page.getByRole("checkbox", { name: "신상품 배지 표시", exact: true }).check();
  await page.getByRole("button", { name: "비공개로 저장", exact: true }).click();
  await expect.poll(() => commands.length).toBe(1);
  expect(commands[0]).toMatchObject({
    name: "SYNTHETIC_REDESIGN_DECK",
    brand: "NOVA",
    category: "Deck",
    sku,
    price: "89000",
    stock: "13",
    sizes: "8.25 inch, 8.5 inch",
    isVisible: false,
    isFeatured: true,
    sourceLocale: "ko",
    nameI18n: { en: "SYNTHETIC_REDESIGN_DECK", ko: "SYNTHETIC_REDESIGN_DECK" },
  });
  await expect(
    page.getByRole("button", { name: "새 상품 등록", exact: true }),
  ).toBeVisible();
  expect(audit.syntheticWrites).toEqual([
    "POST https://api.sales.test/prod/admin/catalog/products",
  ]);
});

test("product redesign: publishing requires a deliberate confirmation and dismissing it leaves the draft untouched", async ({
  page,
}) => {
  const commands: Record<string, unknown>[] = [];
  const audit = await setup(page, {
    path: "/admin?section=products",
    handleProductMutation: async (route) => {
      commands.push(route.request().postDataJSON() as Record<string, unknown>);
      await respond(route, {});
    },
  });
  await newProduct(page);
  await fillProduct(page);
  await page.getByRole("checkbox", { name: /스토어.*공개/ }).check();
  await expect(productPreview(page)).toContainText("공개 예정");
  let confirmations = 0;
  page.once("dialog", (dialog) => {
    confirmations += 1;
    void dialog.dismiss();
  });
  await page.getByRole("button", { name: "저장 후 스토어 공개", exact: true }).click();
  expect(confirmations).toBe(1);
  expect(commands).toEqual([]);
  await expect(page.getByRole("textbox", { name: "상품명", exact: false })).toHaveValue(
    "SYNTHETIC_REDESIGN_DECK",
  );
  page.once("dialog", (dialog) => {
    confirmations += 1;
    void dialog.accept();
  });
  await page.getByRole("button", { name: "저장 후 스토어 공개", exact: true }).click();
  await expect.poll(() => commands.length).toBe(1);
  expect(confirmations).toBe(2);
  expect(commands[0]).toMatchObject({ isVisible: true, sizes: "8.25 inch, 8.5 inch" });
  await expect(
    page.getByRole("button", { name: "새 상품 등록", exact: true }),
  ).toBeVisible();
  expect(audit.syntheticWrites).toEqual([
    "POST https://api.sales.test/prod/admin/catalog/products",
  ]);
});

test("product redesign: an already-published edit preserves publication and submits the original product version", async ({
  page,
}) => {
  const commands: Record<string, unknown>[] = [];
  const audit = await setup(page, {
    path: "/admin?section=products",
    catalogProducts: [
      { ...products[0], status: "PUBLISHED", sku: "EXISTING-SKU", version: 7 },
    ],
    handleProductMutation: async (route) => {
      expect(route.request().method()).toBe("PATCH");
      commands.push(route.request().postDataJSON() as Record<string, unknown>);
      await respond(route, {});
    },
  });
  await page
    .getByRole("listitem")
    .filter({ hasText: products[0]!.name })
    .getByRole("button", { name: "수정", exact: true })
    .click();
  await expect(page.getByRole("checkbox", { name: /스토어.*공개/ })).toBeChecked();
  await page
    .getByRole("textbox", { name: "상품명", exact: false })
    .fill("SYNTHETIC_EDITED_PUBLIC_DECK");
  page.on("dialog", (dialog) => void dialog.accept());
  await page
    .getByRole("button", { name: "공개 상태로 수정 저장", exact: true })
    .click();
  await expect.poll(() => commands.length).toBe(1);
  expect(commands[0]).toMatchObject({
    name: "SYNTHETIC_EDITED_PUBLIC_DECK",
    version: 7,
    sku: "EXISTING-SKU",
    isVisible: true,
  });
  await expect(
    page.getByRole("button", { name: "새 상품 등록", exact: true }),
  ).toBeVisible();
  expect(audit.syntheticWrites).toEqual([
    "PATCH https://api.sales.test/prod/admin/catalog/products/prd_synthetic_A",
  ]);
});

test("product redesign: SKU and status filters keyboard and pointer selection and confirmed synthetic deletion retain their contracts", async ({
  page,
}) => {
  let items = [
    { ...products[0], sku: "SKU-A", status: "DRAFT", version: 4 },
    {
      ...products[1],
      sku: "SKU-B",
      status: "PUBLISHED",
      inventoryQuantity: 0,
      version: 7,
    },
  ];
  const deleted: { path: string; version: unknown }[] = [];
  const audit = await setup(page, {
    path: "/admin?section=products",
    handleCatalog: (route) => respond(route, { products: items }),
    handleProductMutation: async (route) => {
      expect(route.request().method()).toBe("DELETE");
      const path = new URL(route.request().url()).pathname;
      const body = route.request().postDataJSON() as Record<string, unknown>;
      deleted.push({ path, version: body.version });
      items = items.filter((item) => !path.endsWith(item.productId!));
      await respond(route, {});
    },
  });
  const panel = page.locator("#admin-panel-products");
  await panel.getByRole("searchbox", { name: "상품 검색", exact: true }).fill("SKU-A");
  await expect(panel.getByRole("listitem")).toHaveCount(1);
  await expect(panel.getByRole("listitem")).toContainText(products[0]!.name);
  await panel.getByRole("searchbox", { name: "상품 검색", exact: true }).fill("");
  await panel
    .getByRole("combobox", { name: "상태", exact: true })
    .selectOption("published");
  await expect(panel.getByRole("listitem")).toHaveCount(1);
  await expect(panel.getByRole("listitem")).toContainText(products[1]!.name);
  await panel.getByRole("combobox", { name: "상태", exact: true }).selectOption("all");
  await panel
    .getByRole("combobox", { name: "재고", exact: true })
    .selectOption("soldOut");
  await expect(panel.getByRole("listitem")).toHaveCount(1);
  await expect(panel.getByRole("listitem")).toContainText(products[1]!.name);
  await panel.getByRole("combobox", { name: "재고", exact: true }).selectOption("all");
  const first = panel.getByRole("button", {
    name: `${products[0]!.name} 선택`,
    exact: true,
  });
  await first.focus();
  await first.press("Space");
  await expect(first).toHaveAttribute("aria-pressed", "true");
  await first.press("Enter");
  await expect(first).toHaveAttribute("aria-pressed", "false");
  await first.click();
  await expect(first).toHaveAttribute("aria-pressed", "true");
  await panel
    .getByRole("button", { name: `${products[1]!.name} 선택`, exact: true })
    .click();
  const remove = panel.getByRole("button", { name: "선택 삭제 (2)", exact: true });
  page.once("dialog", (dialog) => void dialog.dismiss());
  await remove.click();
  expect(deleted).toEqual([]);
  await expect(panel.getByRole("listitem")).toHaveCount(2);
  page.once("dialog", (dialog) => void dialog.accept());
  await remove.click();
  await expect.poll(() => deleted.length).toBe(2);
  expect(deleted).toEqual([
    { path: "/prod/admin/catalog/products/prd_synthetic_A", version: 4 },
    { path: "/prod/admin/catalog/products/prd_synthetic_B", version: 7 },
  ]);
  await expect(panel.getByRole("listitem")).toHaveCount(0);
  expect(audit.syntheticWrites).toEqual([
    "DELETE https://api.sales.test/prod/admin/catalog/products/prd_synthetic_A",
    "DELETE https://api.sales.test/prod/admin/catalog/products/prd_synthetic_B",
  ]);
});

test("product redesign: empty and failed catalog states do not invent sample products", async ({
  page,
}) => {
  const audit = await setup(page, {
    path: "/admin?section=products",
    handleCatalog: (route) =>
      route.fulfill({
        status: 503,
        json: { code: "SYNTHETIC_CATALOG_UNAVAILABLE" },
        headers: { "access-control-allow-origin": "*" },
      }),
  });
  await expect(page.locator("#admin-panel-products").getByRole("alert")).toContainText(
    "상품 목록을 불러오지 못했습니다",
  );
  await expect(page.locator("#admin-panel-products").getByRole("listitem")).toHaveCount(
    0,
  );
  await expect(
    page.getByRole("button", { name: "새 상품 등록", exact: true }),
  ).toBeVisible();
  expect(audit.syntheticWrites).toEqual([]);
});

test("product redesign: rejected save leaves the entered draft editable and is not reported as saved", async ({
  page,
}) => {
  const audit = await setup(page, {
    path: "/admin?section=products",
    handleProductMutation: (route) =>
      route.fulfill({
        status: 503,
        json: { code: "SYNTHETIC_SAVE_UNAVAILABLE" },
        headers: { "access-control-allow-origin": "*" },
      }),
  });
  await newProduct(page);
  const sku = await fillProduct(page);
  await page.getByRole("button", { name: "비공개로 저장", exact: true }).click();
  await expect(page.locator("#admin-panel-products").getByRole("alert")).toContainText(
    "상품을 저장하지 못했습니다",
  );
  await expect(page.getByRole("textbox", { name: "상품명", exact: false })).toHaveValue(
    "SYNTHETIC_REDESIGN_DECK",
  );
  await expect(page.getByLabel("SKU / 관리 코드", { exact: true })).toHaveValue(sku);
  await expect(
    page.getByRole("button", { name: "비공개로 저장", exact: true }),
  ).toBeEnabled();
  expect(audit.syntheticWrites).toEqual([
    "POST https://api.sales.test/prod/admin/catalog/products",
  ]);
});

test("product redesign: local image preview uploads only to synthetic targets and never saves a blob URL", async ({
  page,
}) => {
  const commands: Record<string, unknown>[] = [];
  const audit = await setup(page, {
    path: "/admin?section=products",
    productImageFixture: true,
    handleProductMutation: async (route) => {
      commands.push(route.request().postDataJSON() as Record<string, unknown>);
      await respond(route, {});
    },
  });
  await newProduct(page);
  await fillProduct(page);
  await page.getByLabel("대표 이미지", { exact: false }).setInputFiles({
    name: "synthetic-redesign-upload.png",
    mimeType: "image/png",
    buffer: Buffer.from(
      "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aRfsAAAAASUVORK5CYII=",
      "base64",
    ),
  });
  await expect(productPreview(page).getByRole("img")).toHaveAttribute("src", /^blob:/);
  const beforeSave = await page.evaluate(() =>
    JSON.stringify({
      href: location.href,
      history: history.state,
      session: { ...sessionStorage },
      local: { ...localStorage },
    }),
  );
  expect(beforeSave).not.toContain("blob:");
  expect(beforeSave).not.toContain("synthetic-redesign-upload.png");
  await page.getByRole("button", { name: "비공개로 저장", exact: true }).click();
  await expect.poll(() => commands.length).toBe(1);
  expect(commands[0]).toMatchObject({
    imageUrl: "https://cdn.redesign.test/product.png",
    isVisible: false,
  });
  expect(JSON.stringify(commands[0])).not.toContain("blob:");
  await expect(
    page.getByRole("button", { name: "새 상품 등록", exact: true }),
  ).toBeVisible();
  expect(audit.syntheticWrites).toEqual([
    "POST https://api.sales.test/prod/admin/catalog/uploads",
    "PUT https://upload.redesign.test/image",
    "POST https://api.sales.test/prod/admin/catalog/products",
  ]);
});

test("product redesign: mobile editor and preview stay usable within 375 CSS pixels", async ({
  page,
}, testInfo) => {
  await page.setViewportSize({ width: 375, height: 844 });
  const audit = await setup(page, { path: "/admin?section=products", products: true });
  expect(
    await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth),
  ).toBe(true);
  await newProduct(page);
  await fillProduct(page, "SYNTHETIC_MOBILE_DECK");
  await expect(productPreview(page)).toContainText("SYNTHETIC_MOBILE_DECK");
  await expect(productPreview(page)).toContainText("8.25 inch");
  await expect(
    page.getByRole("button", { name: "비공개로 저장", exact: true }),
  ).toBeEnabled();
  expect(
    await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth),
  ).toBe(true);
  expect(audit.syntheticWrites).toEqual([]);
  await page.evaluate(() => scrollTo(0, 0));
  const screenshot = testInfo.outputPath("product-redesign-mobile-375.png");
  await page.screenshot({ path: screenshot });
  console.log(`Product redesign mobile screenshot: ${screenshot}`);
  await page.setViewportSize({ width: 320, height: 844 });
  expect(
    await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth),
  ).toBe(true);
});

test("product form refinement: generated management codes remain private and stable until an explicit new draft", async ({
  page,
}) => {
  const audit = await setup(page, { path: "/admin?section=products" });
  await newProduct(page);
  const code = page.getByRole("textbox", { name: "SKU / 관리 코드", exact: true });
  const firstCode = await code.inputValue();
  expect(firstCode).toMatch(PRODUCT_SKU_UUID);
  expect(firstCode).not.toBe(new URL(page.url()).searchParams.get("editor"));
  await expect(code).toHaveAttribute("readonly", "");
  await page
    .getByRole("textbox", { name: "상품명", exact: false })
    .fill("TEST_SKU_DRAFT");
  await page
    .getByRole("combobox", { name: "카테고리", exact: true })
    .selectOption("Wheels");
  await expect(code).toHaveValue(firstCode);
  const editorUrl = page.url();
  await page.goBack();
  await expect(
    page.getByRole("button", { name: "새 상품 등록", exact: true }),
  ).toBeVisible();
  await page.goForward();
  await expect(page).toHaveURL(editorUrl);
  await expect(code).toHaveValue(firstCode);
  await expect(page.getByRole("textbox", { name: "상품명", exact: false })).toHaveValue(
    "TEST_SKU_DRAFT",
  );
  const persistentSurfaces = await page.evaluate(() =>
    JSON.stringify({
      href: location.href,
      history: history.state,
      session: { ...sessionStorage },
      local: { ...localStorage },
    }),
  );
  expect(persistentSurfaces).not.toContain(firstCode);
  await page.getByRole("button", { name: "새 초안", exact: true }).click();
  const resetCode = await code.inputValue();
  expect(resetCode).toMatch(PRODUCT_SKU_UUID);
  expect(resetCode).not.toBe(firstCode);
  await page.getByRole("button", { name: "← 목록으로", exact: true }).click();
  await newProduct(page);
  const nextCode = await code.inputValue();
  expect(nextCode).toMatch(PRODUCT_SKU_UUID);
  expect([firstCode, resetCode]).not.toContain(nextCode);
  expect(audit.syntheticWrites).toEqual([]);
});

test("product form refinement: a legacy product without a management code stays blank across editing and reset", async ({
  page,
}) => {
  const commands: Record<string, unknown>[] = [];
  const audit = await setup(page, {
    path: "/admin?section=products",
    products: true,
    handleProductMutation: async (route) => {
      commands.push(route.request().postDataJSON() as Record<string, unknown>);
      await respond(route, {});
    },
  });
  await page
    .getByRole("listitem")
    .filter({ hasText: products[0]!.name })
    .getByRole("button", { name: "수정", exact: true })
    .click();
  const code = page.getByRole("textbox", { name: "SKU / 관리 코드", exact: true });
  await expect(code).toHaveValue("");
  await expect(code).toHaveAttribute("readonly", "");
  await page.getByRole("button", { name: "입력 초기화", exact: true }).click();
  await expect(code).toHaveValue("");
  await page
    .getByRole("textbox", { name: "상품명", exact: false })
    .fill("TEST_LEGACY_EMPTY_SKU");
  await page.getByRole("textbox", { name: "브랜드", exact: false }).fill("TEST");
  await page.getByRole("spinbutton", { name: "판매가", exact: false }).fill("10000");
  await page.getByRole("button", { name: "비공개 수정 저장", exact: true }).click();
  await expect.poll(() => commands.length).toBe(1);
  expect(commands[0]).toMatchObject({
    version: 1,
    name: "TEST_LEGACY_EMPTY_SKU",
    isVisible: false,
  });
  expect(commands[0]).not.toHaveProperty("sku");
  expect(audit.syntheticWrites).toEqual([
    "PATCH https://api.sales.test/prod/admin/catalog/products/prd_synthetic_A",
  ]);
});

test("product form refinement: brand typing and the right-hand choice list retain the exact selected or custom brand", async ({
  page,
}) => {
  const commands: Record<string, unknown>[] = [];
  const audit = await setup(page, {
    path: "/admin?section=products",
    catalogProducts: [
      { ...products[0], brandName: "NOVA" },
      { ...products[1], brandName: " nova " },
      { ...products[1], productId: "prd_synthetic_C", brandName: "RIVER" },
    ],
    handleProductMutation: async (route) => {
      commands.push(route.request().postDataJSON() as Record<string, unknown>);
      await respond(route, {});
    },
  });
  await newProduct(page);
  const input = page.getByRole("textbox", { name: "브랜드", exact: false });
  const choice = page.getByRole("combobox", { name: "브랜드 선택", exact: true });
  const labels = await choice.locator("option").allTextContents();
  expect(labels.filter((label) => label.trim().toLowerCase() === "nova")).toEqual([
    "NOVA",
  ]);
  expect(labels).toContain("RIVER");
  expect(labels).toContain("기타");
  await input.fill("TEST_MANUAL_BRAND");
  await choice.selectOption({ label: "RIVER" });
  await expect(input).toHaveValue("RIVER");
  await expect(productPreview(page)).toContainText("RIVER");
  await choice.selectOption({ label: "기타" });
  await input.fill("TEST_CUSTOM_BRAND");
  await expect(productPreview(page)).toContainText("TEST_CUSTOM_BRAND");
  await page
    .getByRole("textbox", { name: "상품명", exact: false })
    .fill("TEST_CUSTOM_BRAND_DECK");
  await page.getByRole("spinbutton", { name: "판매가", exact: false }).fill("10000");
  await page.getByRole("button", { name: "비공개로 저장", exact: true }).click();
  await expect.poll(() => commands.length).toBe(1);
  expect(commands[0]).toMatchObject({ brand: "TEST_CUSTOM_BRAND", isVisible: false });
  expect(audit.syntheticWrites).toEqual([
    "POST https://api.sales.test/prod/admin/catalog/products",
  ]);
});

test("product form refinement: deck choices append only explicitly and category changes preserve legacy multi-options", async ({
  page,
}) => {
  const audit = await setup(page, { path: "/admin?section=products" });
  await newProduct(page);
  const raw = page.getByRole("textbox", { name: "사이즈 / 옵션", exact: false });
  const chooser = page.getByRole("combobox", { name: "데크 규격 선택", exact: true });
  const labels = await chooser.locator("option").allTextContents();
  for (const width of ["7.5", "7.75", "8.0", "8.125", "8.25", "8.5"]) {
    expect(labels.some((label) => label.includes(width))).toBe(true);
  }
  expect(labels.some((label) => /직접\s*입력/.test(label))).toBe(true);
  const legacy = " 8.25\u2033 , SPECIAL / blue ";
  await raw.fill(legacy);
  await chooser.selectOption("8.125");
  await expect(raw).toHaveValue(legacy);
  await expect(productPreview(page)).not.toContainText("8.125 inch");
  await page.getByRole("button", { name: "옵션 추가", exact: true }).click();
  await expect(raw).toHaveValue(`${legacy}, 8.125 inch`);
  await expect(productPreview(page)).toContainText("8.125 inch");
  await chooser.selectOption("8.125");
  await page.getByRole("button", { name: "옵션 추가", exact: true }).click();
  await expect(raw).toHaveValue(`${legacy}, 8.125 inch`);
  await page
    .getByRole("combobox", { name: "카테고리", exact: true })
    .selectOption("Wheels");
  await expect(raw).toHaveValue(`${legacy}, 8.125 inch`);
  await expect(chooser).toHaveCount(0);
  await expect(
    page.getByRole("combobox", { name: "바퀴 크기 선택", exact: true }),
  ).toBeVisible();
  await page
    .getByRole("combobox", { name: "카테고리", exact: true })
    .selectOption("Deck");
  await expect(raw).toHaveValue(`${legacy}, 8.125 inch`);
  await chooser.selectOption("manual");
  await expect(raw).toBeFocused();
  await expect(raw).toHaveValue(`${legacy}, 8.125 inch`);
  await raw.fill(`${legacy}, 8.125 inch, TEST_CUSTOM_8.375`);
  await expect(productPreview(page)).toContainText("TEST_CUSTOM_8.375");
  expect(audit.syntheticWrites).toEqual([]);
});

test("product form refinement: wheel size and hardness ranges form one complete purchase option in the save payload", async ({
  page,
}) => {
  const commands: Record<string, unknown>[] = [];
  const audit = await setup(page, {
    path: "/admin?section=products",
    handleProductMutation: async (route) => {
      commands.push(route.request().postDataJSON() as Record<string, unknown>);
      await respond(route, {});
    },
  });
  await newProduct(page);
  await fillProduct(page, "TEST_WHEEL_COMPOSITE");
  const raw = page.getByRole("textbox", { name: "사이즈 / 옵션", exact: false });
  await raw.fill("");
  await page
    .getByRole("combobox", { name: "카테고리", exact: true })
    .selectOption("Wheels");
  const diameter = page.getByRole("combobox", { name: "바퀴 크기 선택", exact: true });
  const hardness = page.getByRole("combobox", { name: "경도 선택", exact: true });
  const diameterValues = await diameter
    .locator("option")
    .evaluateAll((items) =>
      items
        .map((item) => (item as HTMLOptionElement).value)
        .filter((value) => /^\d+$/.test(value)),
    );
  const hardnessValues = await hardness
    .locator("option")
    .evaluateAll((items) =>
      items
        .map((item) => (item as HTMLOptionElement).value)
        .filter((value) => /^\d+$/.test(value)),
    );
  expect(diameterValues).toEqual(
    Array.from({ length: 11 }, (_, index) => String(index + 50)),
  );
  expect(hardnessValues).toEqual(
    Array.from({ length: 22 }, (_, index) => String(index + 80)),
  );
  const add = page.getByRole("button", { name: "옵션 추가", exact: true });
  await diameter.selectOption("54");
  await expect(raw).toHaveValue("");
  await expect(add).toBeDisabled();
  const publish = page.getByRole("checkbox", {
    name: "저장 후 스토어에 공개",
    exact: true,
  });
  await publish.check();
  await page.getByRole("button", { name: "저장 후 스토어 공개", exact: true }).click();
  await expect(page.locator("#admin-panel-products").getByRole("alert")).toContainText(
    "최소 한 개의 옵션",
  );
  expect(commands).toEqual([]);
  await hardness.selectOption("99");
  await expect(raw).toHaveValue("");
  await expect(productPreview(page)).not.toContainText("54mm / 99a");
  await page.getByRole("button", { name: "저장 후 스토어 공개", exact: true }).click();
  await expect(page.locator("#admin-panel-products").getByRole("alert")).toContainText(
    "최소 한 개의 옵션",
  );
  expect(commands).toEqual([]);
  await publish.uncheck();
  await add.click();
  await expect(raw).toHaveValue("54mm / 99a");
  await expect(productPreview(page)).toContainText("54mm / 99a");
  await page.getByRole("button", { name: "비공개로 저장", exact: true }).click();
  await expect.poll(() => commands.length).toBe(1);
  expect(commands[0]).toMatchObject({
    category: "Wheels",
    sizes: "54mm / 99a",
    isVisible: false,
  });
  expect(String(commands[0]!.sizes).split(",")).toHaveLength(1);
  expect(audit.syntheticWrites).toEqual([
    "POST https://api.sales.test/prod/admin/catalog/products",
  ]);
});

test("product form refinement: raw option count and length limits stop writes without erasing entered legacy text", async ({
  page,
}) => {
  const audit = await setup(page, { path: "/admin?section=products" });
  await newProduct(page);
  await fillProduct(page);
  const raw = page.getByRole("textbox", { name: "사이즈 / 옵션", exact: false });
  const chooser = page.getByRole("combobox", { name: "데크 규격 선택", exact: true });
  const twenty = Array.from({ length: 20 }, (_, index) => `LEGACY_${index}`).join(", ");
  await raw.fill(twenty);
  await chooser.selectOption("7.5");
  await page.getByRole("button", { name: "옵션 추가", exact: true }).click();
  await expect(raw).toHaveValue(twenty);
  await expect(page.locator("#admin-panel-products").getByRole("alert")).toContainText(
    "20",
  );
  const twentyOne = `${twenty}, OVERFLOW`;
  await raw.fill(twentyOne);
  await page.getByRole("button", { name: "비공개로 저장", exact: true }).click();
  await expect(raw).toHaveValue(twentyOne);
  await expect(page.locator("#admin-panel-products").getByRole("alert")).toContainText(
    "20",
  );
  const tooLong = "한".repeat(51);
  await raw.fill(tooLong);
  await page.getByRole("button", { name: "비공개로 저장", exact: true }).click();
  await expect(raw).toHaveValue(tooLong);
  await expect(page.locator("#admin-panel-products").getByRole("alert")).toContainText(
    "50",
  );
  expect(audit.syntheticWrites).toEqual([]);
});

test("product form refinement: exactly twenty fifty-character options remain valid and are sent without truncation", async ({
  page,
}) => {
  const commands: Record<string, unknown>[] = [];
  const audit = await setup(page, {
    path: "/admin?section=products",
    handleProductMutation: async (route) => {
      commands.push(route.request().postDataJSON() as Record<string, unknown>);
      await respond(route, {});
    },
  });
  await newProduct(page);
  await fillProduct(page);
  const exactBoundary = Array.from(
    { length: 20 },
    (_, index) => `${"한".repeat(48)}${String(index).padStart(2, "0")}`,
  ).join(", ");
  await page
    .getByRole("textbox", { name: "사이즈 / 옵션", exact: false })
    .fill(exactBoundary);
  await page.getByRole("button", { name: "비공개로 저장", exact: true }).click();
  await expect.poll(() => commands.length).toBe(1);
  expect(commands[0]).toHaveProperty("sizes", exactBoundary);
  expect(
    String(commands[0]!.sizes)
      .split(",")
      .map((option) => option.trim()),
  ).toHaveLength(20);
  expect(audit.syntheticWrites).toEqual([
    "POST https://api.sales.test/prod/admin/catalog/products",
  ]);
});

test("product form refinement: editor changes discard pending option selections without mixing A and B draft options", async ({
  page,
}) => {
  const audit = await setup(page, { path: "/admin?section=products", products: true });
  await page
    .getByRole("listitem")
    .filter({ hasText: products[0]!.name })
    .getByRole("button", { name: "수정", exact: true })
    .click();
  const raw = page.getByRole("textbox", { name: "사이즈 / 옵션", exact: false });
  await raw.fill("TEST_A_LEGACY");
  const chooser = page.getByRole("combobox", { name: "데크 규격 선택", exact: true });
  await chooser.selectOption("8.5");
  const firstUrl = page.url();
  await select(page, "products");
  await page
    .getByRole("listitem")
    .filter({ hasText: products[1]!.name })
    .getByRole("button", { name: "수정", exact: true })
    .click();
  await expect(raw).toHaveValue("TEST");
  await expect(chooser).not.toHaveValue("8.5");
  await expect(
    page.getByRole("button", { name: "옵션 추가", exact: true }),
  ).toBeDisabled();
  await raw.fill("TEST_B_LEGACY");
  await page.goBack();
  await expect(
    page.getByRole("button", { name: "새 상품 등록", exact: true }),
  ).toBeVisible();
  await page.goBack();
  await expect(page).toHaveURL(firstUrl);
  await expect(raw).toHaveValue("TEST_A_LEGACY");
  await expect(chooser).not.toHaveValue("8.5");
  expect(audit.syntheticWrites).toEqual([]);
});

test("product form refinement: an existing compare-at price and management code survive reset and an ordinary edit", async ({
  page,
}) => {
  const commands: Record<string, unknown>[] = [];
  const audit = await setup(page, {
    path: "/admin?section=products",
    catalogProducts: [
      { ...products[0], sku: "LEGACY-SKU-825", compareAtPrice: 20000, version: 7 },
    ],
    handleProductMutation: async (route) => {
      commands.push(route.request().postDataJSON() as Record<string, unknown>);
      await respond(route, {});
    },
  });
  await page
    .getByRole("listitem")
    .filter({ hasText: products[0]!.name })
    .getByRole("button", { name: "수정", exact: true })
    .click();
  const code = page.getByRole("textbox", { name: "SKU / 관리 코드", exact: true });
  const sales = page.getByRole("group", { name: "판매 정보", exact: true });
  const legacyPrice = sales.getByText(/^기존 정가\s*₩?20,000/);
  await expect(code).toHaveValue("LEGACY-SKU-825");
  await expect(legacyPrice).toBeVisible();
  await expect(page.getByRole("textbox", { name: /정가/ })).toHaveCount(0);
  await expect(page.getByRole("spinbutton", { name: /정가/ })).toHaveCount(0);
  await page.getByRole("button", { name: "입력 초기화", exact: true }).click();
  await expect(code).toHaveValue("LEGACY-SKU-825");
  await expect(legacyPrice).toBeVisible();
  await page
    .getByRole("textbox", { name: "상품명", exact: false })
    .fill("TEST_LEGACY_COMPARE_AT");
  await page.getByRole("textbox", { name: "브랜드", exact: false }).fill("TEST");
  await page.getByRole("spinbutton", { name: "판매가", exact: false }).fill("15000");
  await page.getByRole("button", { name: "비공개 수정 저장", exact: true }).click();
  await expect.poll(() => commands.length).toBe(1);
  expect(commands[0]).toMatchObject({
    sku: "LEGACY-SKU-825",
    compareAtPrice: "20000",
    price: "15000",
    version: 7,
  });
  expect(audit.syntheticWrites).toEqual([
    "PATCH https://api.sales.test/prod/admin/catalog/products/prd_synthetic_A",
  ]);
});

test("product form refinement: compare-at removal requires confirmation and resetting an edit restores the original value", async ({
  page,
}) => {
  const commands: Record<string, unknown>[] = [];
  const audit = await setup(page, {
    path: "/admin?section=products",
    catalogProducts: [
      { ...products[0], sku: "LEGACY-SKU", compareAtPrice: 20000, version: 7 },
    ],
    handleProductMutation: async (route) => {
      commands.push(route.request().postDataJSON() as Record<string, unknown>);
      await respond(route, {});
    },
  });
  await page
    .getByRole("listitem")
    .filter({ hasText: products[0]!.name })
    .getByRole("button", { name: "수정", exact: true })
    .click();
  await page.getByRole("spinbutton", { name: "판매가", exact: false }).fill("25000");
  await page.getByRole("button", { name: "비공개 수정 저장", exact: true }).click();
  await expect(page.locator("#admin-panel-products").getByRole("alert")).toContainText(
    "정가",
  );
  expect(commands).toEqual([]);
  const remove = page.getByRole("button", { name: "기존 정가 제거", exact: true });
  const legacyPrice = page
    .getByRole("group", { name: "판매 정보", exact: true })
    .getByText(/^기존 정가\s*₩?20,000/);
  page.once("dialog", (dialog) => void dialog.dismiss());
  await remove.click();
  await expect(legacyPrice).toBeVisible();
  expect(commands).toEqual([]);
  page.once("dialog", (dialog) => void dialog.accept());
  await remove.click();
  await expect(remove).toHaveCount(0);
  await expect(
    page.getByRole("status").filter({ hasText: "기존 정가 제거 예정" }),
  ).toBeVisible();
  await page.getByRole("button", { name: "입력 초기화", exact: true }).click();
  await expect(legacyPrice).toBeVisible();
  await expect(remove).toBeVisible();
  expect(commands).toEqual([]);
  page.once("dialog", (dialog) => void dialog.accept());
  await remove.click();
  await expect(remove).toHaveCount(0);
  await page
    .getByRole("textbox", { name: "상품명", exact: false })
    .fill("TEST_EXPLICIT_COMPARE_AT_REMOVAL");
  await page.getByRole("textbox", { name: "브랜드", exact: false }).fill("TEST");
  await page.getByRole("spinbutton", { name: "판매가", exact: false }).fill("25000");
  await page.getByRole("button", { name: "비공개 수정 저장", exact: true }).click();
  await expect.poll(() => commands.length).toBe(1);
  expect(Object.prototype.hasOwnProperty.call(commands[0], "compareAtPrice")).toBe(
    true,
  );
  expect(commands[0]).toMatchObject({
    compareAtPrice: "",
    price: "25000",
    sku: "LEGACY-SKU",
    version: 7,
  });
  expect(audit.syntheticWrites).toEqual([
    "PATCH https://api.sales.test/prod/admin/catalog/products/prd_synthetic_A",
  ]);
});

for (const width of [1440, 375]) {
  test(`product form refinement: ${width}px compact cards preserve image-description-publication order and accessible controls`, async ({
    page,
  }, testInfo) => {
    await page.setViewportSize({ width, height: width === 1440 ? 1000 : 844 });
    const audit = await setup(page, {
      path: "/admin?section=products",
      products: true,
    });
    await newProduct(page);
    await fillProduct(page, "TEST_COMPACT_LAYOUT_DECK");
    const panel = page.locator("#admin-panel-products");
    const image = panel.getByRole("group", { name: "대표 이미지", exact: true });
    const description = panel.getByRole("group", { name: "상품 설명", exact: true });
    const publication = panel.getByRole("group", { name: "공개 설정", exact: true });
    await expect(image).toBeVisible();
    await expect(description).toBeVisible();
    await expect(publication).toBeVisible();
    const imageBox = (await image.boundingBox())!;
    const descriptionBox = (await description.boundingBox())!;
    const publicationBox = (await publication.boundingBox())!;
    expect(descriptionBox.y).toBeGreaterThanOrEqual(imageBox.y + imageBox.height);
    expect(publicationBox.y).toBeGreaterThanOrEqual(
      descriptionBox.y + descriptionBox.height,
    );
    const descriptionInput = panel.getByRole("textbox", {
      name: "상품 설명",
      exact: false,
    });
    await descriptionInput.fill("TEST_FIRST_DESCRIPTION\nTEST_SECOND_DESCRIPTION");
    await expect(productPreview(page)).toContainText("TEST_FIRST_DESCRIPTION");
    await expect(
      publication.getByRole("checkbox", { name: "저장 후 스토어에 공개", exact: true }),
    ).not.toBeChecked();
    const badge = publication.getByRole("checkbox", {
      name: "신상품 배지 표시",
      exact: true,
    });
    await badge.check();
    await expect(badge).toBeChecked();
    await expect(productPreview(page)).toContainText("NEW");
    await expect(panel.getByRole("spinbutton", { name: /정가/ })).toHaveCount(0);
    await page.evaluate(() => scrollTo(0, 0));
    const brandInput = panel.getByRole("textbox", { name: "브랜드", exact: false });
    const brandSelect = panel.getByRole("combobox", {
      name: "브랜드 선택",
      exact: true,
    });
    const brandInputBox = (await brandInput.boundingBox())!;
    const brandSelectBox = (await brandSelect.boundingBox())!;
    expect(brandSelectBox.x).toBeGreaterThanOrEqual(
      brandInputBox.x + brandInputBox.width,
    );
    await panel
      .getByRole("combobox", { name: "데크 규격 선택", exact: true })
      .selectOption("8.25");
    for (const control of [
      brandInput,
      brandSelect,
      panel.getByRole("combobox", { name: "카테고리", exact: true }),
      panel.getByRole("combobox", { name: "데크 규격 선택", exact: true }),
      panel.getByRole("button", { name: "옵션 추가", exact: true }),
      panel.getByRole("button", { name: "비공개로 저장", exact: true }),
    ]) {
      await expect(control).toBeEnabled();
      const box = (await control.boundingBox())!;
      expect(box.height).toBeGreaterThanOrEqual(44);
      expect(box.x).toBeGreaterThanOrEqual(0);
      expect(box.x + box.width).toBeLessThanOrEqual(width + 1);
    }
    await brandInput.focus();
    await page.keyboard.press("Tab");
    await expect(brandSelect).toBeFocused();
    if (width === 1440) {
      const nameBox = (await panel
        .getByRole("textbox", { name: "상품명", exact: false })
        .boundingBox())!;
      const categoryBox = (await panel
        .getByRole("combobox", { name: "카테고리", exact: true })
        .boundingBox())!;
      expect(Math.abs(nameBox.y - brandInputBox.y)).toBeLessThanOrEqual(2);
      expect(Math.abs(nameBox.y - categoryBox.y)).toBeLessThanOrEqual(2);
      expect(brandInputBox.x).toBeGreaterThan(nameBox.x);
      expect(categoryBox.x).toBeGreaterThan(brandSelectBox.x);
      const priceBox = (await panel
        .getByRole("spinbutton", { name: "판매가", exact: false })
        .boundingBox())!;
      const stockBox = (await panel
        .getByRole("spinbutton", { name: /재고/ })
        .boundingBox())!;
      const optionBox = (await panel
        .getByRole("textbox", { name: "사이즈 / 옵션", exact: false })
        .boundingBox())!;
      expect(Math.abs(priceBox.y - stockBox.y)).toBeLessThanOrEqual(2);
      expect(Math.abs(priceBox.y - optionBox.y)).toBeLessThanOrEqual(2);
      expect(stockBox.x).toBeGreaterThan(priceBox.x);
      expect(optionBox.x).toBeGreaterThan(stockBox.x);
      const previewBox = (await productPreview(page).boundingBox())!;
      const basicBox = (await panel
        .getByRole("group", { name: "기본 정보", exact: true })
        .boundingBox())!;
      expect(previewBox.x).toBeGreaterThanOrEqual(basicBox.x + basicBox.width);
    }
    expect(
      await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth),
    ).toBe(true);
    await page.evaluate(() => scrollTo(0, 0));
    const screenshot = testInfo.outputPath(`product-form-refinement-${width}.png`);
    await page.screenshot({ path: screenshot, fullPage: true });
    console.log(`Product form refinement screenshot: ${screenshot}`);
    if (width === 375) {
      await page.setViewportSize({ width: 320, height: 844 });
      expect(
        await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth),
      ).toBe(true);
      await expect(brandInput).toBeEditable();
      await expect(brandSelect).toBeEnabled();
    }
    expect(audit.syntheticWrites).toEqual([]);
  });
}

test("product redesign: delete actions retain readable hover and keyboard-focus contrast in both themes", async ({
  page,
}) => {
  const audit = await setup(page, { path: "/admin?section=products", products: true });
  const panel = page.locator("#admin-panel-products");
  await panel
    .getByRole("button", { name: `${products[0]!.name} 선택`, exact: true })
    .click();
  const actions = [
    panel
      .getByRole("listitem")
      .filter({ hasText: products[0]!.name })
      .getByRole("button", { name: "삭제", exact: true }),
    panel.getByRole("button", { name: "선택 삭제 (1)", exact: true }),
  ];
  for (const theme of ["light", "dark"]) {
    await page.evaluate((value) => {
      document.documentElement.dataset.theme = value;
    }, theme);
    for (const [index, action] of actions.entries()) {
      for (const state of ["hover", "focus"]) {
        await page.mouse.move(0, 0);
        if (state === "hover") await action.hover();
        else {
          await action.focus();
          await page.keyboard.press("Tab");
          await page.keyboard.press("Shift+Tab");
          await expect(action).toBeFocused();
          await expect
            .poll(() => action.evaluate((element) => element.matches(":focus-visible")))
            .toBe(true);
        }
        const contrast = await action.evaluate((element) => {
          const canvas = document.createElement("canvas");
          canvas.width = canvas.height = 1;
          const context = canvas.getContext("2d")!;
          const rgba = (value: string) => {
            context.clearRect(0, 0, 1, 1);
            context.fillStyle = value;
            context.fillRect(0, 0, 1, 1);
            return [...context.getImageData(0, 0, 1, 1).data];
          };
          const ancestors: Element[] = [];
          for (let node: Element | null = element; node; node = node.parentElement)
            ancestors.unshift(node);
          let background = [255, 255, 255];
          for (const ancestor of ancestors) {
            const [red, green, blue, alpha] = rgba(
              getComputedStyle(ancestor).backgroundColor,
            );
            background = [red, green, blue].map(
              (channel, index) =>
                channel * (alpha / 255) + background[index] * (1 - alpha / 255),
            );
          }
          const style = getComputedStyle(element);
          const foreground = rgba(style.color).slice(0, 3);
          const luminance = (rgb: readonly number[]) => {
            const [red, green, blue] = rgb.map((value) => {
              const channel = value / 255;
              return channel <= 0.04045
                ? channel / 12.92
                : ((channel + 0.055) / 1.055) ** 2.4;
            });
            return 0.2126 * red + 0.7152 * green + 0.0722 * blue;
          };
          const foregroundLuminance = luminance(foreground);
          const backgroundLuminance = luminance(background);
          return {
            color: style.color,
            foreground,
            background,
            ratio:
              (Math.max(foregroundLuminance, backgroundLuminance) + 0.05) /
              (Math.min(foregroundLuminance, backgroundLuminance) + 0.05),
          };
        });
        console.log(
          `Product delete contrast ${theme}/${index}/${state}: ${JSON.stringify(contrast)}`,
        );
        expect(contrast.ratio).toBeGreaterThanOrEqual(4.5);
      }
    }
  }
  expect(audit.syntheticWrites).toEqual([]);
});

const inventoryProducts = [
  { ...products[0], sku: "STOCK-A", inventoryQuantity: 10, version: 4 },
  { ...products[1], sku: "STOCK-B", inventoryQuantity: 3, version: 7 },
  {
    ...products[1],
    productId: "prd_synthetic_C",
    name: "[TEST] Stock product C",
    sku: "STOCK-C",
    inventoryQuantity: 0,
    version: 2,
  },
];

function inventoryWorkspace(page: Page) {
  return page.locator("#admin-panel-inventory");
}

async function selectInventory(page: Page, name = products[0]!.name) {
  const row = inventoryWorkspace(page).getByRole("button", {
    name: `${name} 재고 조정`,
    exact: true,
  });
  await row.click();
  await expect(row).toHaveAttribute("aria-pressed", "true");
  return page.getByRole("textbox", { name: "변경 후 재고 수량", exact: true });
}

const inventoryFilterProducts = [
  ["Deck", "NOVA", 10],
  ["Deck", "NOVA", 3],
  ["Wheels", "NOVA", 0],
  ["Trucks", "RIVER", 5],
  ["Top", "RIVER", 6],
  ["Bottoms", "NOVA", 1],
  ["Acc", "NOVA", 0],
  ["Outerwear", "TEST VERY LONG BRAND NAME FOR NARROW VIEWPORTS", 4],
  ["Other", "nova", 2],
].map(([category, brandName, inventoryQuantity], index) => ({
  ...products[0],
  productId: `prd_synthetic_filter_${index}`,
  name: `[TEST] Filter product ${index}`,
  sku: `FILTER-${index}`,
  category,
  brandName,
  inventoryQuantity,
}));

test("inventory filters: category brand search and stock intersect without reads or writes and clear independently", async ({
  page,
}, testInfo) => {
  await page.setViewportSize({ width: 1440, height: 1000 });
  const audit = await setup(page, {
    path: "/admin?section=inventory",
    catalogProducts: inventoryFilterProducts,
  });
  const workspace = inventoryWorkspace(page);
  const rows = workspace.getByRole("button", { name: / 재고 조정$/ });
  const search = workspace.getByRole("searchbox", { name: "상품 검색", exact: true });
  const category = workspace.getByRole("combobox", { name: "카테고리", exact: true });
  const brand = workspace.getByRole("combobox", { name: "브랜드", exact: true });
  const stock = workspace.getByRole("combobox", { name: "재고", exact: true });
  const readsBefore = audit.reads.length;
  await expect(rows).toHaveCount(9);
  await expect(brand.getByRole("option", { name: "NOVA", exact: true })).toHaveCount(1);
  await expect(brand.getByRole("option", { name: "nova", exact: true })).toHaveCount(1);
  await category.selectOption("Deck");
  await expect(rows).toHaveCount(2);
  await brand.selectOption("NOVA");
  await stock.selectOption("low");
  await expect(rows).toHaveCount(1);
  await expect(rows).toHaveAccessibleName("[TEST] Filter product 1 재고 조정");
  await search.fill("filter-0");
  await expect(rows).toHaveCount(0);
  await expect(
    workspace.getByText("표시할 상품이 없습니다", { exact: true }),
  ).toBeVisible();
  await search.fill("FILTER-1");
  await expect(rows).toHaveCount(1);
  await search.fill("");
  await brand.selectOption("RIVER");
  await expect(rows).toHaveCount(0);
  await category.selectOption("Trucks");
  await expect(rows).toHaveCount(1);
  await stock.selectOption("soldOut");
  await expect(rows).toHaveCount(0);
  await stock.selectOption("all");
  await expect(rows).toHaveCount(1);
  await brand.selectOption("");
  await category.selectOption("");
  await expect(rows).toHaveCount(9);
  await brand.selectOption("nova");
  await expect(rows).toHaveCount(1);
  await expect(rows).toHaveAccessibleName("[TEST] Filter product 8 재고 조정");
  await brand.selectOption("");
  await search.focus();
  await search.press("Tab");
  await expect(category).toBeFocused();
  await category.press("Tab");
  await expect(brand).toBeFocused();
  await brand.press("Tab");
  await expect(stock).toBeFocused();
  const bounds = await Promise.all(
    [search, category, brand, stock].map((control) => control.boundingBox()),
  );
  expect(bounds[0]!.width).toBeLessThanOrEqual(352);
  for (let index = 1; index < bounds.length; index += 1) {
    expect(bounds[index]!.x).toBeGreaterThan(bounds[index - 1]!.x);
    expect(bounds[index]!.y).toBe(bounds[0]!.y);
  }
  const screenshot = testInfo.outputPath("inventory-filters-desktop-1440.png");
  await page.screenshot({ path: screenshot });
  console.log(`Inventory filter desktop screenshot: ${screenshot}`);
  expect(audit.reads).toHaveLength(readsBefore);
  expect(audit.syntheticWrites).toEqual([]);
});

test("inventory filters: legacy categories stay selectable and filtering never retargets an existing stock draft", async ({
  page,
}) => {
  const audit = await setup(page, {
    path: "/admin?section=inventory",
    catalogProducts: inventoryFilterProducts,
  });
  const workspace = inventoryWorkspace(page);
  const category = workspace.getByRole("combobox", { name: "카테고리", exact: true });
  const rows = workspace.getByRole("button", { name: / 재고 조정$/ });
  const input = await selectInventory(page, "[TEST] Filter product 0");
  await input.fill("12");
  for (const [value, index] of [
    ["Bottoms", 5],
    ["Acc", 6],
    ["Top", 4],
    ["Wheels", 2],
  ] as const) {
    await category.selectOption(value);
    await expect(rows).toHaveCount(1);
    await expect(rows).toHaveAccessibleName(`[TEST] Filter product ${index} 재고 조정`);
    await expect(input).toHaveValue("12");
    await expect(workspace.locator("#inventory-adjustment-title")).toHaveAttribute(
      "data-product-id",
      "prd_synthetic_filter_0",
    );
  }
  await category.selectOption("");
  await expect(rows).toHaveCount(9);
  await expect(
    workspace.getByRole("button", {
      name: "[TEST] Filter product 0 재고 조정",
      exact: true,
    }),
  ).toHaveAttribute("aria-pressed", "true");
  expect(audit.syntheticWrites).toEqual([]);
});

test("inventory filters: refresh preserves an explicit no-match filter rather than displaying all with stale hidden state", async ({
  page,
}) => {
  let current = inventoryFilterProducts;
  const audit = await setup(page, {
    path: "/admin?section=inventory",
    handleCatalog: (route) => respond(route, { products: current }),
  });
  const workspace = inventoryWorkspace(page);
  const category = workspace.getByRole("combobox", { name: "카테고리", exact: true });
  const brand = workspace.getByRole("combobox", { name: "브랜드", exact: true });
  await category.selectOption("Bottoms");
  await brand.selectOption("NOVA");
  const readsBefore = audit.reads.filter(
    (path) => path === "/prod/admin/catalog/products",
  ).length;
  current = inventoryFilterProducts.filter((product) => product.brandName === "RIVER");
  await workspace.getByRole("button", { name: "새로고침", exact: true }).click();
  await expect
    .poll(
      () =>
        audit.reads.filter((path) => path === "/prod/admin/catalog/products").length,
    )
    .toBe(readsBefore + 1);
  await expect(category).toHaveValue("Bottoms");
  await expect(brand).toHaveValue("NOVA");
  await expect(workspace.getByRole("button", { name: / 재고 조정$/ })).toHaveCount(0);
  await category.selectOption("");
  await brand.selectOption("");
  await expect(workspace.getByRole("button", { name: / 재고 조정$/ })).toHaveCount(2);
  expect(audit.syntheticWrites).toEqual([]);
});

test("inventory filters: long brands and category controls fit mobile 375 and 320 with 44px targets and no stock writes", async ({
  page,
}, testInfo) => {
  await page.setViewportSize({ width: 375, height: 844 });
  const audit = await setup(page, {
    path: "/admin?section=inventory",
    catalogProducts: inventoryFilterProducts,
  });
  const workspace = inventoryWorkspace(page);
  const category = workspace.getByRole("combobox", { name: "카테고리", exact: true });
  const brand = workspace.getByRole("combobox", { name: "브랜드", exact: true });
  const stock = workspace.getByRole("combobox", { name: "재고", exact: true });
  await category.selectOption("Outerwear");
  await brand.selectOption("TEST VERY LONG BRAND NAME FOR NARROW VIEWPORTS");
  await stock.selectOption("low");
  await expect(workspace.getByRole("button", { name: / 재고 조정$/ })).toHaveCount(1);
  for (const width of [375, 320]) {
    await page.setViewportSize({ width, height: 844 });
    for (const control of [
      category,
      brand,
      stock,
      workspace.getByRole("searchbox", { name: "상품 검색", exact: true }),
    ]) {
      const bounds = await control.boundingBox();
      expect(bounds!.width).toBeGreaterThanOrEqual(44);
      expect(bounds!.height).toBeGreaterThanOrEqual(44);
      expect(bounds!.x).toBeGreaterThanOrEqual(0);
      expect(bounds!.x + bounds!.width).toBeLessThanOrEqual(width);
    }
    expect(
      await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth),
    ).toBe(true);
    const screenshot = testInfo.outputPath(`inventory-filters-mobile-${width}.png`);
    await page.screenshot({ path: screenshot });
    console.log(`Inventory filter mobile screenshot: ${screenshot}`);
  }
  expect(audit.syntheticWrites).toEqual([]);
});

test("inventory redesign: stock edits steppers blur and Enter are previews until one confirmed canonical PATCH", async ({
  page,
}, testInfo) => {
  await page.setViewportSize({ width: 1440, height: 1000 });
  const commands: Record<string, unknown>[] = [];
  let current = { ...inventoryProducts[0] };
  const audit = await setup(page, {
    path: "/admin?section=inventory",
    handleCatalog: (route) =>
      respond(route, { products: [current, ...inventoryProducts.slice(1)] }),
    handleProductMutation: async (route) => {
      expect(route.request().method()).toBe("PATCH");
      expect(route.request().headers().authorization).toMatch(/^Bearer /);
      const command = route.request().postDataJSON() as Record<string, unknown>;
      commands.push(command);
      current = {
        ...current,
        inventoryQuantity: Number(command.stock),
        version: current.version + 1,
      };
      await respond(route, { product: current });
    },
  });
  const input = await selectInventory(page);
  await input.fill("12");
  await input.press("Tab");
  await input.press("Enter");
  await page.getByRole("button", { name: "재고 1개 증가", exact: true }).click();
  await expect(input).toHaveValue("13");
  expect(commands).toEqual([]);
  const workspace = inventoryWorkspace(page);
  await expect(workspace).toContainText("+3");
  await expect(workspace.getByText("아직 미반영", { exact: false })).toBeVisible();
  await page.evaluate(() => scrollTo(0, 0));
  const screenshot = testInfo.outputPath("inventory-redesign-desktop-1440.png");
  await page.screenshot({ path: screenshot });
  console.log(`Inventory redesign desktop screenshot: ${screenshot}`);
  const confirm = page.getByRole("button", {
    name: "재고 변경 내용 확인",
    exact: true,
  });
  page.once("dialog", (dialog) => void dialog.dismiss());
  await confirm.click();
  expect(commands).toEqual([]);
  await expect(input).toHaveValue("13");
  page.once("dialog", (dialog) => {
    expect(dialog.message()).toContain("10");
    expect(dialog.message()).toContain("13");
    void dialog.accept();
  });
  await confirm.click();
  await expect.poll(() => commands.length).toBe(1);
  expect(commands[0]).toEqual({ version: 4, stock: 13 });
  await expect(input).toHaveValue("13");
  await expect(
    workspace.getByRole("status").filter({ hasText: "13개로 저장" }),
  ).toBeVisible();
  expect(audit.syntheticWrites).toEqual([
    "PATCH https://api.sales.test/prod/admin/catalog/products/prd_synthetic_A",
  ]);
  expect(
    await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth),
  ).toBe(true);
});

test("inventory redesign: malformed or out-of-range quantities stay editable without writes and boundaries remain explicit", async ({
  page,
}) => {
  const audit = await setup(page, {
    path: "/admin?section=inventory",
    catalogProducts: inventoryProducts,
  });
  const input = await selectInventory(page);
  const confirm = page.getByRole("button", {
    name: "재고 변경 내용 확인",
    exact: true,
  });
  for (const invalid of ["", " ", "-3", "1.5", "1e3", "abc", "1,000", "1000001"]) {
    await input.fill(invalid);
    await input.press("Tab");
    await expect(confirm).toBeDisabled();
    expect(audit.syntheticWrites).toEqual([]);
  }
  await input.fill("0");
  await expect(confirm).toBeEnabled();
  await expect(
    page.getByRole("button", { name: "재고 1개 감소", exact: true }),
  ).toBeDisabled();
  await input.fill("1000000");
  await expect(confirm).toBeEnabled();
  await expect(
    page.getByRole("button", { name: "재고 1개 증가", exact: true }),
  ).toBeDisabled();
  await input.fill("10");
  await expect(confirm).toBeDisabled();
  expect(audit.syntheticWrites).toEqual([]);
});

test("inventory redesign: SKU and stock filters keyboard row selection preserve correct product targeting", async ({
  page,
}) => {
  const audit = await setup(page, {
    path: "/admin?section=inventory",
    catalogProducts: inventoryProducts,
  });
  const workspace = inventoryWorkspace(page);
  await workspace
    .getByRole("searchbox", { name: "상품 검색", exact: true })
    .fill("STOCK-B");
  await expect(workspace.getByRole("button", { name: / 재고 조정$/ })).toHaveCount(1);
  const item = workspace.getByRole("button", {
    name: `${products[1]!.name} 재고 조정`,
    exact: true,
  });
  await item.focus();
  await item.press("Enter");
  await expect(item).toHaveAttribute("aria-pressed", "true");
  await expect(
    page.getByRole("textbox", { name: "변경 후 재고 수량", exact: true }),
  ).toHaveValue("3");
  await workspace.getByRole("searchbox", { name: "상품 검색", exact: true }).fill("");
  const filter = workspace.getByRole("combobox", { name: "재고", exact: true });
  await filter.selectOption("low");
  await expect(workspace.getByRole("button", { name: / 재고 조정$/ })).toHaveCount(1);
  await expect(item).toBeVisible();
  await filter.selectOption("soldOut");
  await expect(workspace.getByRole("button", { name: / 재고 조정$/ })).toHaveCount(1);
  await expect(
    workspace.getByRole("button", {
      name: "[TEST] Stock product C 재고 조정",
      exact: true,
    }),
  ).toBeVisible();
  expect(audit.syntheticWrites).toEqual([]);
});

test("inventory redesign: refresh locks changes and a new server version requires an explicit fresh draft", async ({
  page,
}) => {
  let release!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  let refreshArmed = false;
  const commands: Record<string, unknown>[] = [];
  let current = { ...inventoryProducts[0] };
  const audit = await setup(page, {
    path: "/admin?section=inventory",
    handleCatalog: async (route) => {
      if (refreshArmed) {
        refreshArmed = false;
        await gate;
        current = { ...current, inventoryQuantity: 20, version: 5 };
      }
      await respond(route, { products: [current] });
    },
    handleProductMutation: async (route) => {
      const command = route.request().postDataJSON() as Record<string, unknown>;
      commands.push(command);
      current = {
        ...current,
        inventoryQuantity: Number(command.stock),
        version: current.version + 1,
      };
      await respond(route, { product: current });
    },
  });
  const input = await selectInventory(page);
  await input.fill("13");
  refreshArmed = true;
  await inventoryWorkspace(page)
    .getByRole("button", { name: "새로고침", exact: true })
    .click();
  const confirm = page.getByRole("button", {
    name: "재고 변경 내용 확인",
    exact: true,
  });
  try {
    await expect(confirm).toBeDisabled();
    expect(commands).toEqual([]);
  } finally {
    release();
  }
  const reset = page.getByRole("button", {
    name: "최신 재고로 다시 시작",
    exact: true,
  });
  await expect(inventoryWorkspace(page).getByRole("status")).toHaveText(
    "최신 재고 확인 필요",
  );
  await expect(reset).toBeVisible();
  await expect(confirm).toBeDisabled();
  await expect(input).toHaveValue("13");
  expect(commands).toEqual([]);
  await reset.click();
  await expect(input).toHaveValue("20");
  await page.getByRole("button", { name: "재고 1개 증가", exact: true }).click();
  page.once("dialog", (dialog) => void dialog.accept());
  await confirm.click();
  await expect.poll(() => commands.length).toBe(1);
  expect(commands[0]).toEqual({ version: 5, stock: 21 });
  expect(audit.syntheticWrites).toHaveLength(1);
});

test("inventory redesign: a stock conflict reloads canonical stock and cannot silently resend the stale draft", async ({
  page,
}) => {
  let current = { ...inventoryProducts[0] };
  const commands: Record<string, unknown>[] = [];
  const audit = await setup(page, {
    path: "/admin?section=inventory",
    handleCatalog: (route) => respond(route, { products: [current] }),
    handleProductMutation: async (route) => {
      commands.push(route.request().postDataJSON() as Record<string, unknown>);
      current = { ...current, inventoryQuantity: 8, version: 5 };
      await route.fulfill({
        status: 409,
        json: { code: "CATALOG_VERSION_CONFLICT" },
        headers: { "access-control-allow-origin": "*" },
      });
    },
  });
  const input = await selectInventory(page);
  await input.fill("13");
  page.once("dialog", (dialog) => void dialog.accept());
  const confirm = page.getByRole("button", {
    name: "재고 변경 내용 확인",
    exact: true,
  });
  await confirm.click();
  await expect
    .poll(
      () =>
        audit.reads.filter((path) => path === "/prod/admin/catalog/products").length,
    )
    .toBe(2);
  await expect(inventoryWorkspace(page).getByRole("alert").first()).toBeVisible();
  await expect(
    page.getByRole("button", { name: "최신 재고로 다시 시작", exact: true }),
  ).toBeVisible();
  await expect(confirm).toBeDisabled();
  expect(commands).toEqual([{ version: 4, stock: 13 }]);
  expect(audit.syntheticWrites).toHaveLength(1);
});

test("inventory redesign: an in-flight write locks duplicate submissions and unknown results are not reported as success", async ({
  page,
}) => {
  let release!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const commands: Record<string, unknown>[] = [];
  const audit = await setup(page, {
    path: "/admin?section=inventory",
    catalogProducts: inventoryProducts,
    handleProductMutation: async (route) => {
      commands.push(route.request().postDataJSON() as Record<string, unknown>);
      await gate;
      await route.fulfill({
        status: 503,
        json: { code: "SYNTHETIC_RESULT_UNKNOWN" },
        headers: { "access-control-allow-origin": "*" },
      });
    },
  });
  const input = await selectInventory(page);
  await input.fill("13");
  page.once("dialog", (dialog) => void dialog.accept());
  const confirm = page.getByRole("button", {
    name: /^(?:재고 변경 내용 확인|저장 중…)$/,
  });
  await confirm.click();
  await expect.poll(() => commands.length).toBe(1);
  try {
    await expect(confirm).toBeDisabled();
    await expect(input).toBeDisabled();
    await expect(
      page.getByRole("button", { name: "재고 1개 증가", exact: true }),
    ).toBeDisabled();
    await confirm.evaluate((button: HTMLButtonElement) => {
      button.click();
      button.click();
    });
    expect(commands).toHaveLength(1);
  } finally {
    release();
  }
  await expect(inventoryWorkspace(page).getByRole("alert").first()).toBeVisible();
  await expect(
    inventoryWorkspace(page)
      .getByRole("status")
      .filter({ hasText: /저장 완료|개로 저장했습니다/ }),
  ).toHaveCount(0);
  expect(commands).toEqual([{ version: 4, stock: 13 }]);
  expect(audit.syntheticWrites).toHaveLength(1);
});

test("inventory redesign: a noncanonical response is rejected and refreshed instead of displaying a fabricated saved result", async ({
  page,
}) => {
  const audit = await setup(page, {
    path: "/admin?section=inventory",
    catalogProducts: inventoryProducts,
    handleProductMutation: (route) =>
      respond(route, {
        product: { ...inventoryProducts[0], inventoryQuantity: 12, version: 5 },
      }),
  });
  const input = await selectInventory(page);
  await input.fill("13");
  page.once("dialog", (dialog) => void dialog.accept());
  await page.getByRole("button", { name: "재고 변경 내용 확인", exact: true }).click();
  await expect
    .poll(
      () =>
        audit.reads.filter((path) => path === "/prod/admin/catalog/products").length,
    )
    .toBe(2);
  await expect(inventoryWorkspace(page).getByRole("alert").first()).toBeVisible();
  await expect(
    inventoryWorkspace(page)
      .getByRole("status")
      .filter({ hasText: /저장 완료|개로 저장했습니다/ }),
  ).toHaveCount(0);
  expect(audit.syntheticWrites).toHaveLength(1);
});

test("inventory redesign: mobile selection preview and controls reflow at 375 and 320 CSS pixels without stock writes", async ({
  page,
}, testInfo) => {
  await page.setViewportSize({ width: 375, height: 844 });
  const audit = await setup(page, {
    path: "/admin?section=inventory",
    catalogProducts: inventoryProducts,
  });
  const row = inventoryWorkspace(page).getByRole("button", {
    name: `${products[0]!.name} 재고 조정`,
    exact: true,
  });
  await row.focus();
  await row.press("Enter");
  const input = page.getByRole("textbox", { name: "변경 후 재고 수량", exact: true });
  const heading = inventoryWorkspace(page).getByRole("heading", {
    name: "재고 조정",
    exact: true,
  });
  await expect(heading).toBeFocused();
  const headingBounds = await heading.boundingBox();
  expect(headingBounds!.y).toBeGreaterThanOrEqual(0);
  expect(headingBounds!.y + headingBounds!.height).toBeLessThanOrEqual(844);
  await page.keyboard.press("Tab");
  await expect(
    page.getByRole("button", { name: "재고 1개 감소", exact: true }),
  ).toBeFocused();
  await input.fill("13");
  for (const name of ["재고 1개 감소", "재고 1개 증가"]) {
    const bounds = await page.getByRole("button", { name, exact: true }).boundingBox();
    expect(bounds!.width).toBeGreaterThanOrEqual(44);
    expect(bounds!.height).toBeGreaterThanOrEqual(44);
  }
  expect(
    await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth),
  ).toBe(true);
  const screenshot = testInfo.outputPath("inventory-redesign-mobile-375.png");
  await page.screenshot({ path: screenshot });
  console.log(`Inventory redesign mobile screenshot: ${screenshot}`);
  await page.setViewportSize({ width: 320, height: 844 });
  expect(
    await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth),
  ).toBe(true);
  expect(audit.syntheticWrites).toEqual([]);
});

test("inventory redesign: failed stock write plus unavailable reload keeps the result uncertain and blocks a stale retry", async ({
  page,
}) => {
  let reads = 0;
  let rejectReads = false;
  const audit = await setup(page, {
    path: "/admin?section=inventory",
    handleCatalog: (route) => {
      reads += 1;
      return !rejectReads
        ? respond(route, { products: inventoryProducts })
        : route.fulfill({
            status: 503,
            json: { code: "SYNTHETIC_READ_UNAVAILABLE" },
            headers: { "access-control-allow-origin": "*" },
          });
    },
    handleProductMutation: (route) =>
      route.fulfill({
        status: 503,
        json: { code: "SYNTHETIC_WRITE_UNKNOWN" },
        headers: { "access-control-allow-origin": "*" },
      }),
  });
  const input = await selectInventory(page);
  await input.fill("13");
  const readsBeforeWrite = reads;
  rejectReads = true;
  page.once("dialog", (dialog) => void dialog.accept());
  const confirm = page.getByRole("button", {
    name: "재고 변경 내용 확인",
    exact: true,
  });
  await confirm.click();
  await expect(
    inventoryWorkspace(page)
      .getByRole("alert")
      .filter({ hasText: "중복 저장하지 말고" }),
  ).toBeVisible();
  await expect(confirm).toBeDisabled();
  await expect(input).toHaveValue("13");
  await page
    .getByRole("button", { name: "최신 재고로 다시 시작", exact: true })
    .click();
  await expect.poll(() => reads).toBe(readsBeforeWrite + 2);
  await expect(confirm).toBeDisabled();
  await expect(
    inventoryWorkspace(page)
      .getByRole("alert")
      .filter({ hasText: "최신 재고를 불러오지 못했습니다" }),
  ).toBeVisible();
  expect(audit.syntheticWrites).toEqual([
    "PATCH https://api.sales.test/prod/admin/catalog/products/prd_synthetic_A",
  ]);
});

const brandProducts = [
  { ...products[0], brandName: "TEST" },
  { ...products[1], brandName: " test " },
  { ...products[1], productId: "prd_synthetic_C", brandName: "RIVER" },
];
const brandWorkspace = (page: Page) => page.locator("#admin-panel-brands");
const brandNameInput = (page: Page) =>
  brandWorkspace(page).getByRole("textbox", { name: "브랜드명 (필수)", exact: true });
const brandTable = (page: Page) =>
  brandWorkspace(page).getByRole("table", {
    name: "브랜드별 이 화면 상품 연결",
    exact: true,
  });
const brandRow = (page: Page, name: string) =>
  brandTable(page)
    .getByRole("row")
    .filter({ has: page.getByText(name, { exact: true }) });

async function savedBrand(route: Route, name: string) {
  await respond(
    route,
    {
      record: {
        brandId: "br_synthetic_registered",
        name,
        slug: name.toLowerCase().replaceAll(" ", "-"),
        status: "ACTIVE",
        version: 1,
        createdAt: `${DAY}T14:00:00.000Z`,
        updatedAt: `${DAY}T14:00:00.000Z`,
      },
    },
    201,
  );
}

test("brand redesign: only observed catalog brands are grouped searched and filtered with keyboard controls", async ({
  page,
}, testInfo) => {
  await page.setViewportSize({ width: 1440, height: 1000 });
  const audit = await setup(page, {
    path: "/admin?section=brands",
    catalogProducts: brandProducts,
  });
  const panel = brandWorkspace(page);
  await expect(
    panel.getByRole("heading", { name: "브랜드 관리", exact: true }),
  ).toBeVisible();
  await expect(brandTable(page).getByRole("row")).toHaveCount(3);
  await expect(brandRow(page, "TEST").getByRole("cell").first()).toContainText("2개");
  await expect(brandRow(page, "RIVER").getByRole("cell").first()).toContainText("1개");
  await expect(brandRow(page, "TEST")).toContainText("상품에서 확인");
  await expect(
    panel.getByRole("button", { name: "전체 2", exact: true }),
  ).toHaveAttribute("aria-pressed", "true");
  await expect(
    panel.getByRole("button", { name: "상품 연결 2", exact: true }),
  ).toBeVisible();
  const search = panel.getByRole("searchbox", { name: "브랜드명 검색", exact: true });
  await search.fill("  rIv  ");
  await expect(brandTable(page).getByRole("row")).toHaveCount(2);
  await expect(brandRow(page, "RIVER")).toBeVisible();
  await search.fill("");
  const unlinked = panel.getByRole("button", { name: "연결 없음 0", exact: true });
  await unlinked.focus();
  await page.keyboard.press("Space");
  await expect(unlinked).toHaveAttribute("aria-pressed", "true");
  await expect(
    panel.getByText("조건에 맞는 브랜드가 없습니다", { exact: true }),
  ).toBeVisible();
  await panel.getByRole("button", { name: "전체 2", exact: true }).focus();
  await page.keyboard.press("Enter");
  await expect(brandRow(page, "TEST")).toBeVisible();
  await panel.getByText("도움말", { exact: true }).click();
  await expect(
    panel.getByText(/연결이 없어도 비활성 브랜드를 뜻하지 않습니다/),
  ).toBeVisible();
  await expect(
    panel.getByText(/전체 브랜드 목록이나 서버의 활성 상태를 조회하는 화면은 아닙니다/),
  ).toBeVisible();
  await panel.getByText("도움말", { exact: true }).click();
  const catalogBox = await panel
    .getByRole("region", { name: "이 화면에서 확인한 브랜드", exact: true })
    .boundingBox();
  const formBox = await brandNameInput(page)
    .locator("xpath=ancestor::form[1]")
    .boundingBox();
  expect(catalogBox).not.toBeNull();
  expect(formBox).not.toBeNull();
  expect(formBox!.x).toBeGreaterThan(catalogBox!.x + catalogBox!.width - 1);
  expect(
    await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth),
  ).toBe(true);
  await page.screenshot({
    path: testInfo.outputPath("brand-redesign-desktop-1440.png"),
    fullPage: true,
  });
  expect(audit.syntheticWrites).toEqual([]);
  expect(audit.reads.filter((path) => path.includes("/admin/brands"))).toEqual([]);
});

test("brand redesign: explicit registration sends only the trimmed supported fields and does not invent inactive or draft status", async ({
  page,
}) => {
  const commands: unknown[] = [];
  const audit = await setup(page, {
    path: "/admin?section=brands",
    catalogProducts: brandProducts,
    handleBrandMutation: async (route) => {
      const command = route.request().postDataJSON();
      commands.push(command);
      expect(route.request().headers().authorization).toMatch(/^Bearer /);
      await savedBrand(route, command.name);
    },
  });
  const panel = brandWorkspace(page);
  const memo = panel.getByRole("textbox", { name: "운영 메모 (선택)", exact: true });
  await brandNameInput(page).fill("  NOVA  ");
  await memo.fill("  Synthetic supplier note  ");
  await expect(
    panel.getByRole("region", { name: "브랜드명 표시 예시", exact: true }),
  ).toContainText("NOVA");
  expect(commands).toEqual([]);
  await panel.getByRole("button", { name: "브랜드 등록", exact: true }).click();
  await expect.poll(() => commands.length).toBe(1);
  expect(commands[0]).toEqual({ name: "NOVA", memo: "Synthetic supplier note" });
  await expect(panel.getByRole("status")).toContainText("브랜드를 서버에 등록했습니다");
  await expect(brandNameInput(page)).toHaveValue("");
  await expect(memo).toHaveValue("");
  await expect(brandRow(page, "NOVA")).toContainText("0개");
  await expect(brandRow(page, "NOVA")).toContainText("연결 없음");
  await expect(brandRow(page, "NOVA")).toContainText("이 화면에서 추가");
  await expect(brandRow(page, "NOVA")).not.toContainText(/비활성|초안|저장 대기/);
  await panel.getByRole("button", { name: "연결 없음 1", exact: true }).click();
  await expect(brandTable(page).getByRole("row")).toHaveCount(2);
  await brandNameInput(page).fill("EMPTY MEMO");
  await panel.getByRole("button", { name: "브랜드 등록", exact: true }).click();
  await expect.poll(() => commands.length).toBe(2);
  expect(commands[1]).toEqual({ name: "EMPTY MEMO" });
  await brandNameInput(page).fill(" nova ");
  await panel.getByRole("button", { name: "브랜드 등록", exact: true }).click();
  await expect(panel.getByRole("alert")).toContainText(
    "이미 이 화면의 목록에 있는 브랜드명입니다",
  );
  await brandNameInput(page).fill(" test ");
  await panel.getByRole("button", { name: "브랜드 등록", exact: true }).click();
  await expect(panel.getByRole("alert")).toContainText(
    "이미 이 화면의 목록에 있는 브랜드명입니다",
  );
  expect(commands).toHaveLength(2);
  expect(audit.syntheticWrites).toEqual(
    Array(2).fill("POST https://api.sales.test/prod/admin/brands"),
  );
});

test("brand redesign: pending registration locks fields and coalesces repeated submits into one request", async ({
  page,
}) => {
  let release!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const commands: unknown[] = [];
  const audit = await setup(page, {
    path: "/admin?section=brands",
    handleBrandMutation: async (route) => {
      commands.push(route.request().postDataJSON());
      await gate;
      await savedBrand(route, "NOVA");
    },
  });
  const panel = brandWorkspace(page);
  await brandNameInput(page).fill("NOVA");
  try {
    await brandNameInput(page)
      .locator("xpath=ancestor::form[1]")
      .evaluate((form: HTMLFormElement) => {
        form.requestSubmit();
        form.requestSubmit();
      });
    await expect.poll(() => commands.length).toBe(1);
    await expect(brandNameInput(page)).toBeDisabled();
    await expect(
      panel.getByRole("textbox", { name: "운영 메모 (선택)", exact: true }),
    ).toBeDisabled();
    await expect(
      panel.getByRole("button", { name: "등록 중…", exact: true }),
    ).toBeDisabled();
    await expect(
      panel.getByRole("button", { name: "입력 지우기", exact: true }),
    ).toBeDisabled();
  } finally {
    release();
  }
  await expect(brandRow(page, "NOVA")).toBeVisible();
  await expect(brandNameInput(page)).toBeEnabled();
  expect(commands).toEqual([{ name: "NOVA" }]);
  expect(audit.syntheticWrites).toEqual([
    "POST https://api.sales.test/prod/admin/brands",
  ]);
});

test("brand redesign: failed registration preserves the inputs and never falls back to a claimed server save", async ({
  page,
}) => {
  const audit = await setup(page, {
    path: "/admin?section=brands",
    handleBrandMutation: (route) =>
      respond(route, { code: "SYNTHETIC_BRAND_UNAVAILABLE" }, 503),
  });
  const panel = brandWorkspace(page);
  await brandNameInput(page).fill("NOVA");
  await panel
    .getByRole("textbox", { name: "운영 메모 (선택)", exact: true })
    .fill("Retain this synthetic note");
  await panel.getByRole("button", { name: "브랜드 등록", exact: true }).click();
  await expect(panel.getByRole("alert")).toContainText(
    "브랜드 등록 결과를 확인하지 못했습니다",
  );
  await expect(panel.getByRole("alert")).toContainText("서버의 처리 결과를 확인");
  await expect(brandNameInput(page)).toHaveValue("NOVA");
  await expect(
    panel.getByRole("textbox", { name: "운영 메모 (선택)", exact: true }),
  ).toHaveValue("Retain this synthetic note");
  await expect(brandNameInput(page)).toBeEnabled();
  await expect(brandTable(page)).toHaveCount(0);
  await expect(panel.getByRole("status")).toHaveCount(0);
  await expect(
    panel.getByRole("button", { name: "이 화면에 임시 추가", exact: true }),
  ).toHaveCount(0);
  await expect(
    panel.getByRole("button", { name: "브랜드 등록", exact: true }),
  ).toBeEnabled();
  expect(audit.syntheticWrites).toEqual([
    "POST https://api.sales.test/prod/admin/brands",
  ]);
});

test("brand redesign: empty catalog shows no invented brands and blank submission does not write", async ({
  page,
}) => {
  const audit = await setup(page, { path: "/admin?section=brands" });
  const panel = brandWorkspace(page);
  await expect(
    panel.getByText("현재 이 화면에 표시할 브랜드가 없습니다", { exact: true }),
  ).toBeVisible();
  await expect(
    panel.getByRole("button", { name: "전체 0", exact: true }),
  ).toBeVisible();
  await brandNameInput(page).fill("  ");
  await panel.getByRole("button", { name: "브랜드 등록", exact: true }).click();
  await expect(panel.getByRole("alert")).toContainText("브랜드명을 입력해 주세요");
  await expect(brandNameInput(page)).toHaveAttribute("maxlength", "100");
  await expect(
    panel.getByRole("textbox", { name: "운영 메모 (선택)", exact: true }),
  ).toHaveAttribute("maxlength", "1000");
  expect(audit.syntheticWrites).toEqual([]);
});

test("brand redesign: failed catalog states that connected counts are incomplete instead of asserting a full brand directory", async ({
  page,
}) => {
  const audit = await setup(page, {
    path: "/admin?section=brands",
    handleCatalog: (route) =>
      respond(route, { code: "SYNTHETIC_CATALOG_UNAVAILABLE" }, 503),
  });
  const panel = brandWorkspace(page);
  await expect(panel.getByRole("alert")).toContainText("전체 수량이 아닙니다");
  await expect(brandTable(page)).toHaveCount(0);
  await expect(
    panel.getByRole("button", { name: "전체 —", exact: true }),
  ).toBeVisible();
  await expect(
    panel.getByText("브랜드 목록을 확인하지 못했습니다", { exact: true }),
  ).toBeVisible();
  await expect(
    panel.getByText(/조회 실패는 브랜드가 없다는 뜻이 아닙니다/),
  ).toBeVisible();
  await expect(panel.getByRole("button", { name: "전체 0", exact: true })).toHaveCount(
    0,
  );
  expect(audit.syntheticWrites).toEqual([]);
});

test("brand redesign: an in-flight catalog does not present missing counts as confirmed zero", async ({
  page,
}) => {
  let release!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const audit = await setup(page, {
    path: "/admin?section=brands",
    waitForIdle: false,
    handleCatalog: async (route) => {
      await gate;
      await respond(route, { products: brandProducts });
    },
  });
  const panel = brandWorkspace(page);
  try {
    await expect(
      panel.getByText("상품의 브랜드를 불러오고 있습니다", { exact: true }),
    ).toBeVisible();
    for (const prefix of ["전체", "상품 연결", "연결 없음"])
      await expect(
        panel.getByRole("button", { name: `${prefix} —`, exact: true }),
      ).toBeVisible();
    await expect(
      panel.getByRole("button", { name: "전체 0", exact: true }),
    ).toHaveCount(0);
    await expect(brandTable(page)).toHaveCount(0);
  } finally {
    release();
  }
  await expect(brandRow(page, "TEST")).toBeVisible();
  await expect(
    panel.getByRole("button", { name: "전체 2", exact: true }),
  ).toBeVisible();
  expect(audit.syntheticWrites).toEqual([]);
});

test("brand redesign: mobile search filters and add form fit 375 and 320 pixels with 44-pixel controls", async ({
  page,
}, testInfo) => {
  await page.setViewportSize({ width: 375, height: 900 });
  const audit = await setup(page, {
    path: "/admin?section=brands",
    catalogProducts: brandProducts,
  });
  const panel = brandWorkspace(page);
  await brandNameInput(page).fill(`SYNTHETIC_${"LONG_BRAND_".repeat(6)}`);
  await panel
    .getByRole("textbox", { name: "운영 메모 (선택)", exact: true })
    .fill("Synthetic note: no actual registration");
  for (const width of [375, 320]) {
    await page.setViewportSize({ width, height: 900 });
    expect(
      await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth),
    ).toBe(true);
    for (const name of [
      "전체 2",
      "상품 연결 2",
      "연결 없음 0",
      "브랜드 등록",
      "입력 지우기",
    ])
      expect(
        (await panel.getByRole("button", { name, exact: true }).boundingBox())?.height,
      ).toBeGreaterThanOrEqual(44);
    for (const control of [
      panel.getByRole("searchbox", { name: "브랜드명 검색", exact: true }),
      brandNameInput(page),
    ])
      expect((await control.boundingBox())?.height).toBeGreaterThanOrEqual(44);
    await page.screenshot({
      path: testInfo.outputPath(`brand-redesign-mobile-${width}.png`),
      fullPage: true,
    });
  }
  await panel.getByRole("button", { name: "입력 지우기", exact: true }).click();
  await expect(brandNameInput(page)).toHaveValue("");
  await expect(
    panel.getByRole("textbox", { name: "운영 메모 (선택)", exact: true }),
  ).toHaveValue("");
  expect(audit.syntheticWrites).toEqual([]);
});

test("brand redesign: registration hover and keyboard focus remain readable in light and dark themes", async ({
  page,
}) => {
  const audit = await setup(page, { path: "/admin?section=brands" });
  const action = brandWorkspace(page).getByRole("button", {
    name: "브랜드 등록",
    exact: true,
  });
  for (const theme of ["light", "dark"]) {
    await page.evaluate((value) => {
      document.documentElement.dataset.theme = value;
    }, theme);
    for (const state of ["hover", "focus"]) {
      await page.mouse.move(0, 0);
      if (state === "hover") await action.hover();
      else {
        await action.focus();
        await page.keyboard.press("Tab");
        await page.keyboard.press("Shift+Tab");
        await expect(action).toBeFocused();
        await expect
          .poll(() => action.evaluate((node) => node.matches(":focus-visible")))
          .toBe(true);
      }
      const contrast = await action.evaluate((element) => {
        const canvas = document.createElement("canvas");
        canvas.width = canvas.height = 1;
        const context = canvas.getContext("2d")!;
        const rgba = (value: string) => {
          context.clearRect(0, 0, 1, 1);
          context.fillStyle = value;
          context.fillRect(0, 0, 1, 1);
          return [...context.getImageData(0, 0, 1, 1).data];
        };
        const ancestors: Element[] = [];
        for (let node: Element | null = element; node; node = node.parentElement)
          ancestors.unshift(node);
        let background = [255, 255, 255];
        for (const ancestor of ancestors) {
          const [red, green, blue, alpha] = rgba(
            getComputedStyle(ancestor).backgroundColor,
          );
          background = [red, green, blue].map(
            (channel, index) =>
              channel * (alpha / 255) + background[index] * (1 - alpha / 255),
          );
        }
        const luminance = (rgb: readonly number[]) => {
          const [red, green, blue] = rgb.map((value) => {
            const channel = value / 255;
            return channel <= 0.04045
              ? channel / 12.92
              : ((channel + 0.055) / 1.055) ** 2.4;
          });
          return 0.2126 * red + 0.7152 * green + 0.0722 * blue;
        };
        const style = getComputedStyle(element);
        const foreground = luminance(rgba(style.color).slice(0, 3));
        const behind = luminance(background);
        return (
          (Math.max(foreground, behind) + 0.05) / (Math.min(foreground, behind) + 0.05)
        );
      });
      console.log(`Brand registration contrast ${theme}/${state}: ${contrast}`);
      expect(contrast).toBeGreaterThanOrEqual(4.5);
    }
  }
  expect(audit.syntheticWrites).toEqual([]);
});

type SyntheticMember = {
  username: string;
  userSub: string;
  email: string;
  displayName: string;
  enabled: boolean;
  groups: string[];
};
const memberFixtures: SyntheticMember[] = [
  {
    username: "member+alex@example.test",
    userSub: "member-synthetic-alex",
    email: "alex@example.test",
    displayName: "[TEST] Alex",
    enabled: true,
    groups: [],
  },
  {
    username: "synthetic-support",
    userSub: "member-synthetic-support",
    email: "support@example.test",
    displayName: "[TEST] Support",
    enabled: false,
    groups: ["support"],
  },
  {
    username: "synthetic-admin",
    userSub: SUBJECT,
    email: "admin@example.test",
    displayName: "[TEST] Current admin",
    enabled: true,
    groups: ["admin"],
  },
];
type MemberFixtureState = {
  members: SyntheticMember[];
  reads: number;
  commands: Array<{ method: string; path: string; body: unknown }>;
  readFailed: boolean;
};

async function setupMembers(
  page: Page,
  options: {
    members?: SyntheticMember[];
    readGate?: Promise<void>;
    mutationGate?: Promise<void>;
    mutationFailed?: boolean;
    initiallyFailed?: boolean;
    waitForIdle?: boolean;
  } = {},
) {
  const state: MemberFixtureState = {
    members: structuredClone(options.members ?? memberFixtures),
    reads: 0,
    commands: [],
    readFailed: options.initiallyFailed ?? false,
  };
  const audit = await setup(page, {
    path: "/admin?section=members",
    waitForIdle: options.waitForIdle,
    handleMembers: async (route) => {
      state.reads += 1;
      if (options.readGate) await options.readGate;
      await respond(
        route,
        state.readFailed
          ? { code: "SYNTHETIC_MEMBER_QUERY_UNAVAILABLE" }
          : { members: state.members },
        state.readFailed ? 503 : 200,
      );
    },
    handleMemberMutation: async (route) => {
      const request = route.request();
      const path = new URL(request.url()).pathname;
      const body = request.postDataJSON();
      state.commands.push({ method: request.method(), path, body });
      expect(request.headers().authorization).toMatch(/^Bearer /);
      if (options.mutationGate) await options.mutationGate;
      if (options.mutationFailed)
        return respond(route, { code: "SYNTHETIC_MEMBER_GROUP_UNAVAILABLE" }, 503);
      const username = decodeURIComponent(path.split("/").at(-2)!);
      const member = state.members.find((item) => item.username === username)!;
      expect(["admin", "support"]).toContain(body.group);
      member.groups =
        request.method() === "POST"
          ? [...new Set([...member.groups, body.group])]
          : member.groups.filter((group) => group !== body.group);
      await respond(route, {
        username,
        group: body.group,
        action: request.method() === "POST" ? "ADDED" : "REMOVED",
      });
    },
  });
  return { state, audit };
}

const memberWorkspace = (page: Page) => page.locator("#admin-panel-members");
const loadMembers = (page: Page) =>
  memberWorkspace(page)
    .getByRole("button", { name: "회원 목록 불러오기", exact: true })
    .click();
const memberChoice = (page: Page, name = "[TEST] Alex") =>
  memberWorkspace(page).getByRole("button", { name: `${name} 회원 상세`, exact: true });
const memberDetail = (page: Page, name = "[TEST] Alex") =>
  memberWorkspace(page).getByRole("complementary", { name, exact: true });

async function prepareMemberGroup(
  page: Page,
  group: "admin" | "support",
  add: boolean,
  name = "[TEST] Alex",
) {
  const detail = memberDetail(page, name);
  await detail
    .getByRole("button", {
      name: `${group} ${add ? "부여" : "해제"} 준비`,
      exact: true,
    })
    .click();
  await expect(detail.getByLabel("권한 변경 미리보기", { exact: true })).toContainText(
    "아직 미반영",
  );
  await expect(
    detail.getByRole("button", { name: "권한 변경 내용 확인", exact: true }),
  ).toBeDisabled();
  await detail
    .getByLabel("선택한 회원과 권한 변경 내용을 확인했습니다", { exact: true })
    .check();
}

test("member redesign: member data loads only on explicit request and distinguishes pending from a successful empty response", async ({
  page,
}) => {
  let release!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const { state, audit } = await setupMembers(page, { members: [], readGate: gate });
  const panel = memberWorkspace(page);
  await expect(
    panel.getByText("회원 목록을 아직 조회하지 않았습니다", { exact: true }),
  ).toBeVisible();
  await expect(
    panel.getByRole("heading", { name: "이번 조회 회원 —", exact: true }),
  ).toBeVisible();
  await expect(
    panel.getByRole("searchbox", { name: "불러온 회원 검색", exact: true }),
  ).toBeDisabled();
  expect(state.reads).toBe(0);
  try {
    await loadMembers(page);
    await expect.poll(() => state.reads).toBe(1);
    await expect(
      panel.getByText("회원 목록을 불러오고 있습니다", { exact: true }),
    ).toBeVisible();
    await expect(
      panel.getByRole("button", { name: "회원 목록 불러오는 중…", exact: true }),
    ).toBeDisabled();
    await expect(
      panel.getByRole("heading", { name: "이번 조회 회원 —", exact: true }),
    ).toBeVisible();
  } finally {
    release();
  }
  await expect(
    panel.getByText("이번 조회에서 회원이 반환되지 않았습니다", { exact: true }),
  ).toBeVisible();
  await expect(
    panel.getByRole("heading", { name: "이번 조회 회원 0명", exact: true }),
  ).toBeVisible();
  expect(state.commands).toEqual([]);
  expect(audit.syntheticWrites).toEqual([]);
});

test("member redesign: loaded search and selected detail reveal only returned read-only facts without persisting personal fields", async ({
  page,
}, testInfo) => {
  await page.setViewportSize({ width: 1440, height: 1000 });
  const { state, audit } = await setupMembers(page);
  await loadMembers(page);
  const panel = memberWorkspace(page);
  await expect(
    panel.getByRole("heading", { name: "이번 조회 회원 3명", exact: true }),
  ).toBeVisible();
  const search = panel.getByRole("searchbox", {
    name: "불러온 회원 검색",
    exact: true,
  });
  await search.fill("  AlEx@EXAMPLE.test  ");
  await expect(panel.locator('button[aria-label$=" 회원 상세"]')).toHaveCount(1);
  await memberChoice(page).focus();
  await page.keyboard.press("Enter");
  await expect(memberChoice(page)).toHaveAttribute("aria-pressed", "true");
  const detail = memberDetail(page);
  await expect(detail).toContainText("member+alex@example.test");
  await expect(detail).toContainText("계정 상태 (읽기 전용)");
  await expect(detail).toContainText("마케팅 수신 동의");
  await expect(detail).toContainText("조회 데이터 없음");
  await expect(detail.getByRole("checkbox")).toHaveCount(0);
  await expect(
    detail.getByRole("button", { name: /활성화|비활성화|수신 동의 변경/ }),
  ).toHaveCount(0);
  await search.fill("");
  await memberChoice(page, "[TEST] Support").click();
  await expect(memberDetail(page, "[TEST] Support")).toContainText("비활성");
  await memberChoice(page).click();
  const directory = panel.getByRole("region", {
    name: "이번 조회 회원 3명",
    exact: true,
  });
  const listBox = await directory.boundingBox();
  const detailBox = await detail.boundingBox();
  expect(listBox).not.toBeNull();
  expect(detailBox).not.toBeNull();
  expect(detailBox!.x).toBeGreaterThan(listBox!.x + listBox!.width - 1);
  expect(
    await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth),
  ).toBe(true);
  await page.screenshot({
    path: testInfo.outputPath("member-redesign-desktop-1440.png"),
    fullPage: true,
  });
  const stored = await page.evaluate(() =>
    JSON.stringify({
      href: location.href,
      history: history.state,
      local: { ...localStorage },
      session: { ...sessionStorage },
    }),
  );
  expect(stored).not.toContain("alex@example.test");
  expect(stored).not.toContain("[TEST] Alex");
  expect(state.reads).toBe(1);
  expect(state.commands).toEqual([]);
  expect(audit.syntheticWrites).toEqual([]);
});

test("member redesign: group previews and cancelled confirmations write nothing while accepted changes use the existing encoded POST and DELETE contract", async ({
  page,
}) => {
  const { state, audit } = await setupMembers(page);
  await loadMembers(page);
  await memberChoice(page).click();
  await prepareMemberGroup(page, "admin", true);
  const detail = memberDetail(page);
  await expect(detail.getByLabel("권한 변경 미리보기", { exact: true })).toContainText(
    "운영 그룹 없음",
  );
  expect(state.commands).toEqual([]);
  let cancelledMessage = "";
  page.once("dialog", async (dialog) => {
    cancelledMessage = dialog.message();
    await dialog.dismiss();
  });
  await detail
    .getByRole("button", { name: "권한 변경 내용 확인", exact: true })
    .click();
  expect(cancelledMessage).toContain("member+alex@example.test");
  expect(cancelledMessage).toContain("현재: 운영 그룹 없음");
  expect(cancelledMessage).toContain("변경 후: admin");
  expect(state.commands).toEqual([]);
  await detail.getByRole("button", { name: "권한 선택 취소", exact: true }).click();
  await expect(detail.getByLabel("권한 변경 미리보기", { exact: true })).toHaveCount(0);
  await prepareMemberGroup(page, "admin", true);
  page.once("dialog", (dialog) => void dialog.accept());
  await detail
    .getByRole("button", { name: "권한 변경 내용 확인", exact: true })
    .click();
  await expect.poll(() => state.commands.length).toBe(1);
  await expect(
    detail.getByRole("button", { name: "admin 해제 준비", exact: true }),
  ).toBeEnabled();
  expect(state.commands[0]).toEqual({
    method: "POST",
    path: "/prod/admin/members/member%2Balex%40example.test/groups",
    body: { group: "admin" },
  });
  await memberChoice(page, "[TEST] Support").click();
  await prepareMemberGroup(page, "support", false, "[TEST] Support");
  page.once("dialog", (dialog) => void dialog.accept());
  await memberDetail(page, "[TEST] Support")
    .getByRole("button", { name: "권한 변경 내용 확인", exact: true })
    .click();
  await expect.poll(() => state.commands.length).toBe(2);
  await expect(
    memberDetail(page, "[TEST] Support").getByRole("button", {
      name: "support 부여 준비",
      exact: true,
    }),
  ).toBeEnabled();
  expect(state.commands[1]).toEqual({
    method: "DELETE",
    path: "/prod/admin/members/synthetic-support/groups",
    body: { group: "support" },
  });
  expect(state.reads).toBe(3);
  expect(audit.syntheticWrites).toEqual([
    "POST https://api.sales.test/prod/admin/members/member%2Balex%40example.test/groups",
    "DELETE https://api.sales.test/prod/admin/members/synthetic-support/groups",
  ]);
});

test("member redesign: an in-flight group update prevents duplicate commands and selection or refresh races", async ({
  page,
}) => {
  let release!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const { state } = await setupMembers(page, { mutationGate: gate });
  await loadMembers(page);
  await memberChoice(page).click();
  await prepareMemberGroup(page, "support", true);
  const detail = memberDetail(page);
  page.once("dialog", (dialog) => void dialog.accept());
  try {
    await detail
      .getByRole("button", { name: "권한 변경 내용 확인", exact: true })
      .click();
    await expect.poll(() => state.commands.length).toBe(1);
    const save = detail.getByRole("button", { name: "권한 변경 중…", exact: true });
    await expect(save).toBeDisabled();
    await expect(memberChoice(page, "[TEST] Support")).toBeDisabled();
    await expect(
      memberWorkspace(page).getByRole("button", {
        name: "회원 목록 불러오기",
        exact: true,
      }),
    ).toBeDisabled();
    await expect(
      detail.getByRole("button", { name: "admin 부여 준비", exact: true }),
    ).toBeDisabled();
    await save.evaluate((button: HTMLButtonElement) => button.click());
    expect(state.commands).toHaveLength(1);
  } finally {
    release();
  }
  await expect(
    detail.getByRole("button", { name: "support 해제 준비", exact: true }),
  ).toBeEnabled();
  expect(state.commands).toHaveLength(1);
  expect(state.reads).toBe(2);
});

test("member redesign: an uncertain group response is not called successful and cannot be resent before explicit refresh", async ({
  page,
}) => {
  const { state } = await setupMembers(page, { mutationFailed: true });
  await loadMembers(page);
  await memberChoice(page).click();
  await prepareMemberGroup(page, "admin", true);
  page.once("dialog", (dialog) => void dialog.accept());
  await memberDetail(page)
    .getByRole("button", { name: "권한 변경 내용 확인", exact: true })
    .click();
  const panel = memberWorkspace(page);
  await expect(panel.getByRole("alert")).toContainText(
    "실제로 반영됐을 수 있으므로 재전송하지 말고",
  );
  await expect(panel.getByRole("status")).toHaveCount(0);
  await expect(
    memberDetail(page).getByRole("button", { name: "admin 부여 준비", exact: true }),
  ).toBeDisabled();
  await expect(
    memberDetail(page).getByRole("button", {
      name: "권한 변경 내용 확인",
      exact: true,
    }),
  ).toBeDisabled();
  expect(state.commands).toHaveLength(1);
  expect(state.members[0]!.groups).toEqual([]);
  await loadMembers(page);
  await expect(
    memberDetail(page).getByRole("button", { name: "admin 부여 준비", exact: true }),
  ).toBeEnabled();
  await expect(
    memberDetail(page).getByLabel("권한 변경 미리보기", { exact: true }),
  ).toHaveCount(0);
  expect(state.commands).toHaveLength(1);
});

test("member redesign: a failed first query is unknown not empty and failed refresh retains an explicitly outdated read-only list", async ({
  page,
}) => {
  const { state } = await setupMembers(page, { initiallyFailed: true });
  const panel = memberWorkspace(page);
  await loadMembers(page);
  await expect(panel.getByRole("alert")).toContainText(
    "회원 목록을 불러오지 못했습니다",
  );
  await expect(
    panel.getByText("최신 회원 목록을 확인하지 못했습니다", { exact: true }),
  ).toBeVisible();
  await expect(
    panel.getByRole("heading", { name: "이번 조회 회원 —", exact: true }),
  ).toBeVisible();
  await expect(
    panel.getByText("이번 조회에서 회원이 반환되지 않았습니다", { exact: true }),
  ).toHaveCount(0);
  state.readFailed = false;
  await loadMembers(page);
  await memberChoice(page).click();
  state.readFailed = true;
  await loadMembers(page);
  await expect(memberChoice(page)).toBeVisible();
  await expect(
    panel.getByText("최신 조회 실패 · 이전 결과일 수 있음", { exact: true }),
  ).toBeVisible();
  await expect(memberDetail(page)).toContainText("최신 권한을 확인해야 합니다");
  await expect(
    memberDetail(page).getByRole("button", { name: "support 부여 준비", exact: true }),
  ).toBeDisabled();
  expect(state.reads).toBe(3);
  expect(state.commands).toEqual([]);
});

test("member redesign: confirmed server update plus failed reload does not display guessed new permissions or allow another change", async ({
  page,
}) => {
  const { state } = await setupMembers(page);
  await loadMembers(page);
  await memberChoice(page).click();
  await prepareMemberGroup(page, "admin", true);
  state.readFailed = true;
  page.once("dialog", (dialog) => void dialog.accept());
  await memberDetail(page)
    .getByRole("button", { name: "권한 변경 내용 확인", exact: true })
    .click();
  await expect(memberWorkspace(page).getByRole("alert")).toContainText(
    "요청은 성공했습니다. 최신 회원 목록을 확인하지 못했으므로",
  );
  await expect(
    memberDetail(page).getByRole("button", { name: "admin 부여 준비", exact: true }),
  ).toBeDisabled();
  await expect(memberWorkspace(page).getByRole("status")).toHaveCount(0);
  expect(state.commands).toHaveLength(1);
  expect(state.members[0]!.groups).toEqual(["admin"]);
  state.readFailed = false;
  await loadMembers(page);
  await expect(
    memberDetail(page).getByRole("button", { name: "admin 해제 준비", exact: true }),
  ).toBeEnabled();
  expect(state.commands).toHaveLength(1);
});

test("member redesign: the signed-in administrator cannot prepare removing their own admin group", async ({
  page,
}) => {
  const { state, audit } = await setupMembers(page);
  await loadMembers(page);
  await memberChoice(page, "[TEST] Current admin").click();
  const detail = memberDetail(page, "[TEST] Current admin");
  const remove = detail.getByRole("button", { name: "admin 해제 준비", exact: true });
  await expect(remove).toBeDisabled();
  await expect(detail).toContainText("본인 계정의 admin 권한은 해제할 수 없습니다");
  await remove.evaluate((button: HTMLButtonElement) => button.click());
  await expect(
    detail.getByRole("button", { name: "권한 변경 내용 확인", exact: true }),
  ).toBeDisabled();
  expect(state.commands).toEqual([]);
  expect(audit.syntheticWrites).toEqual([]);
});

test("member redesign: mobile selection focuses detail and reflows at 375 and 320 with 44-pixel permission controls", async ({
  page,
}, testInfo) => {
  await page.setViewportSize({ width: 375, height: 900 });
  const { state } = await setupMembers(page);
  await loadMembers(page);
  await memberChoice(page).focus();
  await page.keyboard.press("Enter");
  const detail = memberDetail(page);
  const heading = detail.getByRole("heading", { name: "[TEST] Alex", exact: true });
  await expect(heading).toBeFocused();
  const box = await heading.boundingBox();
  expect(box).not.toBeNull();
  expect(box!.y).toBeGreaterThanOrEqual(0);
  expect(box!.y).toBeLessThan(900);
  await page.keyboard.press("Tab");
  await expect(
    detail.getByRole("button", { name: "support 부여 준비", exact: true }),
  ).toBeFocused();
  await prepareMemberGroup(page, "support", true);
  for (const width of [375, 320]) {
    await page.setViewportSize({ width, height: 900 });
    expect(
      await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth),
    ).toBe(true);
    for (const name of [
      "support 부여 준비",
      "admin 부여 준비",
      "권한 변경 내용 확인",
      "권한 선택 취소",
    ])
      expect(
        (await detail.getByRole("button", { name, exact: true }).boundingBox())?.height,
      ).toBeGreaterThanOrEqual(44);
    expect(
      (
        await memberWorkspace(page)
          .getByRole("searchbox", { name: "불러온 회원 검색", exact: true })
          .boundingBox()
      )?.height,
    ).toBeGreaterThanOrEqual(44);
    await page.screenshot({
      path: testInfo.outputPath(`member-redesign-mobile-${width}.png`),
      fullPage: true,
    });
    await detail.screenshot({
      path: testInfo.outputPath(`member-redesign-mobile-detail-${width}.png`),
    });
  }
  expect(state.commands).toEqual([]);
});

const couponWorkspace = (page: Page) => page.locator("#admin-panel-coupons");
const couponField = (page: Page, label: string) =>
  couponWorkspace(page).getByLabel(label, { exact: false });
async function fillCoupon(
  page: Page,
  options: {
    name?: string;
    code?: string;
    type?: "percent" | "amount";
    value?: string;
    date?: string;
  } = {},
) {
  await couponField(page, "쿠폰명 (필수)").fill(
    options.name ?? "[TEST] Welcome coupon",
  );
  await couponField(page, "쿠폰 코드 (필수)").fill(options.code ?? "test_welcome10");
  await couponField(page, "혜택 유형").selectOption(options.type ?? "percent");
  await couponField(
    page,
    options.type === "amount" ? "할인 금액 (원) (필수)" : "할인율 (%) (필수)",
  ).fill(options.value ?? "10");
  if (options.date !== undefined)
    await couponField(page, "만료 시각 (한국 시간·선택)").fill(options.date);
}
async function savedCoupon(route: Route) {
  const draft = route.request().postDataJSON();
  await respond(
    route,
    {
      record: {
        couponId: "coupon_synthetic_draft",
        ...draft,
        status: "DRAFT",
        minimumOrderAmount: 0,
        version: 1,
        createdAt: `${DAY}T14:00:00.000Z`,
        updatedAt: `${DAY}T14:00:00.000Z`,
      },
    },
    201,
  );
}

test("coupon redesign: editing the live ticket never issues a coupon or loads fabricated recipient counts", async ({
  page,
}, testInfo) => {
  await page.setViewportSize({ width: 1440, height: 1000 });
  const audit = await setup(page, { path: "/admin?section=coupons" });
  const panel = couponWorkspace(page);
  await expect(
    panel.getByRole("heading", { name: "쿠폰 만들기", exact: true }),
  ).toBeVisible();
  const preview = panel.getByRole("complementary", {
    name: "쿠폰 고객 노출 미리보기",
    exact: true,
  });
  await expect(preview).toContainText("초안 예시 · 사용 불가");
  await fillCoupon(page, { code: "test-preview_10", date: "2026-10-30T18:30" });
  await expect(preview).toContainText("10%");
  await expect(preview).toContainText("[TEST] Welcome coupon");
  await expect(preview).toContainText("TEST-PREVIEW_10");
  await expect(preview).toContainText("2026-10-30 18:30 (한국 시간)");
  await expect(preview).toContainText("아직 발급되지 않았습니다");
  await panel.getByText("도움말", { exact: true }).click();
  await expect(
    panel.getByText(
      /대상 선택·최소 주문 금액·최대 할인·시작일 설정은 현재 지원하지 않습니다/,
    ),
  ).toBeVisible();
  await panel.getByText("도움말", { exact: true }).click();
  await expect(panel.getByText(/발급 완료|수신 대상 0명|대상 고객 0명/)).toHaveCount(0);
  await expect(
    panel.getByRole("button", { name: /발급하기|지금 발급|고객 발급/ }),
  ).toHaveCount(0);
  const formBox = await panel
    .getByRole("form", { name: "쿠폰 초안 설정", exact: true })
    .boundingBox();
  const previewBox = await preview.boundingBox();
  expect(formBox).not.toBeNull();
  expect(previewBox).not.toBeNull();
  expect(previewBox!.x).toBeGreaterThan(formBox!.x + formBox!.width - 1);
  expect(
    await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth),
  ).toBe(true);
  await page.screenshot({
    path: testInfo.outputPath("coupon-redesign-desktop-1440.png"),
    fullPage: true,
  });
  expect(audit.syntheticWrites).toEqual([]);
  expect(audit.reads.filter((path) => /coupons|members|campaigns/.test(path))).toEqual(
    [],
  );
});

test("coupon redesign: explicit percent and amount draft saves preserve uppercase codes supported fields and KST expiration", async ({
  page,
}) => {
  const commands: unknown[] = [];
  const audit = await setup(page, {
    path: "/admin?section=coupons",
    handleCouponMutation: async (route) => {
      commands.push(route.request().postDataJSON());
      expect(route.request().headers().authorization).toMatch(/^Bearer /);
      await savedCoupon(route);
    },
  });
  const panel = couponWorkspace(page);
  await fillCoupon(page, {
    name: "  [TEST] Percent  ",
    code: "  test_percent10  ",
    date: "2026-10-30T18:30",
  });
  await panel.getByRole("button", { name: "쿠폰 초안 저장", exact: true }).click();
  await expect.poll(() => commands.length).toBe(1);
  expect(commands[0]).toEqual({
    name: "[TEST] Percent",
    code: "TEST_PERCENT10",
    discountType: "PERCENT",
    discountValue: 10,
    expiresAt: "2026-10-30T09:30:00.000Z",
  });
  await expect(panel.getByRole("status")).toContainText(
    "아직 고객에게 발급되지 않았습니다",
  );
  await expect(panel.getByText("초안 저장 · 미발급", { exact: true })).toBeVisible();
  await fillCoupon(page, {
    name: "[TEST] Amount",
    code: "test_amount5000",
    type: "amount",
    value: "5000",
    date: "",
  });
  await expect(panel.getByRole("status")).toHaveCount(0);
  await expect(panel.getByText("초안 · 미발급", { exact: true })).toBeVisible();
  await panel.getByRole("button", { name: "쿠폰 초안 저장", exact: true }).click();
  await expect.poll(() => commands.length).toBe(2);
  expect(commands[1]).toEqual({
    name: "[TEST] Amount",
    code: "TEST_AMOUNT5000",
    discountType: "AMOUNT",
    discountValue: 5000,
  });
  expect(audit.syntheticWrites).toEqual(
    Array(2).fill("POST https://api.sales.test/prod/admin/coupons"),
  );
});

test("coupon redesign: invalid codes and noninteger or out-of-range benefits cannot be sent even through form submission", async ({
  page,
}) => {
  const audit = await setup(page, { path: "/admin?section=coupons" });
  const panel = couponWorkspace(page);
  await fillCoupon(page);
  const form = panel.getByRole("form", { name: "쿠폰 초안 설정", exact: true });
  const value = couponField(page, "할인율 (%) (필수)");
  for (const invalid of ["", " ", "0", "-1", "1.5", "1e2", "1,000", "101", "text"]) {
    await value.fill(invalid);
    await expect(
      panel.getByRole("button", { name: "쿠폰 초안 저장", exact: true }),
    ).toBeDisabled();
    await form.evaluate((element: HTMLFormElement) => element.requestSubmit());
    await expect(panel.getByRole("alert")).toBeVisible();
    expect(audit.syntheticWrites).toEqual([]);
  }
  await value.fill("100");
  await expect(
    panel.getByRole("button", { name: "쿠폰 초안 저장", exact: true }),
  ).toBeEnabled();
  for (const code of [" ", "AB", "bad code", "한글쿠폰", "BAD@CODE", "_BAD"]) {
    await couponField(page, "쿠폰 코드 (필수)").fill(code);
    await expect(
      panel.getByRole("button", { name: "쿠폰 초안 저장", exact: true }),
    ).toBeDisabled();
    await form.evaluate((element: HTMLFormElement) => element.requestSubmit());
    expect(audit.syntheticWrites).toEqual([]);
  }
  await couponField(page, "쿠폰 코드 (필수)").fill("VALID_100");
  await couponField(page, "혜택 유형").selectOption("amount");
  const amount = couponField(page, "할인 금액 (원) (필수)");
  await amount.fill("100000001");
  await expect(
    panel.getByRole("button", { name: "쿠폰 초안 저장", exact: true }),
  ).toBeDisabled();
  await form.evaluate((element: HTMLFormElement) => element.requestSubmit());
  await amount.fill("100000000");
  await expect(
    panel.getByRole("button", { name: "쿠폰 초안 저장", exact: true }),
  ).toBeEnabled();
  await expect(couponField(page, "쿠폰명 (필수)")).toHaveAttribute("maxlength", "120");
  await expect(couponField(page, "쿠폰 코드 (필수)")).toHaveAttribute(
    "maxlength",
    "32",
  );
  expect(audit.syntheticWrites).toEqual([]);
});

test("coupon redesign: saving disables edits and synchronous duplicate submissions create only one draft request", async ({
  page,
}) => {
  let release!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const commands: unknown[] = [];
  const audit = await setup(page, {
    path: "/admin?section=coupons",
    handleCouponMutation: async (route) => {
      commands.push(route.request().postDataJSON());
      await gate;
      await savedCoupon(route);
    },
  });
  await fillCoupon(page);
  const panel = couponWorkspace(page);
  try {
    await panel
      .getByRole("form", { name: "쿠폰 초안 설정", exact: true })
      .evaluate((form: HTMLFormElement) => {
        form.requestSubmit();
        form.requestSubmit();
      });
    await expect.poll(() => commands.length).toBe(1);
    for (const label of [
      "쿠폰명 (필수)",
      "쿠폰 코드 (필수)",
      "혜택 유형",
      "할인율 (%) (필수)",
      "만료 시각 (한국 시간·선택)",
    ])
      await expect(couponField(page, label)).toBeDisabled();
    await expect(
      panel.getByRole("button", { name: "저장 중…", exact: true }),
    ).toBeDisabled();
  } finally {
    release();
  }
  await expect(panel.getByRole("status")).toContainText("초안을 서버에 저장했습니다");
  expect(commands).toHaveLength(1);
  expect(audit.syntheticWrites).toEqual([
    "POST https://api.sales.test/prod/admin/coupons",
  ]);
});

test("coupon redesign: unknown save keeps the entered draft and never claims issuance or local fallback", async ({
  page,
}) => {
  const audit = await setup(page, {
    path: "/admin?section=coupons",
    handleCouponMutation: (route) =>
      respond(route, { code: "SYNTHETIC_COUPON_UNAVAILABLE" }, 503),
  });
  await fillCoupon(page, { date: "2026-10-30T18:30" });
  const panel = couponWorkspace(page);
  await panel.getByRole("button", { name: "쿠폰 초안 저장", exact: true }).click();
  await expect(panel.getByRole("alert")).toContainText(
    "쿠폰 초안 저장 결과를 확인하지 못했습니다. 입력은 유지했습니다",
  );
  await expect(panel.getByRole("alert")).toContainText("서버 처리 결과");
  await expect(couponField(page, "쿠폰명 (필수)")).toHaveValue("[TEST] Welcome coupon");
  await expect(couponField(page, "쿠폰 코드 (필수)")).toHaveValue("TEST_WELCOME10");
  await expect(couponField(page, "할인율 (%) (필수)")).toHaveValue("10");
  await expect(couponField(page, "만료 시각 (한국 시간·선택)")).toHaveValue(
    "2026-10-30T18:30",
  );
  await expect(panel.getByRole("status")).toHaveCount(0);
  await expect(
    panel.getByRole("button", { name: "이 화면에 초안 준비", exact: true }),
  ).toHaveCount(0);
  await expect(panel.getByText("초안 저장 · 미발급", { exact: true })).toHaveCount(0);
  expect(audit.syntheticWrites).toEqual([
    "POST https://api.sales.test/prod/admin/coupons",
  ]);
});

test("coupon redesign: mobile form and ticket reflow at 375 and 320 with usable controls", async ({
  page,
}, testInfo) => {
  await page.setViewportSize({ width: 375, height: 900 });
  const audit = await setup(page, { path: "/admin?section=coupons" });
  await fillCoupon(page, {
    name: `SYNTHETIC_${"LONG_COUPON_".repeat(6)}`,
    code: "SYNTHETIC_LONG_COUPON_CODE_123456",
    date: "2026-10-30T18:30",
  });
  const panel = couponWorkspace(page);
  for (const width of [375, 320]) {
    await page.setViewportSize({ width, height: 900 });
    expect(
      await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth),
    ).toBe(true);
    for (const label of [
      "쿠폰명 (필수)",
      "쿠폰 코드 (필수)",
      "혜택 유형",
      "할인율 (%) (필수)",
      "만료 시각 (한국 시간·선택)",
    ])
      expect(
        (await couponField(page, label).boundingBox())?.height,
      ).toBeGreaterThanOrEqual(44);
    expect(
      (
        await panel
          .getByRole("button", { name: "쿠폰 초안 저장", exact: true })
          .boundingBox()
      )?.height,
    ).toBeGreaterThanOrEqual(44);
    await page.screenshot({
      path: testInfo.outputPath(`coupon-redesign-mobile-${width}.png`),
      fullPage: true,
    });
    await panel
      .getByRole("complementary", { name: "쿠폰 고객 노출 미리보기", exact: true })
      .screenshot({
        path: testInfo.outputPath(`coupon-redesign-mobile-ticket-${width}.png`),
      });
  }
  expect(audit.syntheticWrites).toEqual([]);
});

test("coupon redesign: enabled draft save is readable on hover and keyboard focus in both themes", async ({
  page,
}) => {
  const audit = await setup(page, { path: "/admin?section=coupons" });
  await fillCoupon(page);
  const action = couponWorkspace(page).getByRole("button", {
    name: "쿠폰 초안 저장",
    exact: true,
  });
  for (const theme of ["light", "dark"]) {
    await page.evaluate((value) => {
      document.documentElement.dataset.theme = value;
    }, theme);
    for (const state of ["hover", "focus"]) {
      await page.mouse.move(0, 0);
      if (state === "hover") await action.hover();
      else {
        await action.focus();
        await page.keyboard.press("Tab");
        await page.keyboard.press("Shift+Tab");
        await expect(action).toBeFocused();
        await expect
          .poll(() => action.evaluate((element) => element.matches(":focus-visible")))
          .toBe(true);
      }
      const contrast = await action.evaluate((element) => {
        const canvas = document.createElement("canvas");
        canvas.width = canvas.height = 1;
        const context = canvas.getContext("2d")!;
        const rgba = (value: string) => {
          context.clearRect(0, 0, 1, 1);
          context.fillStyle = value;
          context.fillRect(0, 0, 1, 1);
          return [...context.getImageData(0, 0, 1, 1).data];
        };
        const ancestors: Element[] = [];
        for (let node: Element | null = element; node; node = node.parentElement)
          ancestors.unshift(node);
        let background = [255, 255, 255];
        for (const ancestor of ancestors) {
          const [red, green, blue, alpha] = rgba(
            getComputedStyle(ancestor).backgroundColor,
          );
          background = [red, green, blue].map(
            (channel, index) =>
              channel * (alpha / 255) + background[index] * (1 - alpha / 255),
          );
        }
        const luminance = (rgb: readonly number[]) => {
          const [red, green, blue] = rgb.map((value) => {
            const channel = value / 255;
            return channel <= 0.04045
              ? channel / 12.92
              : ((channel + 0.055) / 1.055) ** 2.4;
          });
          return 0.2126 * red + 0.7152 * green + 0.0722 * blue;
        };
        const style = getComputedStyle(element);
        const foreground = luminance(rgba(style.color).slice(0, 3));
        const behind = luminance(background);
        return (
          (Math.max(foreground, behind) + 0.05) / (Math.min(foreground, behind) + 0.05)
        );
      });
      console.log(`Coupon save contrast ${theme}/${state}: ${contrast}`);
      expect(contrast).toBeGreaterThanOrEqual(4.5);
    }
  }
  expect(audit.syntheticWrites).toEqual([]);
});

const marketingWorkspace = (page: Page) => page.locator("#admin-panel-marketing");
const campaignTitle = (page: Page) =>
  marketingWorkspace(page).getByLabel("캠페인 제목", { exact: false });
const campaignBody = (page: Page) =>
  marketingWorkspace(page).getByLabel("메시지", { exact: false });
async function fillCampaign(
  page: Page,
  title = "[TEST] New arrivals",
  body = "Synthetic new arrivals message. No actual send.",
) {
  await campaignTitle(page).fill(title);
  await campaignBody(page).fill(body);
}
async function savedCampaign(route: Route) {
  await respond(
    route,
    {
      record: {
        campaignId: "campaign_synthetic_draft",
        ...route.request().postDataJSON(),
        status: "DRAFT",
        audience: "MARKETING_CONSENTED",
        version: 1,
        createdAt: `${DAY}T14:00:00.000Z`,
        updatedAt: `${DAY}T14:00:00.000Z`,
      },
    },
    201,
  );
}

const campaignSave = (page: Page) =>
  marketingWorkspace(page).getByRole("button", {
    name: "캠페인 초안 저장",
    exact: true,
  });
const campaignChannel = (page: Page, label: string) =>
  marketingWorkspace(page).getByRole("checkbox", {
    name: `${label} 초안 선택`,
    exact: true,
  });
const campaignPreview = (page: Page) =>
  marketingWorkspace(page).getByRole("complementary", {
    name: "선택 채널 문구 미리보기",
    exact: true,
  });

test("marketing redesign: channel choices and live previews do not send messages or invent recipient or connection status", async ({
  page,
}, testInfo) => {
  await page.setViewportSize({ width: 1440, height: 1000 });
  const audit = await setup(page, { path: "/admin?section=marketing" });
  const panel = marketingWorkspace(page);
  await fillCampaign(page);
  for (const label of ["이메일", "SMS", "푸시"])
    await campaignChannel(page, label).check();
  const preview = campaignPreview(page);
  for (const label of ["이메일", "SMS", "푸시"]) {
    await preview
      .getByRole("button", { name: `${label} 미리보기`, exact: true })
      .click();
    await expect(
      preview.getByRole("heading", { name: `${label} 미리보기`, exact: true }),
    ).toBeVisible();
    await expect(preview).toContainText("[TEST] New arrivals");
    await expect(preview).toContainText(
      "Synthetic new arrivals message. No actual send.",
    );
    await expect(
      preview.getByRole("button", { name: `${label} 미리보기`, exact: true }),
    ).toHaveAttribute("aria-pressed", "true");
  }
  await expect(
    panel.getByText("수신 대상 미조회 · 발송 없음", { exact: true }),
  ).toBeVisible();
  await expect(
    panel.getByText(
      /^(?:수신 대상 0명|대상자 0명|연결 완료|발송 가능|예약 완료|발송 완료)$/,
    ),
  ).toHaveCount(0);
  await expect(
    panel.getByRole("button", { name: /지금 발송|예약하기|이미지 첨부|대상자 조회/ }),
  ).toHaveCount(0);
  await panel.getByText("도움말", { exact: true }).click();
  await expect(
    panel.getByText(/수신자 조회·예약·발송·이미지 첨부는 지원하지 않습니다/),
  ).toBeVisible();
  await panel.getByText("도움말", { exact: true }).click();
  const formBox = await panel
    .getByRole("form", { name: "캠페인 초안 작성", exact: true })
    .boundingBox();
  const previewBox = await preview.boundingBox();
  expect(formBox).not.toBeNull();
  expect(previewBox).not.toBeNull();
  expect(previewBox!.x).toBeGreaterThan(formBox!.x + formBox!.width - 1);
  expect(
    await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth),
  ).toBe(true);
  await page.screenshot({
    path: testInfo.outputPath("marketing-redesign-desktop-1440.png"),
    fullPage: true,
  });
  expect(audit.syntheticWrites).toEqual([]);
  expect(
    audit.reads.filter((path) => /campaigns|members|consent|audience/.test(path)),
  ).toEqual([]);
});

test("marketing redesign: a deliberate multichannel draft saves only supported fields and editing clears the previous saved indication", async ({
  page,
}) => {
  const commands: unknown[] = [];
  const audit = await setup(page, {
    path: "/admin?section=marketing",
    handleCampaignMutation: async (route) => {
      commands.push(route.request().postDataJSON());
      expect(route.request().headers().authorization).toMatch(/^Bearer /);
      await savedCampaign(route);
    },
  });
  const panel = marketingWorkspace(page);
  await fillCampaign(
    page,
    "  [TEST] Three-channel draft  ",
    "  Synthetic body\nNew paragraph.  ",
  );
  for (const label of ["이메일", "SMS", "푸시"])
    await campaignChannel(page, label).check();
  await campaignSave(page).click();
  await expect.poll(() => commands.length).toBe(1);
  expect(commands[0]).toEqual({
    title: "[TEST] Three-channel draft",
    body: "Synthetic body\nNew paragraph.",
    channels: ["EMAIL", "SMS", "PUSH"],
  });
  await expect(panel.getByRole("status")).toContainText("고객에게 발송하지 않았습니다");
  await expect(panel.getByText("초안 저장 · 발송 없음", { exact: true })).toBeVisible();
  await campaignTitle(page).fill("[TEST] Edited push draft");
  await expect(panel.getByRole("status")).toHaveCount(0);
  await expect(panel.getByText("미리보기 · 발송 없음", { exact: true })).toBeVisible();
  await campaignChannel(page, "이메일").uncheck();
  await campaignChannel(page, "SMS").uncheck();
  await campaignSave(page).click();
  await expect.poll(() => commands.length).toBe(2);
  expect(commands[1]).toEqual({
    title: "[TEST] Edited push draft",
    body: "Synthetic body\nNew paragraph.",
    channels: ["PUSH"],
  });
  expect(audit.syntheticWrites).toEqual(
    Array(2).fill("POST https://api.sales.test/prod/admin/campaigns"),
  );
});

test("marketing redesign: blank content and choosing no channel cannot submit or show an active channel preview", async ({
  page,
}) => {
  const audit = await setup(page, { path: "/admin?section=marketing" });
  const panel = marketingWorkspace(page);
  await expect(campaignSave(page)).toBeDisabled();
  await fillCampaign(page);
  for (const label of ["이메일", "SMS", "푸시"])
    await campaignChannel(page, label).uncheck();
  await expect(campaignSave(page)).toBeDisabled();
  await expect(
    campaignPreview(page).getByText("초안에 포함할 채널을 하나 이상 선택해 주세요.", {
      exact: true,
    }),
  ).toBeVisible();
  await expect(campaignPreview(page).getByRole("button")).toHaveCount(0);
  const form = panel.getByRole("form", { name: "캠페인 초안 작성", exact: true });
  await form.evaluate((element: HTMLFormElement) => element.requestSubmit());
  await expect(panel.getByRole("alert")).toBeVisible();
  await campaignChannel(page, "이메일").check();
  await campaignTitle(page).fill("   ");
  await expect(campaignSave(page)).toBeDisabled();
  await form.evaluate((element: HTMLFormElement) => element.requestSubmit());
  await campaignTitle(page).fill("[TEST] Valid title");
  await campaignBody(page).fill("\n  ");
  await expect(campaignSave(page)).toBeDisabled();
  await form.evaluate((element: HTMLFormElement) => element.requestSubmit());
  expect(audit.syntheticWrites).toEqual([]);
});

test("marketing redesign: title and body limits match the draft API without claiming SMS delivery sizing", async ({
  page,
}) => {
  const commands: Array<Record<string, unknown>> = [];
  const audit = await setup(page, {
    path: "/admin?section=marketing",
    handleCampaignMutation: async (route) => {
      commands.push(route.request().postDataJSON());
      await savedCampaign(route);
    },
  });
  await expect(campaignTitle(page)).toHaveAttribute("maxlength", "160");
  await expect(campaignBody(page)).toHaveAttribute("maxlength", "8000");
  await fillCampaign(page, "T".repeat(160), "B".repeat(8000));
  await campaignChannel(page, "SMS").check();
  await campaignChannel(page, "이메일").uncheck();
  await campaignPreview(page)
    .getByRole("button", { name: "SMS 미리보기", exact: true })
    .click();
  await expect(campaignPreview(page)).toContainText(
    "문자 분할·발송 비용·인코딩은 계산하지 않습니다",
  );
  await campaignSave(page).click();
  await expect.poll(() => commands.length).toBe(1);
  expect(commands[0]).toEqual({
    title: "T".repeat(160),
    body: "B".repeat(8000),
    channels: ["SMS"],
  });
  expect(audit.syntheticWrites).toEqual([
    "POST https://api.sales.test/prod/admin/campaigns",
  ]);
});

test("marketing redesign: in-flight draft save locks content and channels and coalesces duplicate submission", async ({
  page,
}) => {
  let release!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const commands: unknown[] = [];
  const audit = await setup(page, {
    path: "/admin?section=marketing",
    handleCampaignMutation: async (route) => {
      commands.push(route.request().postDataJSON());
      await gate;
      await savedCampaign(route);
    },
  });
  await fillCampaign(page);
  const panel = marketingWorkspace(page);
  try {
    await panel
      .getByRole("form", { name: "캠페인 초안 작성", exact: true })
      .evaluate((form: HTMLFormElement) => {
        form.requestSubmit();
        form.requestSubmit();
      });
    await expect.poll(() => commands.length).toBe(1);
    await expect(campaignTitle(page)).toBeDisabled();
    await expect(campaignBody(page)).toBeDisabled();
    for (const label of ["이메일", "SMS", "푸시"])
      await expect(campaignChannel(page, label)).toBeDisabled();
    await expect(
      panel.getByRole("button", { name: "저장 중…", exact: true }),
    ).toBeDisabled();
  } finally {
    release();
  }
  await expect(panel.getByRole("status")).toContainText(
    "캠페인 초안을 서버에 저장했습니다",
  );
  expect(commands).toHaveLength(1);
  expect(audit.syntheticWrites).toEqual([
    "POST https://api.sales.test/prod/admin/campaigns",
  ]);
});

test("marketing redesign: uncertain save preserves title body and channels without a sent or local-save claim", async ({
  page,
}) => {
  const audit = await setup(page, {
    path: "/admin?section=marketing",
    handleCampaignMutation: (route) =>
      respond(route, { code: "SYNTHETIC_CAMPAIGN_UNAVAILABLE" }, 503),
  });
  await fillCampaign(page);
  await campaignChannel(page, "SMS").check();
  const panel = marketingWorkspace(page);
  await campaignSave(page).click();
  await expect(panel.getByRole("alert")).toContainText(
    "캠페인 초안 저장 결과를 확인하지 못했습니다. 입력은 유지했습니다",
  );
  await expect(panel.getByRole("alert")).toContainText("서버 처리 결과");
  await expect(campaignTitle(page)).toHaveValue("[TEST] New arrivals");
  await expect(campaignBody(page)).toHaveValue(
    "Synthetic new arrivals message. No actual send.",
  );
  await expect(campaignChannel(page, "이메일")).toBeChecked();
  await expect(campaignChannel(page, "SMS")).toBeChecked();
  await expect(panel.getByRole("status")).toHaveCount(0);
  await expect(panel.getByText("초안 저장 · 발송 없음", { exact: true })).toHaveCount(
    0,
  );
  await expect(
    panel.getByRole("button", { name: "이 화면에 초안 준비", exact: true }),
  ).toHaveCount(0);
  expect(audit.syntheticWrites).toEqual([
    "POST https://api.sales.test/prod/admin/campaigns",
  ]);
});

test("marketing redesign: mobile channels form and preview fit 375 and 320 with 44-pixel targets", async ({
  page,
}, testInfo) => {
  await page.setViewportSize({ width: 375, height: 900 });
  const audit = await setup(page, { path: "/admin?section=marketing" });
  await fillCampaign(
    page,
    `SYNTHETIC_${"LONG_TITLE_".repeat(8)}`,
    `SYNTHETIC_${"LONG_MESSAGE_".repeat(20)}`,
  );
  for (const label of ["이메일", "SMS", "푸시"])
    await campaignChannel(page, label).check();
  for (const width of [375, 320]) {
    await page.setViewportSize({ width, height: 900 });
    expect(
      await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth),
    ).toBe(true);
    for (const label of ["이메일", "SMS", "푸시"]) {
      expect(
        (
          await campaignChannel(page, label)
            .locator("xpath=ancestor::label[1]")
            .boundingBox()
        )?.height,
      ).toBeGreaterThanOrEqual(44);
      expect(
        (
          await campaignPreview(page)
            .getByRole("button", { name: `${label} 미리보기`, exact: true })
            .boundingBox()
        )?.height,
      ).toBeGreaterThanOrEqual(44);
    }
    expect((await campaignTitle(page).boundingBox())?.height).toBeGreaterThanOrEqual(
      44,
    );
    expect((await campaignSave(page).boundingBox())?.height).toBeGreaterThanOrEqual(44);
    await page.screenshot({
      path: testInfo.outputPath(`marketing-redesign-mobile-${width}.png`),
      fullPage: true,
    });
    await campaignPreview(page).screenshot({
      path: testInfo.outputPath(`marketing-redesign-mobile-preview-${width}.png`),
    });
  }
  expect(audit.syntheticWrites).toEqual([]);
});

test("marketing redesign: draft save remains readable on hover and keyboard focus in both themes", async ({
  page,
}) => {
  const audit = await setup(page, { path: "/admin?section=marketing" });
  await fillCampaign(page);
  const action = campaignSave(page);
  for (const theme of ["light", "dark"]) {
    await page.evaluate((value) => {
      document.documentElement.dataset.theme = value;
    }, theme);
    for (const state of ["hover", "focus"]) {
      await page.mouse.move(0, 0);
      if (state === "hover") await action.hover();
      else {
        await action.focus();
        await page.keyboard.press("Tab");
        await page.keyboard.press("Shift+Tab");
        await expect(action).toBeFocused();
        await expect
          .poll(() => action.evaluate((element) => element.matches(":focus-visible")))
          .toBe(true);
      }
      const contrast = await action.evaluate((element) => {
        const canvas = document.createElement("canvas");
        canvas.width = canvas.height = 1;
        const context = canvas.getContext("2d")!;
        const rgba = (value: string) => {
          context.clearRect(0, 0, 1, 1);
          context.fillStyle = value;
          context.fillRect(0, 0, 1, 1);
          return [...context.getImageData(0, 0, 1, 1).data];
        };
        const ancestors: Element[] = [];
        for (let node: Element | null = element; node; node = node.parentElement)
          ancestors.unshift(node);
        let background = [255, 255, 255];
        for (const ancestor of ancestors) {
          const [red, green, blue, alpha] = rgba(
            getComputedStyle(ancestor).backgroundColor,
          );
          background = [red, green, blue].map(
            (channel, index) =>
              channel * (alpha / 255) + background[index] * (1 - alpha / 255),
          );
        }
        const luminance = (rgb: readonly number[]) => {
          const [red, green, blue] = rgb.map((value) => {
            const channel = value / 255;
            return channel <= 0.04045
              ? channel / 12.92
              : ((channel + 0.055) / 1.055) ** 2.4;
          });
          return 0.2126 * red + 0.7152 * green + 0.0722 * blue;
        };
        const style = getComputedStyle(element);
        const foreground = luminance(rgba(style.color).slice(0, 3));
        const behind = luminance(background);
        return (
          (Math.max(foreground, behind) + 0.05) / (Math.min(foreground, behind) + 0.05)
        );
      });
      console.log(`Campaign save contrast ${theme}/${state}: ${contrast}`);
      expect(contrast).toBeGreaterThanOrEqual(4.5);
    }
  }
  expect(audit.syntheticWrites).toEqual([]);
});
