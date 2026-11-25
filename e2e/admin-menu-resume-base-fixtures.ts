import { expect, type Page, type Route } from "@playwright/test";

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

export {
  active,
  adminLink,
  audits,
  entryHref,
  ORIGIN,
  PENDING,
  PENDING_KEY,
  PRODUCT_A,
  PRODUCT_B,
  products,
  roundTrip,
  sections,
  select,
  setup,
  storeHref,
  storeLink,
};
