import { expect, test, type Page, type Route } from "@playwright/test";

const ORIGIN = "http://127.0.0.1:3139";
const API = "https://api.sales.test/prod/";
const TRANSLATE = "https://api.mymemory.translated.net/get";
const SUBJECT = "deck-size-synthetic-admin";
const DECK = { slug: "odwyer-sync-1-8-375", id: "prd_deck_size_synthetic" };
const PLAIN = { slug: "synthetic-deck-without-spec", id: "prd_deck_size_plain" };
const SPEC = { nose: 6.875, tail: 6.5, width: 8.5, length: 31.75, wheelbase: 14.25 };

type Stored = {
  productId: string;
  slug: string;
  name: string;
  version: number;
  deckSpec?: typeof SPEC;
  sizes?: string[];
  deckSpecsBySize?: Record<string, typeof SPEC>;
};
type Audit = {
  blocked: string[];
  patches: Record<string, unknown>[];
  patchedIds: string[];
  store: Stored[];
};

function respond(route: Route, body: unknown, status = 200) {
  return route.fulfill({
    status,
    json: body,
    headers: {
      "access-control-allow-origin": "*",
      "access-control-allow-headers": "authorization,content-type",
      "access-control-allow-methods": "GET,PATCH,OPTIONS",
    },
  });
}

function adminShape(item: Stored) {
  return {
    productId: item.productId,
    slug: item.slug,
    name: item.name,
    brandId: "brand_test",
    brandName: "TEST",
    category: "Deck",
    price: 107_000,
    currency: "KRW",
    status: "PUBLISHED",
    inventoryQuantity: 5,
    featured: false,
    image: "/images/product-placeholder.svg",
    images: ["/images/product-placeholder.svg"],
    description: ["Synthetic deck size fixture"],
    sizes: item.sizes ?? ["8.5"],
    version: item.version,
    createdAt: "2026-10-28T00:00:00Z",
    updatedAt: "2026-10-28T00:00:00Z",
    ...(item.deckSpec ? { deckSpec: item.deckSpec } : {}),
    ...(item.deckSpecsBySize ? { deckSpecsBySize: item.deckSpecsBySize } : {}),
  };
}

function publicShape(item: Stored) {
  return {
    id: item.productId,
    slug: item.slug,
    name: item.name,
    category: "Deck",
    brand: "TEST",
    price: 107_000,
    inventoryQuantity: 5,
    image: "/images/product-placeholder.svg",
    description: ["Synthetic deck size fixture"],
    sizes: item.sizes ?? ["8.5"],
    featured: false,
    ...(item.deckSpec ? { deckSpec: item.deckSpec } : {}),
    ...(item.deckSpecsBySize ? { deckSpecsBySize: item.deckSpecsBySize } : {}),
  };
}

async function setup(
  page: Page,
  path: string,
  deckSpec?: typeof SPEC,
  deck: Partial<Stored> = {},
) {
  const store: Stored[] = [
    {
      productId: DECK.id,
      slug: DECK.slug,
      name: "[TEST] Deck size A",
      version: 3,
      deckSpec,
      ...deck,
    },
    { productId: PLAIN.id, slug: PLAIN.slug, name: "[TEST] Deck size B", version: 1 },
  ];
  const audit: Audit = { blocked: [], patches: [], patchedIds: [], store };
  await page.route("**/*", async (route) => {
    const request = route.request();
    const url = new URL(request.url());
    if (url.origin === ORIGIN && ["GET", "HEAD"].includes(request.method()))
      return route.continue();
    if (request.url().startsWith(TRANSLATE))
      return respond(route, {
        responseStatus: 200,
        responseData: { translatedText: url.searchParams.get("q") ?? "" },
      });
    if (!request.url().startsWith(API)) {
      audit.blocked.push(`${request.method()} ${url.origin}${url.pathname}`);
      return route.abort();
    }
    if (request.method() === "OPTIONS") return respond(route, {});
    const itemMatch = /^\/prod\/admin\/catalog\/products\/([^/]+)$/.exec(url.pathname);
    if (request.method() === "PATCH" && itemMatch) {
      const body = request.postDataJSON() as Record<string, unknown>;
      audit.patches.push(body);
      audit.patchedIds.push(itemMatch[1]);
      const item = store.find((entry) => entry.productId === itemMatch[1]);
      if (!item) return respond(route, { code: "CATALOG_PRODUCT_NOT_FOUND" }, 404);
      if (body.version !== item.version)
        return respond(route, { code: "CATALOG_PRODUCT_VERSION_CONFLICT" }, 409);
      if ("deckSpec" in body) {
        if (body.deckSpec) item.deckSpec = body.deckSpec as typeof SPEC;
        else delete item.deckSpec;
      }
      if ("sizeDeckSpec" in body) {
        const map = { ...item.deckSpecsBySize };
        if (body.sizeDeckSpec)
          map[body.size as string] = body.sizeDeckSpec as typeof SPEC;
        else delete map[body.size as string];
        item.deckSpecsBySize = Object.keys(map).length ? map : undefined;
      }
      item.version += 1;
      return respond(route, { product: adminShape(item) });
    }
    if (request.method() !== "GET") {
      audit.blocked.push(`${request.method()} ${url.pathname}`);
      return route.abort();
    }
    if (url.pathname === "/prod/catalog/products") {
      const slug = url.searchParams.get("slug");
      const found = store.find((item) => item.slug === slug);
      return slug
        ? found
          ? respond(route, { product: publicShape(found) })
          : respond(route, { code: "NOT_FOUND" }, 404)
        : respond(route, { products: store.map(publicShape) });
    }
    if (url.pathname === "/prod/admin/catalog/products")
      return respond(route, { products: store.map(adminShape) });
    if (url.pathname === "/prod/admin/overview")
      return respond(route, {
        asOf: "2026-10-28T00:00:00Z",
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
    audit.blocked.push(`GET ${url.pathname}`);
    return route.abort();
  });
  const accessToken = [
    Buffer.from(JSON.stringify({ alg: "none", typ: "JWT" })).toString("base64url"),
    Buffer.from(
      JSON.stringify({ sub: SUBJECT, exp: 4102444800, "cognito:groups": ["admin"] }),
    ).toString("base64url"),
    "test-only-signature",
  ].join(".");
  // Counts PATCH responses the app has parsed, plus a task and two frames so React has committed the result.
  await page.addInitScript(() => {
    const state = window as unknown as { __patchSettled: number };
    state.__patchSettled = 0;
    const originalFetch = window.fetch.bind(window);
    window.fetch = async (input, init) => {
      const response = await originalFetch(input, init);
      if (init?.method === "PATCH") {
        const json = response.json.bind(response);
        response.json = async () => {
          try {
            return await json();
          } finally {
            setTimeout(() =>
              requestAnimationFrame(() =>
                requestAnimationFrame(() => {
                  state.__patchSettled += 1;
                }),
              ),
            );
          }
        };
      }
      return response;
    };
  });
  await page.addInitScript(
    ({ session }) => {
      sessionStorage.setItem("paradays.auth.session", JSON.stringify(session));
      localStorage.setItem("paradays-locale", "ko");
    },
    {
      session: {
        accessToken,
        expiresAt: 4102444800000,
        user: { sub: SUBJECT, username: "synthetic-admin", groups: ["admin"] },
      },
    },
  );
  await page.goto(path);
  await page.waitForLoadState("networkidle");
  return audit;
}

test("admin saves the deck size spec from its own modal and the product form saves without a conflict", async ({
  page,
}) => {
  const audit = await setup(page, "/admin?section=products");
  const row = page
    .getByRole("list", { name: "상품 목록" })
    .getByRole("listitem")
    .filter({ hasText: "[TEST] Deck size A" });
  await row.getByRole("button", { name: "수정", exact: true }).click();

  await page.getByRole("button", { name: "+ 상세사이즈 등록" }).click();
  const dialog = page.getByRole("dialog");
  await expect(dialog).toBeVisible();
  await expect(
    dialog.getByRole("button", { name: "저장", exact: true }),
  ).toBeDisabled();
  for (const [field, value] of Object.entries(SPEC))
    await dialog.getByRole("textbox", { name: field }).fill(String(value));
  await expect(dialog).toContainText("(17.5cm)");
  await expect(dialog.locator("svg")).toContainText('6.875"');
  await dialog.getByRole("button", { name: "저장", exact: true }).click();

  await expect(dialog).toBeHidden();
  expect(audit.patches).toEqual([{ version: 3, deckSpec: SPEC }]);
  await expect(page.getByText('8.5" × 31.75" · WB 14.25"')).toBeVisible();
  await expect(page.getByRole("button", { name: "상세사이즈 수정" })).toBeVisible();

  // Saving a public product asks for confirmation first.
  page.once("dialog", (prompt) => void prompt.accept());
  await page.getByRole("button", { name: /수정 저장/ }).click();
  await expect(page.getByText("상품을 공개 상태로 저장했습니다")).toBeVisible();
  expect(audit.patchedIds).toEqual([DECK.id, DECK.id]);
  expect(audit.patches[1]).toMatchObject({ version: 4 });
  expect(audit.patches[1]).not.toHaveProperty("deckSpec");
  expect(audit.blocked).toEqual([]);
});

test("admin saves, switches and deletes per-option size charts without touching the default", async ({
  page,
}) => {
  const option85 = { ...SPEC, width: 8.5, wheelbase: 14.5 };
  const option825 = { ...SPEC, width: 8.25, wheelbase: 14 };
  const audit = await setup(page, "/admin?section=products", SPEC, {
    sizes: ["8.25", "8.5"],
    deckSpecsBySize: { "8.5": option85 },
  });
  const item = audit.store.find((entry) => entry.productId === DECK.id)!;
  await page
    .getByRole("list", { name: "상품 목록" })
    .getByRole("listitem")
    .filter({ hasText: "[TEST] Deck size A" })
    .getByRole("button", { name: "수정", exact: true })
    .click();
  await expect(
    page.getByText('기본 8.5" × 31.75" · WB 14.25" · 옵션별 1개'),
  ).toBeVisible();
  await expect(
    page.getByText(
      "옵션 이름을 바꾸거나 지우고 상품을 저장하면 그 옵션의 상세사이즈는 지워집니다.",
    ),
  ).toBeVisible();
  const dialog = page.getByRole("dialog");
  const target = dialog.getByRole("combobox", { name: "적용 대상" });
  const input = (field: string) => dialog.getByRole("textbox", { name: field });
  const openModal = async () => {
    await page.getByRole("button", { name: "상세사이즈 수정" }).click();
    await expect(target).toHaveValue("");
  };

  // Switching the target refills the inputs with that target's saved values.
  await openModal();
  await expect(input("wheelbase")).toHaveValue("14.25");
  await target.selectOption("8.5");
  await expect(input("wheelbase")).toHaveValue("14.5");
  await expect(dialog.getByRole("button", { name: "삭제", exact: true })).toBeVisible();
  await target.selectOption("8.25");
  await expect(input("wheelbase")).toHaveValue("");
  await expect(dialog).toContainText("이 옵션은 지금 기본값을 표시합니다.");
  await expect(dialog.getByRole("button", { name: "삭제", exact: true })).toHaveCount(
    0,
  );
  for (const [field, value] of Object.entries(option825))
    await input(field).fill(String(value));
  await dialog.getByRole("button", { name: "저장", exact: true }).click();
  await expect(dialog).toBeHidden();
  expect(audit.patches).toEqual([
    { version: 3, size: "8.25", sizeDeckSpec: option825 },
  ]);
  expect(item.deckSpec).toEqual(SPEC);
  await expect(
    page.getByText('기본 8.5" × 31.75" · WB 14.25" · 옵션별 2개'),
  ).toBeVisible();

  // Deleting an option removes only that option.
  await openModal();
  await target.selectOption("8.5");
  await dialog.getByRole("button", { name: "삭제", exact: true }).click();
  await expect(dialog).toBeHidden();
  expect(audit.patches[1]).toEqual({ version: 4, size: "8.5", sizeDeckSpec: null });
  expect(item.deckSpecsBySize).toEqual({ "8.25": option825 });
  expect(item.deckSpec).toEqual(SPEC);

  // Saving without picking an option keeps the old default-only body.
  await openModal();
  await input("tail").fill("6.625");
  await dialog.getByRole("button", { name: "저장", exact: true }).click();
  await expect(dialog).toBeHidden();
  expect(audit.patches[2]).toEqual({ version: 5, deckSpec: { ...SPEC, tail: 6.625 } });
  expect(item.deckSpecsBySize).toEqual({ "8.25": option825 });
  expect(audit.blocked).toEqual([]);
});

test("without a default, the summary counts option charts and unsaved options are not offered", async ({
  page,
}) => {
  const audit = await setup(page, "/admin?section=products", undefined, {
    sizes: ["8.25", "8.5"],
    deckSpecsBySize: { "8.5": SPEC },
  });
  await page
    .getByRole("list", { name: "상품 목록" })
    .getByRole("listitem")
    .filter({ hasText: "[TEST] Deck size A" })
    .getByRole("button", { name: "수정", exact: true })
    .click();
  await expect(page.getByText("기본 미등록 · 옵션별 1개")).toBeVisible();
  await expect(page.getByRole("button", { name: "상세사이즈 수정" })).toBeVisible();
  await expect(
    page.getByText(
      "바뀐 옵션은 상품을 먼저 저장해야 상세사이즈 대상으로 고를 수 있습니다.",
    ),
  ).toHaveCount(0);

  // An option typed in the editor is not offered until the product is saved.
  await page.getByRole("textbox", { name: "사이즈 / 옵션" }).fill("8.75");
  await page.getByRole("button", { name: "옵션 추가", exact: true }).click();
  await expect(
    page.getByText(
      "바뀐 옵션은 상품을 먼저 저장해야 상세사이즈 대상으로 고를 수 있습니다.",
    ),
  ).toBeVisible();
  await page.getByRole("button", { name: "상세사이즈 수정" }).click();
  const target = page.getByRole("dialog").getByRole("combobox", { name: "적용 대상" });
  await expect(target.locator("option")).toHaveText([
    "기본 (모든 옵션 공통)",
    "8.25",
    "8.5 · 등록됨",
  ]);
  await page.keyboard.press("Escape");
  expect(audit.blocked).toEqual([]);
});

test("ESC during a pending save keeps the modal open, and a failed save keeps the inputs with an error", async ({
  page,
}) => {
  const audit = await setup(page, "/admin?section=products");
  let release = () => {};
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  // Registered after setup, so it takes precedence for the deckSpec PATCH only.
  await page.route(`${API}admin/catalog/products/*`, async (route) => {
    if (route.request().method() !== "PATCH") return route.fallback();
    await gate;
    return respond(route, { code: "CATALOG_STORAGE_UNAVAILABLE" }, 503);
  });
  await page
    .getByRole("list", { name: "상품 목록" })
    .getByRole("listitem")
    .filter({ hasText: "[TEST] Deck size A" })
    .getByRole("button", { name: "수정", exact: true })
    .click();
  await page.getByRole("button", { name: "+ 상세사이즈 등록" }).click();
  const dialog = page.getByRole("dialog");
  for (const [field, value] of Object.entries(SPEC))
    await dialog.getByRole("textbox", { name: field }).fill(String(value));
  await dialog.getByRole("button", { name: "저장", exact: true }).click();
  await expect(dialog.getByRole("button", { name: "저장 중…" })).toBeVisible();

  await page.keyboard.press("Escape");
  await expect(dialog).toBeVisible();

  release();
  await expect(dialog.getByRole("alert")).toContainText("저장하지 못했습니다");
  await expect(dialog.getByRole("textbox", { name: "nose" })).toHaveValue("6.875");
  await expect(dialog.getByRole("button", { name: "저장", exact: true })).toBeEnabled();
  expect(audit.patches).toEqual([]);
  expect(audit.blocked).toEqual([]);
});

async function openDeckSpecModal(page: Page, productName: string) {
  await page
    .getByRole("list", { name: "상품 목록" })
    .getByRole("listitem")
    .filter({ hasText: productName })
    .getByRole("button", { name: "수정", exact: true })
    .click();
  await page.getByRole("button", { name: "+ 상세사이즈 등록" }).click();
  const dialog = page.getByRole("dialog");
  for (const [field, value] of Object.entries(SPEC))
    await dialog.getByRole("textbox", { name: field }).fill(String(value));
  return dialog;
}

test("after a lost save response, a retry stops on the conflict instead of overwriting", async ({
  page,
}) => {
  const audit = await setup(page, "/admin?section=products");
  let lost = false;
  await page.route(`${API}admin/catalog/products/*`, async (route) => {
    if (route.request().method() !== "PATCH" || lost) return route.fallback();
    lost = true;
    // The server commits the write, but the browser never sees a valid response.
    const item = audit.store.find((entry) => entry.productId === DECK.id)!;
    item.deckSpec = SPEC;
    item.version += 1;
    return respond(route, { code: "INTERNAL" }, 500);
  });
  const dialog = await openDeckSpecModal(page, "[TEST] Deck size A");
  await dialog.getByRole("button", { name: "저장", exact: true }).click();
  await expect(dialog.getByRole("alert")).toContainText("저장하지 못했습니다");

  await dialog.getByRole("textbox", { name: "tail" }).fill("6.625");
  await dialog.getByRole("button", { name: "저장", exact: true }).click();
  await expect(page.getByText("편집을 닫고 다시 열어")).toBeVisible();
  await expect(dialog).toBeVisible();
  expect(audit.patches).toEqual([{ version: 3, deckSpec: { ...SPEC, tail: 6.625 } }]);
  expect(audit.store.find((entry) => entry.productId === DECK.id)).toMatchObject({
    version: 4,
    deckSpec: SPEC,
  });
  expect(audit.blocked).toEqual([]);
});

test("a late save response for one product does not close another product's modal", async ({
  page,
}) => {
  const audit = await setup(page, "/admin?section=products");
  let release = () => {};
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  await page.route(`${API}admin/catalog/products/${DECK.id}`, async (route) => {
    if (route.request().method() !== "PATCH") return route.fallback();
    await gate;
    return route.fallback();
  });
  const first = await openDeckSpecModal(page, "[TEST] Deck size A");
  await first.getByRole("button", { name: "저장", exact: true }).click();
  await expect(first.getByRole("button", { name: "저장 중…" })).toBeVisible();

  await page.goBack();
  await expect(page.getByRole("dialog")).toHaveCount(0);
  const second = await openDeckSpecModal(page, "[TEST] Deck size B");
  release();
  // Assert only after the app has parsed and committed A's late success.
  await page.waitForFunction(
    () => (window as unknown as { __patchSettled: number }).__patchSettled >= 1,
  );
  expect(audit.patchedIds).toEqual([DECK.id]);
  await expect(second).toBeVisible();
  await expect(second.getByRole("textbox", { name: "nose" })).toHaveValue("6.875");
  expect(audit.blocked).toEqual([]);
});

test("a late save response does not close a new modal after returning to the same editor", async ({
  page,
}) => {
  const audit = await setup(page, "/admin?section=products");
  let release = () => {};
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  await page.route(`${API}admin/catalog/products/${DECK.id}`, async (route) => {
    if (route.request().method() !== "PATCH") return route.fallback();
    await gate;
    return route.fallback();
  });
  const first = await openDeckSpecModal(page, "[TEST] Deck size A");
  await first.getByRole("button", { name: "저장", exact: true }).click();
  await expect(first.getByRole("button", { name: "저장 중…" })).toBeVisible();

  await page.goBack();
  await page.goForward();
  await expect(page.getByRole("dialog")).toHaveCount(0);
  await page.getByRole("button", { name: "+ 상세사이즈 등록" }).click();
  const second = page.getByRole("dialog");
  await second.getByRole("textbox", { name: "nose" }).fill("7");
  release();
  // The summary behind the modal changes only once the app has processed the late success.
  await expect(page.getByText('8.5" × 31.75" · WB 14.25"')).toBeVisible();
  await page.waitForFunction(
    () => (window as unknown as { __patchSettled: number }).__patchSettled >= 1,
  );
  await expect(second).toBeVisible();
  await expect(second.getByRole("textbox", { name: "nose" })).toHaveValue("7");
  expect(audit.blocked).toEqual([]);
});

test("the storefront shows a size chart with inches and cm only when the product has a spec", async ({
  page,
}) => {
  const audit = await setup(page, `/products/${DECK.slug}`, SPEC);
  await expect(page.getByRole("heading", { name: "[TEST] Deck size A" })).toBeVisible();

  await page.getByRole("button", { name: "상세사이즈" }).click();
  const dialog = page.getByRole("dialog");
  await expect(dialog).toBeVisible();
  await expect(dialog.getByRole("img", { name: "[TEST] Deck size A" })).toBeVisible();
  for (const text of ['6.875"', "(17.5cm)", '31.75"', "(80.6cm)", '14.25"', "(36.2cm)"])
    await expect(dialog.locator("svg")).toContainText(text);
  await page.keyboard.press("Escape");
  await expect(dialog).toBeHidden();

  await page.goto(`/products?slug=${PLAIN.slug}`);
  await expect(page.getByRole("heading", { name: "[TEST] Deck size B" })).toBeVisible();
  await expect(page.getByRole("button", { name: "상세사이즈" })).toHaveCount(0);
  expect(audit.blocked).toEqual([]);
});

test("the storefront size chart follows the selected size and falls back to the default", async ({
  page,
}) => {
  const option = { ...SPEC, width: 8.25, wheelbase: 14 };
  const audit = await setup(page, `/products/${DECK.slug}`, SPEC, {
    sizes: ["8.25", "8.5"],
    deckSpecsBySize: { "8.25": option },
  });
  await expect(page.getByRole("heading", { name: "[TEST] Deck size A" })).toBeVisible();
  const openChart = async () => {
    await page.getByRole("button", { name: "상세사이즈" }).click();
    const svg = page.getByRole("dialog").locator("svg");
    await expect(svg).toBeVisible();
    return svg;
  };

  // The first size is selected and has its own values.
  await expect(page.getByRole("button", { name: "8.25", exact: true })).toHaveAttribute(
    "aria-pressed",
    "true",
  );
  let svg = await openChart();
  for (const text of ['8.25"', "(21.0cm)", '14"', "(35.6cm)"])
    await expect(svg).toContainText(text);
  await expect(svg).not.toContainText('14.25"');
  await page.keyboard.press("Escape");

  await page.getByRole("button", { name: "8.5", exact: true }).click();
  svg = await openChart();
  for (const text of ['8.5"', "(21.6cm)", '14.25"', "(36.2cm)"])
    await expect(svg).toContainText(text);
  await expect(svg).not.toContainText('8.25"');
  await page.keyboard.press("Escape");
  expect(audit.blocked).toEqual([]);
});

test("without a default, only a size with its own values shows the size chart", async ({
  page,
}) => {
  const audit = await setup(page, `/products/${DECK.slug}`, undefined, {
    sizes: ["8.25", "8.5"],
    deckSpecsBySize: { "8.5": SPEC },
  });
  await expect(page.getByRole("heading", { name: "[TEST] Deck size A" })).toBeVisible();
  await expect(page.getByRole("button", { name: "상세사이즈" })).toHaveCount(0);

  await page.getByRole("button", { name: "8.5", exact: true }).click();
  await page.getByRole("button", { name: "상세사이즈" }).click();
  await expect(page.getByRole("dialog").locator("svg")).toContainText('14.25"');
  await page.keyboard.press("Escape");

  await page.getByRole("button", { name: "8.25", exact: true }).click();
  await expect(page.getByRole("button", { name: "상세사이즈" })).toHaveCount(0);
  expect(audit.blocked).toEqual([]);
});
