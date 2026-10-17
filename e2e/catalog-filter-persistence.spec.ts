import { expect, test, type Page, type Route } from "@playwright/test";

const ORIGIN = "http://127.0.0.1:3139";
const API = "https://api.sales.test";
const KEY = "paradays:catalog-filters:v1";
const SUBJECT = "catalog-filter-synthetic-admin";
const SENTINEL = "TEST_UNTOUCHED_STATE";
type Audit = {
  blocked: string[];
  writes: string[];
  pageErrors: string[];
  hydrationErrors: string[];
};
const audits = new WeakMap<Page, Audit>();
type SetupOptions = {
  stored?: string;
  storageFailure?: "read" | "write" | "getter";
};

function respond(route: Route, json: unknown) {
  return route.fulfill({
    status: 200,
    json,
    headers: {
      "access-control-allow-origin": "*",
      "access-control-allow-headers": "authorization,content-type",
    },
  });
}

async function setup(page: Page, options: SetupOptions = {}) {
  const audit: Audit = {
    blocked: [],
    writes: [],
    pageErrors: [],
    hydrationErrors: [],
  };
  audits.set(page, audit);
  page.on("pageerror", (error) => audit.pageErrors.push(error.message));
  page.on("console", (message) => {
    if (
      message.type() === "error" &&
      /hydrat|server rendered|server-rendered/i.test(message.text())
    )
      audit.hydrationErrors.push(message.text());
  });
  await page.route("**/*", async (route) => {
    const request = route.request();
    const url = new URL(request.url());
    const description = `${request.method()} ${url.origin}${url.pathname}`;
    if (url.origin === ORIGIN && ["GET", "HEAD"].includes(request.method()))
      return route.continue();
    if (!["GET", "HEAD", "OPTIONS"].includes(request.method())) {
      audit.writes.push(description);
      return route.abort();
    }
    if (url.origin !== API) {
      audit.blocked.push(description);
      return route.abort();
    }
    if (request.method() === "OPTIONS") return respond(route, {});
    if (
      ["/prod/catalog/products", "/prod/admin/catalog/products"].includes(url.pathname)
    )
      return respond(route, { products: [] });
    if (url.pathname === "/prod/me")
      return respond(route, { userSub: SUBJECT, marketingConsent: false });
    if (url.pathname === "/prod/orders") return respond(route, { orders: [] });
    if (url.pathname === "/prod/admin/overview")
      return respond(route, {
        asOf: "2026-10-18T00:00:00Z",
        timezone: "Asia/Seoul",
        todayOrderCount: 0,
        lowStockCount: 0,
        lowStockThreshold: 3,
        activeCouponCount: 0,
        marketingConsentCount: 0,
      });
    audit.blocked.push(description);
    return route.abort();
  });
  // Deliberately invalid signature, usable only with intercepted synthetic APIs.
  const accessToken = [
    Buffer.from(JSON.stringify({ alg: "none", typ: "JWT" })).toString("base64url"),
    Buffer.from(
      JSON.stringify({ sub: SUBJECT, exp: 4102444800, "cognito:groups": ["admin"] }),
    ).toString("base64url"),
    "test-only-signature",
  ].join(".");
  await page.addInitScript(
    ({ accessToken, key, subject, sentinel, stored, storageFailure }) => {
      const session = window.sessionStorage;
      if (!session.getItem("synthetic_filter_bootstrapped")) {
        session.setItem(
          "paradays.auth.session",
          JSON.stringify({
            accessToken,
            expiresAt: 4102444800000,
            user: { sub: subject, username: "synthetic-admin", groups: ["admin"] },
          }),
        );
        session.setItem("synthetic_filter_bootstrapped", "yes");
        session.setItem("synthetic:filter-untouched", sentinel);
        if (stored !== undefined) session.setItem(key, stored);
      }
      localStorage.setItem("paradays-locale", "ko");
      localStorage.setItem("synthetic:filter-untouched", sentinel);
      if (storageFailure === "getter") {
        Object.defineProperty(window, "sessionStorage", {
          configurable: true,
          get: () => {
            throw new DOMException("Synthetic storage denial", "SecurityError");
          },
        });
      } else if (storageFailure === "read") {
        const original = Storage.prototype.getItem;
        Storage.prototype.getItem = function (candidate) {
          if (this === session && candidate === key)
            throw new DOMException("Synthetic read denial", "SecurityError");
          return original.call(this, candidate);
        };
      } else if (storageFailure === "write") {
        const setItem = Storage.prototype.setItem;
        const removeItem = Storage.prototype.removeItem;
        Storage.prototype.setItem = function (candidate, value) {
          if (this === session && candidate === key)
            throw new DOMException("Synthetic write denial", "QuotaExceededError");
          return setItem.call(this, candidate, value);
        };
        Storage.prototype.removeItem = function (candidate) {
          if (this === session && candidate === key)
            throw new DOMException("Synthetic removal denial", "SecurityError");
          return removeItem.call(this, candidate);
        };
      }
    },
    {
      accessToken,
      key: KEY,
      subject: SUBJECT,
      sentinel: SENTINEL,
      stored: options.stored,
      storageFailure: options.storageFailure,
    },
  );
  await page.goto("/");
  await page.waitForLoadState("networkidle");
}

async function openMenu(page: Page) {
  const menu = page.getByRole("button", { name: "Menu", exact: true });
  // Explicit desktop keyboard open avoids hover/toggle timing between checks.
  if ((await menu.getAttribute("aria-expanded")) !== "true") {
    if ((page.viewportSize()?.width ?? 0) < 768) await menu.tap();
    else await menu.press("ArrowDown");
  }
  await expect(menu).toHaveAttribute("aria-expanded", "true");
  await expect(page.locator("#store-menu-dropdown")).toBeVisible();
  return page.locator("#store-menu-dropdown");
}

async function closeMenu(page: Page) {
  const menu = page.getByRole("button", { name: "Menu", exact: true });
  if ((await menu.getAttribute("aria-expanded")) === "true") await menu.press("Enter");
  await expect(menu).toHaveAttribute("aria-expanded", "false");
}

async function choose(page: Page, names: readonly string[]) {
  const dropdown = await openMenu(page);
  for (const name of names) {
    const item = dropdown.getByRole("button", { name, exact: true });
    if ((page.viewportSize()?.width ?? 0) < 768) await item.tap();
    else await item.press("Enter");
  }
  await closeMenu(page);
}

async function assertSelected(page: Page, names: readonly string[]) {
  const dropdown = await openMenu(page);
  for (const name of names)
    await expect(dropdown.getByRole("button", { name, exact: true })).toHaveAttribute(
      "aria-pressed",
      "true",
    );
  await closeMenu(page);
}

async function productHrefs(page: Page) {
  const list = page.getByRole("list", { name: "PARADAYS products" });
  await expect(list).not.toHaveAttribute("aria-busy", "true");
  return list
    .getByRole("link")
    .evaluateAll((links) => links.map((link) => link.getAttribute("href")).sort());
}

async function assertAprilDeck(page: Page) {
  await assertSelected(page, ["데크", "April"]);
  expect(await productHrefs(page)).toEqual(["/products/odwyer-sync-1-8-375"]);
  expect(
    await page.evaluate((key) => JSON.parse(sessionStorage.getItem(key)!), KEY),
  ).toEqual({ version: 1, selectedIds: ["brand-april", "deck"] });
}

async function enter(page: Page, destination: "admin" | "cart" | "account") {
  await page
    .getByRole("link", {
      name:
        destination === "admin"
          ? "관리자페이지"
          : destination === "account"
            ? "마이페이지"
            : /^Cart/,
      exact: destination !== "cart",
    })
    .click();
  await expect(page).toHaveURL(`${ORIGIN}/${destination}`);
  await page.waitForLoadState("networkidle");
}

async function leave(page: Page, destination: "admin" | "cart" | "account") {
  await page
    .getByRole("link", {
      name:
        destination === "admin"
          ? "스토어로 돌아가기"
          : destination === "cart"
            ? "쇼핑 계속하기"
            : "Home",
      exact: true,
    })
    .click();
  await expect(page).toHaveURL(`${ORIGIN}/`);
  await page.waitForLoadState("networkidle");
}

async function unrelatedStorage(page: Page) {
  return page.evaluate((key) => {
    const snapshot = (storage: Storage) =>
      Object.fromEntries(
        Object.keys(storage)
          .filter((candidate) => candidate !== key)
          .sort()
          .map((candidate) => [candidate, storage.getItem(candidate)]),
      );
    return { session: snapshot(sessionStorage), local: snapshot(localStorage) };
  }, KEY);
}

test.afterEach(async ({ page }) => {
  const audit = audits.get(page);
  expect(audit?.blocked ?? []).toEqual([]);
  expect(audit?.writes ?? []).toEqual([]);
  expect(audit?.pageErrors ?? []).toEqual([]);
  expect(audit?.hydrationErrors ?? []).toEqual([]);
});

for (const destination of ["admin", "cart", "account"] as const) {
  test(`${destination}: links, Back/Forward, intermediate reload and hard return keep the same menu and products`, async ({
    page,
  }) => {
    await setup(page);
    const untouched = await unrelatedStorage(page);
    await choose(page, ["데크", "April"]);
    await assertAprilDeck(page);
    await enter(page, destination);
    await leave(page, destination);
    await assertAprilDeck(page);
    await enter(page, destination);
    await page.goBack();
    await assertAprilDeck(page);
    await page.goForward();
    await expect(page).toHaveURL(`${ORIGIN}/${destination}`);
    await page.reload();
    await page.waitForLoadState("networkidle");
    await leave(page, destination);
    await assertAprilDeck(page);
    await enter(page, destination);
    await page.goto("/");
    await page.waitForLoadState("networkidle");
    await assertAprilDeck(page);
    expect(await unrelatedStorage(page)).toEqual(untouched);
  });
}

test("stored selection hydrates without replacing it with the initial empty state", async ({
  page,
}) => {
  const stored = JSON.stringify({ version: 1, selectedIds: ["deck", "brand-april"] });
  await setup(page, { stored });
  await assertSelected(page, ["데크", "April"]);
  expect(await productHrefs(page)).toEqual(["/products/odwyer-sync-1-8-375"]);
  expect(await page.evaluate((key) => sessionStorage.getItem(key), KEY)).toBe(stored);
  await page.reload();
  await assertSelected(page, ["데크", "April"]);
  expect(await page.evaluate((key) => sessionStorage.getItem(key), KEY)).toBe(stored);
});

test("root All explicitly clears the saved filter and remains cleared after reload", async ({
  page,
}) => {
  await setup(page);
  const all = await productHrefs(page);
  const untouched = await unrelatedStorage(page);
  await choose(page, ["데크", "April"]);
  await page.reload();
  const dropdown = await openMenu(page);
  await dropdown
    .getByRole("button", { name: "전체", exact: true })
    .first()
    .press("Enter");
  await closeMenu(page);
  expect(await page.evaluate((key) => sessionStorage.getItem(key), KEY)).toBeNull();
  await page.reload();
  expect(await productHrefs(page)).toEqual(all);
  expect(await unrelatedStorage(page)).toEqual(untouched);
});

test("category and brand group All replacement and SALE remain consistent after reload", async ({
  page,
}) => {
  await setup(page);
  const dropdown = await openMenu(page);
  const all = dropdown.getByRole("button", { name: "전체", exact: true });
  await all.nth(1).press("Enter");
  await dropdown.getByRole("button", { name: "상의", exact: true }).press("Enter");
  await expect(all.nth(1)).toHaveAttribute("aria-pressed", "false");
  await all.nth(2).press("Enter");
  await dropdown.getByRole("button", { name: "데크", exact: true }).press("Enter");
  await expect(all.nth(2)).toHaveAttribute("aria-pressed", "false");
  await all.nth(3).press("Enter");
  await dropdown.getByRole("button", { name: "April", exact: true }).press("Enter");
  await expect(all.nth(3)).toHaveAttribute("aria-pressed", "false");
  await dropdown.getByRole("button", { name: "SALE", exact: true }).press("Enter");
  await closeMenu(page);
  await page.reload();
  await assertSelected(page, ["상의", "데크", "April", "SALE"]);
  expect(
    await page.evaluate((key) => JSON.parse(sessionStorage.getItem(key)!), KEY),
  ).toEqual({ version: 1, selectedIds: ["brand-april", "deck", "sale", "top"] });
  await expect(page.getByRole("list", { name: "PARADAYS products" })).toHaveCount(0);
});

for (const [name, stored] of [
  ["malformed JSON", "not-json"],
  ["unknown ID", JSON.stringify({ version: 1, selectedIds: ["private-unknown"] })],
  ["old version", JSON.stringify({ version: 0, selectedIds: ["deck"] })],
  [
    "conflicting group All",
    JSON.stringify({ version: 1, selectedIds: ["skateboard-all", "deck"] }),
  ],
  ["extra field", JSON.stringify({ version: 1, selectedIds: ["deck"], extra: true })],
  ["oversized payload", " ".repeat(4_097)],
] as const) {
  test(`${name} safely falls back to All without altering unrelated storage`, async ({
    page,
  }) => {
    await setup(page, { stored });
    const dropdown = await openMenu(page);
    await expect(
      dropdown.getByRole("button", { name: "전체", exact: true }).first(),
    ).toHaveAttribute("aria-pressed", "true");
    await expect(
      dropdown.getByRole("button", { name: "데크", exact: true }),
    ).toHaveAttribute("aria-pressed", "false");
    await closeMenu(page);
    expect((await productHrefs(page)).length).toBeGreaterThan(1);
    expect(
      await page.evaluate(() => ({
        session: sessionStorage.getItem("synthetic:filter-untouched"),
        local: localStorage.getItem("synthetic:filter-untouched"),
      })),
    ).toEqual({ session: SENTINEL, local: SENTINEL });
    await choose(page, ["데크", "April"]);
    await page.reload();
    await assertAprilDeck(page);
  });
}

test("visiting other pages without selecting a filter creates no filter storage key", async ({
  page,
}) => {
  await setup(page);
  const untouched = await unrelatedStorage(page);
  for (const destination of ["admin", "cart", "account"] as const) {
    await enter(page, destination);
    await page.reload();
    await page.waitForLoadState("networkidle");
    await leave(page, destination);
  }
  expect(await page.evaluate((key) => sessionStorage.getItem(key), KEY)).toBeNull();
  expect(await unrelatedStorage(page)).toEqual(untouched);
});

for (const failure of ["read", "write", "getter"] as const) {
  test(`${failure} denial does not break in-memory filters or soft cart return`, async ({
    page,
  }) => {
    await setup(page, { storageFailure: failure });
    await choose(page, ["데크", "April"]);
    await assertSelected(page, ["데크", "April"]);
    const filtered = await productHrefs(page);
    expect(filtered).toEqual(["/products/odwyer-sync-1-8-375"]);
    await enter(page, "cart");
    await leave(page, "cart");
    await assertSelected(page, ["데크", "April"]);
    expect(await productHrefs(page)).toEqual(filtered);
    const dropdown = await openMenu(page);
    await dropdown
      .getByRole("button", { name: "전체", exact: true })
      .first()
      .press("Enter");
    await closeMenu(page);
    expect((await productHrefs(page)).length).toBeGreaterThan(1);
  });
}

test("a separate independent browser context starts with no filters", async ({
  page,
  browser,
}) => {
  await setup(page);
  await choose(page, ["데크", "April"]);
  await assertAprilDeck(page);
  const independent = await browser.newContext();
  try {
    const second = await independent.newPage();
    await setup(second);
    expect(await second.evaluate((key) => sessionStorage.getItem(key), KEY)).toBeNull();
    const dropdown = await openMenu(second);
    await expect(
      dropdown.getByRole("button", { name: "전체", exact: true }).first(),
    ).toHaveAttribute("aria-pressed", "true");
    await closeMenu(second);
    expect((await productHrefs(second)).length).toBeGreaterThan(1);
    expect(audits.get(second)).toEqual({
      blocked: [],
      writes: [],
      pageErrors: [],
      hydrationErrors: [],
    });
    await assertAprilDeck(page);
  } finally {
    await independent.close();
  }
});
