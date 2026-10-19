import { expect, test, type Page, type Route } from "@playwright/test";

const ORIGIN = "http://127.0.0.1:3139";
const API = "https://api.sales.test/prod/";
const SUBJECT = "storefront-return-synthetic-admin";
const PRODUCT_A = "/products/odwyer-sync-1-8-375";
const PRODUCT_B = "/products?slug=synthetic-return-product-b";
const products = ["odwyer-sync-1-8-375", "synthetic-return-product-b"].map(
  (slug, index) => ({
    id: `prd_return_synthetic_${index}`,
    slug,
    name: `[TEST] Return product ${index === 0 ? "A" : "B"}`,
    brand: "TEST",
    category: "Deck",
    price: 10_000,
    inventoryQuantity: 10,
    image: "/images/product-placeholder.svg",
    description: ["Synthetic storefront return fixture"],
    sizes: ["TEST"],
  }),
);
type Audit = { blocked: string[]; reads: string[]; writes: string[] };
const audits = new WeakMap<Page, Audit>();

function respond(route: Route, body: unknown, status = 200) {
  return route.fulfill({
    status,
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
  } = {},
) {
  const audit: Audit = { blocked: [], reads: [], writes: [] };
  audits.set(page, audit);
  await page.route("**/*", async (route) => {
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
  await page.addInitScript(
    ({ session, anonymous }) => {
      if (!sessionStorage.getItem("synthetic_storefront_return_bootstrapped")) {
        if (!anonymous)
          sessionStorage.setItem("paradays.auth.session", JSON.stringify(session));
        sessionStorage.setItem("synthetic_storefront_return_bootstrapped", "yes");
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
    },
  );
  await page.goto(options.path ?? PRODUCT_A);
  await page.waitForLoadState("networkidle");
  return audit;
}

async function enterAdmin(page: Page) {
  await page.getByRole("link", { name: "관리자페이지", exact: true }).click();
  await expect(page.locator("#admin-panel-overview")).toBeVisible();
}
function backToStore(page: Page) {
  return page.getByRole("link", { name: "스토어로 돌아가기", exact: true });
}
async function select(page: Page, name: string) {
  const tab = page.getByRole("tab", { name, exact: true, includeHidden: true });
  await expect(tab).toBeAttached();
  if (await page.evaluate(() => matchMedia("(min-width: 1024px)").matches))
    await expect(tab).toBeVisible();
  else if (!(await tab.isVisible()))
    await page.getByRole("button", { name: "운영 메뉴 열기", exact: true }).click();
  await tab.click();
}
function adminHref(returnTo: string) {
  return `/admin?${new URLSearchParams({ returnTo }).toString()}`;
}
function resumedStoreHref(path: string, section: string) {
  const url = new URL(path, ORIGIN);
  url.searchParams.set("adminSection", section);
  return `${url.pathname}${url.search}${url.hash}`;
}

test.afterEach(async ({ page }) => {
  expect(audits.get(page)?.blocked ?? []).toEqual([]);
  expect(audits.get(page)?.writes ?? []).toEqual([]);
});

test("product detail to admin to storefront return opens the same product, not home", async ({
  page,
}) => {
  await setup(page);
  await expect(page.getByRole("heading", { name: products[0].name })).toBeVisible();
  await enterAdmin(page);
  await expect(backToStore(page)).toHaveAttribute("href", PRODUCT_A);
  await backToStore(page).click();
  await expect(page).toHaveURL(`${ORIGIN}${PRODUCT_A}`);
  await expect(page.getByRole("heading", { name: products[0].name })).toBeVisible();
});

test("return survives internal menus and Back/Forward without changing its entry product", async ({
  page,
}) => {
  await setup(page);
  await enterAdmin(page);
  const entry = page.url();
  await select(page, "재고 수정");
  await select(page, "매출·일마감");
  await select(page, "브랜드");
  const lastAdmin = page.url();
  await page.goBack();
  await expect(page.locator("#admin-panel-sales")).toBeVisible();
  await page.goForward();
  await expect(page.locator("#admin-panel-brands")).toBeVisible();
  await expect(backToStore(page)).toHaveAttribute(
    "href",
    resumedStoreHref(PRODUCT_A, "brands"),
  );
  await backToStore(page).click();
  await expect(page).toHaveURL(`${ORIGIN}${resumedStoreHref(PRODUCT_A, "brands")}`);
  await page.goBack();
  await expect(page).toHaveURL(lastAdmin);
  await expect(page.locator("#admin-panel-brands")).toBeVisible();
  await page.goBack();
  await page.goBack();
  await page.goBack();
  await expect(page).toHaveURL(entry);
  await page.goBack();
  await expect(page).toHaveURL(`${ORIGIN}${PRODUCT_A}`);
});

test("query-based product preserves public query and fragment but removes private query after reload", async ({
  page,
}) => {
  const path = `${PRODUCT_B}&locale=ko&token=TEST_SECRET&email=synthetic%40invalid.test#details`;
  const expected = `${PRODUCT_B}&locale=ko#details`;
  await setup(page, { path });
  await expect(page.getByRole("heading", { name: products[1].name })).toBeVisible();
  await enterAdmin(page);
  await select(page, "재고 수정");
  await page.reload();
  await expect(page.locator("#admin-panel-inventory")).toBeVisible();
  await expect(backToStore(page)).toHaveAttribute(
    "href",
    resumedStoreHref(expected, "inventory"),
  );
  await backToStore(page).click();
  await expect(page).toHaveURL(`${ORIGIN}${resumedStoreHref(expected, "inventory")}`);
  await expect(page.getByRole("heading", { name: products[1].name })).toBeVisible();
});

test("a later entry from a different product never reuses the first product", async ({
  page,
}) => {
  await setup(page);
  await enterAdmin(page);
  await backToStore(page).click();
  await page.goto(PRODUCT_B);
  await expect(page.getByRole("heading", { name: products[1].name })).toBeVisible();
  await enterAdmin(page);
  await expect(backToStore(page)).toHaveAttribute("href", PRODUCT_B);
  await backToStore(page).click();
  await expect(page).toHaveURL(`${ORIGIN}${PRODUCT_B}`);
});

test("direct admin entry falls back to home instead of stale browser history", async ({
  page,
}) => {
  await setup(page);
  await enterAdmin(page);
  await backToStore(page).click();
  await page.goto("/admin");
  await expect(backToStore(page)).toHaveAttribute("href", "/");
  await backToStore(page).click();
  await expect(page).toHaveURL(`${ORIGIN}/`);
});

test("hash-only changes immediately before admin entry preserve the current fragment", async ({
  page,
}) => {
  await setup(page);
  await page.evaluate(() => {
    window.location.hash = "reviews";
  });
  await expect(
    page.getByRole("link", { name: "관리자페이지", exact: true }),
  ).toHaveAttribute("href", adminHref(`${PRODUCT_A}#reviews`));
  await enterAdmin(page);
  await expect(backToStore(page)).toHaveAttribute("href", `${PRODUCT_A}#reviews`);
});

test("query-only product changes immediately before entry preserve the current query", async ({
  page,
}) => {
  await setup(page, { path: PRODUCT_B });
  await page.evaluate(() => {
    window.history.pushState(
      null,
      "",
      `${window.location.pathname}${window.location.search}&locale=en&token=TEST_SECRET`,
    );
  });
  await expect(
    page.getByRole("link", { name: "관리자페이지", exact: true }),
  ).toHaveAttribute("href", adminHref(`${PRODUCT_B}&locale=en`));
  await enterAdmin(page);
  await expect(backToStore(page)).toHaveAttribute("href", `${PRODUCT_B}&locale=en`);
});

test("anonymous access panel safely returns to the product and retains admin entry for login", async ({
  page,
}) => {
  const path = `${adminHref(PRODUCT_A)}&section=inventory#admin-marker`;
  await setup(page, { path, anonymous: true });
  await expect(
    page.getByRole("heading", { name: "관리자 로그인이 필요합니다", exact: true }),
  ).toBeVisible();
  await expect(page.locator("#admin-panel-inventory")).toHaveCount(0);
  await expect(backToStore(page)).toHaveAttribute("href", PRODUCT_A);
  await page.getByRole("link", { name: "관리자 로그인", exact: true }).click();
  await expect(page).toHaveURL(`${ORIGIN}/login`);
  expect(
    await page.evaluate(() => sessionStorage.getItem("paradays-auth-return-to")),
  ).toBe(path);
});

test("member access panel has the same safe storefront return without mounting admin data", async ({
  page,
}) => {
  const audit = await setup(page, { path: adminHref(PRODUCT_B), groups: [] });
  await expect(
    page.getByRole("heading", { name: "관리자 권한이 없습니다", exact: true }),
  ).toBeVisible();
  await expect(page.locator("#admin-panel-overview")).toHaveCount(0);
  await expect(backToStore(page)).toHaveAttribute("href", PRODUCT_B);
  expect(audit.reads.filter((path) => path.includes("/admin/"))).toEqual([]);
  await backToStore(page).click();
  await expect(page).toHaveURL(`${ORIGIN}${PRODUCT_B}`);
});

test("external, ambiguous, auth, admin and encoded unsafe return paths fall back to home", async ({
  page,
}) => {
  test.setTimeout(90_000);
  await setup(page, { path: "/admin" });
  for (const target of [
    "https://malicious.invalid/",
    "//malicious.invalid/",
    "javascript:alert(1)",
    "/\\malicious.invalid",
    "/%2f%2fmalicious.invalid",
    "/%5cmalicious.invalid",
    "/%0amalicious.invalid",
    "/login",
    "/signup?returnTo=/",
    "/auth/callback?code=TEST_ONLY",
    "/admin",
    "/admin?section=inventory",
    "/products/../admin",
    "/%61dmin",
    " /products?slug=test",
  ]) {
    await page.goto(adminHref(target));
    await expect(backToStore(page), `Unsafe target ${target}`).toHaveAttribute(
      "href",
      "/",
    );
  }
});

test("duplicate or empty return targets fall back to home", async ({ page }) => {
  await setup(page, { path: "/admin" });
  for (const query of [
    "returnTo=",
    new URLSearchParams([
      ["returnTo", PRODUCT_A],
      ["returnTo", PRODUCT_B],
    ]).toString(),
    new URLSearchParams([
      ["returnTo", PRODUCT_A],
      ["returnTo", PRODUCT_A],
    ]).toString(),
  ]) {
    await page.goto(`/admin?${query}`);
    await expect(backToStore(page)).toHaveAttribute("href", "/");
  }
});

test("duplicate public identity query is rejected and unknown private anchors are removed", async ({
  page,
}) => {
  await setup(page, { path: "/admin" });
  for (const target of [
    `${PRODUCT_B}&slug=another-product`,
    `${PRODUCT_B}&locale=ko&locale=en`,
  ]) {
    await page.goto(adminHref(target));
    await expect(backToStore(page)).toHaveAttribute("href", "/");
  }
  await page.goto(
    adminHref(`${PRODUCT_A}?draft=TEST_PRIVATE&code=TEST_PRIVATE#TEST_PRIVATE`),
  );
  await expect(backToStore(page)).toHaveAttribute("href", PRODUCT_A);
});

test("the real admin link carries its return target when opened in another tab", async ({
  page,
}) => {
  await setup(page, { path: `${PRODUCT_B}&locale=ko#description` });
  const href = await page
    .getByRole("link", { name: "관리자페이지", exact: true })
    .getAttribute("href");
  expect(href).toBe(adminHref(`${PRODUCT_B}&locale=ko#description`));
  const other = await page.context().newPage();
  try {
    const audit = await setup(other, { path: href! });
    await expect(backToStore(other)).toHaveAttribute(
      "href",
      `${PRODUCT_B}&locale=ko#description`,
    );
    await backToStore(other).click();
    await expect(other).toHaveURL(`${ORIGIN}${PRODUCT_B}&locale=ko#description`);
    expect(audit.blocked).toEqual([]);
    expect(audit.writes).toEqual([]);
  } finally {
    await other.close();
  }
});

test("cart and account entries return to their own allowed storefront route", async ({
  page,
}) => {
  await setup(page, { path: "/cart" });
  for (const path of ["/cart", "/account"]) {
    await page.goto(path);
    await enterAdmin(page);
    await expect(backToStore(page)).toHaveAttribute("href", path);
    await backToStore(page).click();
    await expect(page).toHaveURL(`${ORIGIN}${path}`);
  }
});

test("mobile return link stays reachable and restores the original detail", async ({
  page,
}) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await setup(page, { path: PRODUCT_B });
  await enterAdmin(page);
  await select(page, "재고 수정");
  await expect(backToStore(page)).toBeVisible();
  const bounds = await backToStore(page).boundingBox();
  expect(bounds).not.toBeNull();
  expect(bounds!.x).toBeGreaterThanOrEqual(0);
  expect(bounds!.x + bounds!.width).toBeLessThanOrEqual(390);
  await backToStore(page).click();
  await expect(page).toHaveURL(`${ORIGIN}${resumedStoreHref(PRODUCT_B, "inventory")}`);
  await expect(page.getByRole("heading", { name: products[1].name })).toBeVisible();
});
