import { expect, test, type Page, type Route } from "@playwright/test";

const ORIGIN = "http://127.0.0.1:3139";
const API = "https://api.sales.test/prod/";
const SUBJECT = "menu-resume-synthetic-admin";
const PRODUCT_A = "/products/odwyer-sync-1-8-375";
const PRODUCT_B = "/products?slug=synthetic-menu-product-b";
const PENDING_KEY = `paradays.admin-sales.pending.${SUBJECT}`;
const PENDING = JSON.stringify({
  day: "2026-10-17",
  command: {
    action: "save",
    entryId: "sale_synthetic_pending",
    expectedVersion: 0,
    soldAt: "2026-10-17T01:00:00.000Z",
    method: "CARD",
    reference: "TEST_PENDING_RESUME",
    amount: 10_000,
    memo: "Synthetic unresolved fixture",
    lines: [],
  },
});
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
type Section = (typeof sections)[number][0];
type Audit = { blocked: string[]; reads: string[]; writes: string[] };
const audits = new WeakMap<Page, Audit>();
const products = ["odwyer-sync-1-8-375", "synthetic-menu-product-b"].map(
  (slug, index) => ({
    id: `prd_menu_synthetic_${index}`,
    slug,
    name: `[TEST] Menu return product ${index === 0 ? "A" : "B"}`,
    brand: "TEST",
    category: "Deck",
    price: 10_000,
    inventoryQuantity: 10,
    image: "/images/product-placeholder.svg",
    description: ["Synthetic menu round-trip fixture"],
    sizes: ["TEST"],
  }),
);

function respond(route: Route, body: unknown) {
  return route.fulfill({
    status: 200,
    json: body,
    headers: {
      "access-control-allow-origin": "*",
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
  } = {},
) {
  const audit: Audit = { blocked: [], reads: [], writes: [] };
  audits.set(page, audit);
  await page.context().route("**/*", async (route) => {
    const request = route.request();
    const url = new URL(request.url());
    const description = `${request.method()} ${url.origin}${url.pathname}`;
    if (url.origin === ORIGIN && ["GET", "HEAD"].includes(request.method()))
      return route.continue();
    if (!request.url().startsWith(API)) {
      audit.blocked.push(description);
      return route.abort();
    }
    if (!["GET", "OPTIONS"].includes(request.method())) {
      audit.writes.push(description);
      return route.abort();
    }
    if (request.method() === "OPTIONS") return respond(route, {});
    audit.reads.push(url.pathname);
    if (url.pathname === "/prod/catalog/products") {
      const slug = url.searchParams.get("slug");
      return slug
        ? respond(route, { product: products.find((item) => item.slug === slug) })
        : respond(route, { products });
    }
    if (url.pathname === "/prod/admin/catalog/products")
      return respond(route, { products: [] });
    if (url.pathname === "/prod/admin/overview")
      return respond(route, {
        asOf: "2026-10-17T00:00:00Z",
        timezone: "Asia/Seoul",
        todayOrderCount: 0,
        lowStockCount: 0,
        lowStockThreshold: 3,
        activeCouponCount: 0,
        marketingConsentCount: 0,
      });
    if (url.pathname === "/prod/me")
      return respond(route, { userSub: SUBJECT, marketingConsent: false });
    if (url.pathname === "/prod/orders") return respond(route, { orders: [] });
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
  await page.context().addInitScript(
    ({ session, anonymous, pending, pendingKey }) => {
      if (!sessionStorage.getItem("synthetic_menu_resume_bootstrapped")) {
        if (!anonymous)
          sessionStorage.setItem("paradays.auth.session", JSON.stringify(session));
        if (pending) sessionStorage.setItem(pendingKey, pending);
        sessionStorage.setItem("synthetic_menu_resume_bootstrapped", "yes");
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
      pending: options.pending ? PENDING : null,
      pendingKey: PENDING_KEY,
    },
  );
  await page.goto(options.path ?? PRODUCT_A);
  await page.waitForLoadState("networkidle");
  return audit;
}

async function active(page: Page, section: Section) {
  await expect(page.locator(`#admin-panel-${section}`)).toBeVisible();
  await expect(page.locator(`#admin-tab-${section}`)).toHaveAttribute(
    "aria-selected",
    "true",
  );
}
async function select(page: Page, section: Section) {
  const tab = page.getByRole("tab", {
    name: sections.find(([id]) => id === section)![1],
    exact: true,
    includeHidden: true,
  });
  // Entry navigation can still be hydrating; a transient hidden PC tab is not
  // a mobile drawer. Wait for the selected responsive navigation contract.
  await expect(tab).toBeAttached();
  if (await page.evaluate(() => matchMedia("(min-width: 1024px)").matches))
    await expect(tab).toBeVisible();
  else if (!(await tab.isVisible()))
    await page.getByRole("button", { name: "운영 메뉴 열기", exact: true }).click();
  await tab.click();
  await active(page, section);
}
function adminLink(page: Page) {
  return page.getByRole("link", { name: "관리자페이지", exact: true });
}
function storeLink(page: Page) {
  return page.getByRole("link", { name: "스토어로 돌아가기", exact: true });
}
function storeHref(path: string, section: Section) {
  const url = new URL(path, ORIGIN);
  if (section !== "overview") url.searchParams.set("adminSection", section);
  return `${url.pathname}${url.search}${url.hash}`;
}
function entryHref(path: string, section: Section) {
  const query = new URLSearchParams();
  if (path !== "/") query.set("returnTo", path);
  if (section !== "overview") query.set("section", section);
  return `/admin${query.size ? `?${query}` : ""}`;
}
async function roundTrip(page: Page, path: string, section: Section) {
  await expect(storeLink(page)).toHaveAttribute("href", storeHref(path, section));
  await storeLink(page).click();
  await expect(page).toHaveURL(`${ORIGIN}${storeHref(path, section)}`);
  await expect(adminLink(page)).toHaveAttribute("href", entryHref(path, section));
  await adminLink(page).click();
  await active(page, section);
  await expect(page).toHaveURL(`${ORIGIN}${entryHref(path, section)}`);
}

test.afterEach(async ({ page }) => {
  expect(audits.get(page)?.blocked ?? []).toEqual([]);
  expect(audits.get(page)?.writes ?? []).toEqual([]);
});

test("video reproduction: inventory to original product to admin resumes inventory instead of home", async ({
  page,
}) => {
  await setup(page);
  await adminLink(page).click();
  await active(page, "overview");
  await select(page, "inventory");
  await storeLink(page).click();
  await expect(page.getByRole("heading", { name: products[0].name })).toBeVisible();
  await adminLink(page).click();
  await active(page, "inventory");
  await expect(page).toHaveURL(`${ORIGIN}${entryHref(PRODUCT_A, "inventory")}`);
});

test("all nine menus survive two explicit storefront round trips without nested return markers", async ({
  page,
}) => {
  test.setTimeout(90_000);
  await setup(page);
  await adminLink(page).click();
  for (const [section] of sections) {
    await select(page, section);
    await roundTrip(page, PRODUCT_A, section);
    await roundTrip(page, PRODUCT_A, section);
  }
});

test("query detail preserves slug locale anchor and menu through both reloads", async ({
  page,
}) => {
  const path = `${PRODUCT_B}&locale=en#reviews`;
  await setup(page, { path });
  await adminLink(page).click();
  await select(page, "brands");
  await page.reload();
  await active(page, "brands");
  await storeLink(page).click();
  await expect(page).toHaveURL(`${ORIGIN}${storeHref(path, "brands")}`);
  await page.reload();
  await expect(page).toHaveURL(`${ORIGIN}${storeHref(path, "brands")}`);
  await expect(page.getByRole("heading", { name: products[1].name })).toBeVisible();
  await expect(adminLink(page)).toHaveAttribute("href", entryHref(path, "brands"));
  await adminLink(page).click();
  await active(page, "brands");
});

test("opening the real resumed admin Link in a new tab carries only its explicit menu and return target", async ({
  page,
}) => {
  const path = `${PRODUCT_B}&locale=ko#description`;
  await setup(page, { path });
  await adminLink(page).click();
  await select(page, "marketing");
  await storeLink(page).click();
  const popupPromise = page.context().waitForEvent("page");
  await adminLink(page).click({ button: "middle" });
  const other = await popupPromise;
  try {
    await other.waitForLoadState("networkidle");
    await active(other, "marketing");
    await expect(other).toHaveURL(`${ORIGIN}${entryHref(path, "marketing")}`);
    await expect(storeLink(other)).toHaveAttribute(
      "href",
      storeHref(path, "marketing"),
    );
    await expect(page).toHaveURL(`${ORIGIN}${storeHref(path, "marketing")}`);
  } finally {
    await other.close();
  }
});

test("different products and direct admin do not borrow a stale global menu or product", async ({
  page,
}) => {
  await setup(page);
  await adminLink(page).click();
  await select(page, "inventory");
  await storeLink(page).click();
  await page.goto(PRODUCT_B);
  await expect(adminLink(page)).toHaveAttribute(
    "href",
    entryHref(PRODUCT_B, "overview"),
  );
  await adminLink(page).click();
  await active(page, "overview");
  await select(page, "coupons");
  await roundTrip(page, PRODUCT_B, "coupons");
  await page.goto("/admin");
  await active(page, "overview");
  await expect(storeLink(page)).toHaveAttribute("href", "/");
});

test("browser Back and Forward restore each menu and store boundary without history guessing", async ({
  page,
}) => {
  await setup(page);
  await adminLink(page).click();
  await select(page, "inventory");
  const inventory = page.url();
  await storeLink(page).click();
  await expect(page).toHaveURL(`${ORIGIN}${storeHref(PRODUCT_A, "inventory")}`);
  const store = page.url();
  await adminLink(page).click();
  await select(page, "brands");
  await page.goBack();
  await active(page, "inventory");
  await page.goBack();
  await expect(page).toHaveURL(store);
  await page.goBack();
  await expect(page).toHaveURL(inventory);
  await active(page, "inventory");
  await page.goForward();
  await expect(page).toHaveURL(store);
  await page.goForward();
  await active(page, "inventory");
  await page.goForward();
  await active(page, "brands");
});

test("unknown empty duplicate encoded and dangerous marker values safely select overview", async ({
  page,
}) => {
  test.setTimeout(90_000);
  await setup(page);
  for (const query of [
    "adminSection=unknown",
    "adminSection=",
    "adminSection=inventory&adminSection=brands",
    "adminSection=inventory&adminSection=inventory",
    "adminSection=%2Fadmin%3Fsection%3Dinventory",
    "adminSection=javascript%3Aalert(1)",
    "adminSection=%3Cscript%3E",
    "adminSection=INVENTORY",
  ]) {
    await page.goto(`${PRODUCT_A}?${query}`);
    await expect(adminLink(page)).toHaveAttribute(
      "href",
      entryHref(PRODUCT_A, "overview"),
    );
    await adminLink(page).click();
    await active(page, "overview");
  }
});

test("private query editor draft and return directives never cross the public menu boundary", async ({
  page,
}) => {
  const path = `${PRODUCT_B}&locale=ko#details`;
  const privatePath = `${PRODUCT_B}&locale=ko&adminSection=inventory&section=members&editor=00000000-0000-0000-0000-000000000001&draft=TEST_PRIVATE&token=TEST_PRIVATE&returnTo=%2Fadmin#details`;
  await setup(page, { path: privatePath });
  await expect(adminLink(page)).toHaveAttribute("href", entryHref(path, "inventory"));
  await adminLink(page).click();
  await active(page, "inventory");
  expect(page.url()).not.toMatch(/TEST_PRIVATE|editor|draft|token|members/);
  await expect(storeLink(page)).toHaveAttribute("href", storeHref(path, "inventory"));
  await storeLink(page).click();
  await expect(page).toHaveURL(`${ORIGIN}${storeHref(path, "inventory")}`);
  expect(page.url()).not.toMatch(/TEST_PRIVATE|editor|draft|token|members|returnTo/);
  await adminLink(page).click();
  await select(page, "products");
  await page.getByRole("button", { name: "새 상품 등록", exact: true }).click();
  await page
    .getByRole("textbox", { name: "상품명", exact: false })
    .fill("TEST_PRIVATE_DRAFT");
  expect(new URL(page.url()).searchParams.has("editor")).toBe(true);
  await expect(storeLink(page)).toHaveAttribute("href", storeHref(path, "products"));
  await roundTrip(page, path, "products");
  await expect(page.getByRole("textbox", { name: "상품명", exact: false })).toHaveCount(
    0,
  );
  await expect(
    page.getByRole("button", { name: "새 상품 등록", exact: true }),
  ).toBeVisible();
  expect(page.url()).not.toMatch(/editor|TEST_PRIVATE_DRAFT/);
  await page.goto(
    `/admin?returnTo=${encodeURIComponent("/admin?adminSection=inventory")}&section=inventory`,
  );
  await expect(storeLink(page)).toHaveAttribute("href", "/?adminSection=inventory");
  await storeLink(page).click();
  await expect(adminLink(page)).toHaveAttribute("href", "/admin?section=inventory");
  await page.goto(
    "/products?slug=synthetic-menu-product-b&slug=ambiguous&adminSection=inventory",
  );
  await expect(adminLink(page)).toHaveAttribute("href", "/admin");
});

test("anonymous and member URLs cannot mount an admin menu or read admin data", async ({
  page,
}) => {
  const path = `${PRODUCT_B}&adminSection=inventory`;
  const audit = await setup(page, { path, groups: [] });
  await expect(adminLink(page)).toHaveCount(0);
  await page.goto(entryHref(PRODUCT_B, "inventory"));
  await expect(
    page.getByRole("heading", { name: "관리자 권한이 없습니다", exact: true }),
  ).toBeVisible();
  await expect(page.locator("#admin-panel-inventory")).toHaveCount(0);
  await expect(storeLink(page)).toHaveAttribute("href", PRODUCT_B);
  expect(audit.reads.filter((path) => path.includes("/admin/"))).toEqual([]);
  await page.evaluate(() => {
    sessionStorage.removeItem("paradays.auth.session");
    localStorage.removeItem("paradays.auth.session");
  });
  await page.goto(entryHref(PRODUCT_B, "inventory"));
  await expect(
    page.getByRole("heading", { name: "관리자 로그인이 필요합니다", exact: true }),
  ).toBeVisible();
  await expect(storeLink(page)).toHaveAttribute("href", PRODUCT_B);
  expect(audit.reads.filter((path) => path.includes("/admin/"))).toEqual([]);
});

test("resuming sales returns to mode chooser and does not persist simulation state or add storage", async ({
  page,
}) => {
  const audit = await setup(page, { pending: true });
  await adminLink(page).click();
  await select(page, "sales");
  const storage = () =>
    page.evaluate(() => ({
      session: Object.fromEntries(
        Object.keys(sessionStorage)
          .sort()
          .map((key) => [key, sessionStorage.getItem(key)]),
      ),
      local: Object.fromEntries(
        Object.keys(localStorage)
          .sort()
          .map((key) => [key, localStorage.getItem(key)]),
      ),
    }));
  const before = await storage();
  await page
    .getByLabel("실제 장부와 재고를 바꾸지 않는 모의 체험임을 확인했습니다", {
      exact: true,
    })
    .check();
  await page
    .getByRole("button", { name: "모의 매출·일마감 체험", exact: true })
    .click();
  const reads = [...audit.reads];
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
  expect(audit.reads).toEqual(reads);
  await roundTrip(page, PRODUCT_A, "sales");
  await expect(
    page.getByRole("heading", { name: "매출·일마감 모드 선택", exact: true }),
  ).toBeVisible();
  await expect(
    page.getByRole("heading", { name: "모의 매출·일마감 체험", exact: true }),
  ).toHaveCount(0);
  await page
    .getByLabel("실제 장부와 재고를 바꾸지 않는 모의 체험임을 확인했습니다", {
      exact: true,
    })
    .check();
  await page
    .getByRole("button", { name: "모의 매출·일마감 체험", exact: true })
    .click();
  await expect(page.getByLabel("가상 데크 재고", { exact: true })).toHaveText("10개");
  expect(await storage()).toEqual(before);
  expect(await page.evaluate((key) => sessionStorage.getItem(key), PENDING_KEY)).toBe(
    PENDING,
  );
  expect(audit.reads.filter((path) => path.includes("/admin/sales/"))).toEqual([]);
});

test("home cart and account round trips recover their explicit admin menu", async ({
  page,
}) => {
  await setup(page, { path: "/" });
  for (const [path, section] of [
    ["/", "inventory"],
    ["/cart", "brands"],
    ["/account", "sales"],
  ] as const) {
    await page.goto(path);
    await adminLink(page).click();
    await select(page, section);
    await roundTrip(page, path, section);
  }
});

test("mobile video flow keeps the return link reachable and resumes the original menu", async ({
  page,
}) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await setup(page);
  await adminLink(page).click();
  await select(page, "inventory");
  const bounds = await storeLink(page).boundingBox();
  expect(bounds).not.toBeNull();
  expect(bounds!.x).toBeGreaterThanOrEqual(0);
  expect(bounds!.x + bounds!.width).toBeLessThanOrEqual(390);
  await roundTrip(page, PRODUCT_A, "inventory");
});
