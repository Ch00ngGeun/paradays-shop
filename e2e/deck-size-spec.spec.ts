import { expect, test, type Page, type Route } from "@playwright/test";

const ORIGIN = "http://127.0.0.1:3139";
const API = "https://api.sales.test/prod/";
const TRANSLATE = "https://api.mymemory.translated.net/get";
const SUBJECT = "deck-size-synthetic-admin";
const DECK = { slug: "odwyer-sync-1-8-375", id: "prd_deck_size_synthetic" };
const PLAIN = { slug: "synthetic-deck-without-spec", id: "prd_deck_size_plain" };
const SPEC = { nose: 6.875, tail: 6.5, width: 8.5, length: 31.75, wheelbase: 14.25 };

type Values = Record<string, number>;
type Stored = {
  productId: string;
  slug: string;
  name: string;
  version: number;
  deckSpec?: typeof SPEC;
  sizes?: string[];
  deckSpecsBySize?: Record<string, typeof SPEC>;
  category?: string;
  sizeChart?: { kind: string; values: Values };
  sizeChartKind?: string;
  sizeChartsBySize?: Record<string, Values>;
};
/** Clothing and wheel size chart fields, as the server returns them. */
function sizeChartShape(item: Stored) {
  return {
    ...(item.sizeChart ? { sizeChart: item.sizeChart } : {}),
    ...(item.sizeChartKind ? { sizeChartKind: item.sizeChartKind } : {}),
    ...(item.sizeChartsBySize ? { sizeChartsBySize: item.sizeChartsBySize } : {}),
  };
}
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
    category: item.category ?? "Deck",
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
    ...sizeChartShape(item),
  };
}

function publicShape(item: Stored) {
  return {
    id: item.productId,
    slug: item.slug,
    name: item.name,
    category: item.category ?? "Deck",
    brand: "TEST",
    price: 107_000,
    inventoryQuantity: 5,
    image: "/images/product-placeholder.svg",
    description: ["Synthetic deck size fixture"],
    sizes: item.sizes ?? ["8.5"],
    featured: false,
    ...(item.deckSpec ? { deckSpec: item.deckSpec } : {}),
    ...(item.deckSpecsBySize ? { deckSpecsBySize: item.deckSpecsBySize } : {}),
    ...sizeChartShape(item),
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
      if ("sizeDeckSpec" in body || "sizeChartValues" in body) {
        const size = body.size as string;
        const name = (body.sizeName as string | undefined) ?? size;
        // Like the server, a rename moves both kinds of option value.
        const move = <T>(
          map: Record<string, T> | undefined,
          edited: boolean,
          next: unknown,
        ) => {
          const copy = { ...map };
          const kept = copy[size];
          delete copy[size];
          const value = edited ? next : kept;
          if (value) copy[name] = value as T;
          return Object.keys(copy).length ? copy : undefined;
        };
        item.deckSpecsBySize = move(
          item.deckSpecsBySize,
          "sizeDeckSpec" in body,
          body.sizeDeckSpec,
        );
        item.sizeChartsBySize = move(
          item.sizeChartsBySize,
          "sizeChartValues" in body,
          body.sizeChartValues,
        );
        if ("sizeChartValues" in body)
          item.sizeChartKind ??=
            item.sizeChart?.kind ??
            (item.category === "Wheels" ? "wheel" : "shortSleeve");
        item.sizes = (item.sizes ?? ["8.5"]).map((option) =>
          option === size ? name : option,
        );
      }
      if ("sizeChart" in body) {
        const chart = body.sizeChart as Stored["sizeChart"] | null;
        if (chart) {
          item.sizeChart = chart;
          item.sizeChartKind = chart.kind;
        } else delete item.sizeChart;
      }
      if ("sizeChartKind" in body) {
        if (body.sizeChartKind !== (item.sizeChart?.kind ?? item.sizeChartKind)) {
          delete item.sizeChart;
          delete item.sizeChartsBySize;
        }
        item.sizeChartKind = body.sizeChartKind as string;
      }
      if (typeof body.sizes === "string")
        item.sizes = body.sizes
          .split(",")
          .map((option) => option.trim())
          .filter(Boolean);
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

async function editDeck(page: Page) {
  await page
    .getByRole("list", { name: "상품 목록" })
    .getByRole("listitem")
    .filter({ hasText: "[TEST] Deck size A" })
    .getByRole("button", { name: "수정", exact: true })
    .click();
}
const chipNames = (page: Page) =>
  page
    .getByRole("list", { name: "추가된 옵션" })
    .locator("li > :first-child > span:first-child");
const chip = (page: Page, name: string) =>
  page
    .getByRole("list", { name: "추가된 옵션" })
    .getByRole("button", { name, exact: true });

test("admin edits per-option charts from the chips and the default button stays default-only", async ({
  page,
}) => {
  const option85 = { ...SPEC, width: 8.5, wheelbase: 14.5 };
  const option825 = { ...SPEC, width: 8.25, wheelbase: 14 };
  const audit = await setup(page, "/admin?section=products", SPEC, {
    sizes: ["8.25", "8.5"],
    deckSpecsBySize: { "8.5": option85 },
  });
  const item = audit.store.find((entry) => entry.productId === DECK.id)!;
  await editDeck(page);
  await expect(
    page.getByText('기본 8.5" × 31.75" · WB 14.25" · 옵션별 1개'),
  ).toBeVisible();
  await expect(page.getByRole("list", { name: "추가된 옵션" })).toContainText(
    "8.5상세",
  );
  const dialog = page.getByRole("dialog");
  const input = (field: string) => dialog.getByRole("textbox", { name: field });

  // The default button opens the default chart only: no target picker, no name field.
  await page.getByRole("button", { name: "상세사이즈 수정" }).click();
  await expect(dialog.getByRole("combobox")).toHaveCount(0);
  await expect(input("옵션 이름")).toHaveCount(0);
  await expect(input("wheelbase")).toHaveValue("14.25");
  await page.keyboard.press("Escape");

  // A saved chip opens its own chart with its name.
  await chip(page, "8.5").click();
  await expect(dialog.getByRole("heading")).toContainText("· 8.5");
  await expect(input("옵션 이름")).toHaveValue("8.5");
  await expect(input("wheelbase")).toHaveValue("14.5");
  await dialog.getByRole("button", { name: "삭제", exact: true }).click();
  await expect(dialog).toBeHidden();
  expect(audit.patches[0]).toEqual({ version: 3, size: "8.5", sizeDeckSpec: null });
  expect(item.deckSpec).toEqual(SPEC);

  await chip(page, "8.25").click();
  await expect(input("wheelbase")).toHaveValue("");
  await expect(dialog).toContainText("이 옵션은 지금 기본값을 표시합니다.");
  for (const [field, value] of Object.entries(option825))
    await input(field).fill(String(value));
  await dialog.getByRole("button", { name: "저장", exact: true }).click();
  await expect(dialog).toBeHidden();
  expect(audit.patches[1]).toEqual({
    version: 4,
    size: "8.25",
    sizeDeckSpec: option825,
  });
  expect(item.deckSpecsBySize).toEqual({ "8.25": option825 });

  // Saving the default keeps the old default-only body.
  await page.getByRole("button", { name: "상세사이즈 수정" }).click();
  await input("tail").fill("6.625");
  await dialog.getByRole("button", { name: "저장", exact: true }).click();
  await expect(dialog).toBeHidden();
  expect(audit.patches[2]).toEqual({ version: 5, deckSpec: { ...SPEC, tail: 6.625 } });
  expect(item.deckSpecsBySize).toEqual({ "8.25": option825 });
  expect(audit.blocked).toEqual([]);
});

test("renaming an option moves its chart, renames the chip and the next product save sends the new name", async ({
  page,
}) => {
  const option85 = { ...SPEC, width: 8.5, wheelbase: 14.5 };
  const audit = await setup(page, "/admin?section=products", SPEC, {
    sizes: ["8.25", "8.5"],
    deckSpecsBySize: { "8.5": option85 },
  });
  const item = audit.store.find((entry) => entry.productId === DECK.id)!;
  await editDeck(page);
  const dialog = page.getByRole("dialog");
  const name = dialog.getByRole("textbox", { name: "옵션 이름" });

  await chip(page, "8.5").click();
  for (const [value, message] of [
    ["", "옵션 이름을 입력해 주세요."],
    ["8.25", "이미 있는 옵션 이름입니다."],
    ["8.5, wide", "쉼표나 줄바꿈 없이"],
  ] as const) {
    await name.fill(value);
    await expect(dialog).toContainText(message);
    await expect(
      dialog.getByRole("button", { name: "저장", exact: true }),
    ).toBeDisabled();
  }
  await name.fill(" 8.5 wide ");
  await expect(dialog).toContainText(
    "예전 이름으로 적힌 매출 초안은 옵션을 다시 골라 저장해야",
  );
  await dialog.getByRole("button", { name: "저장", exact: true }).click();
  await expect(dialog).toBeHidden();
  expect(audit.patches[0]).toEqual({
    version: 3,
    size: "8.5",
    sizeName: "8.5 wide",
    sizeDeckSpec: option85,
  });
  await expect(chipNames(page)).toHaveText(["8.25", "8.5 wide"]);
  expect(item.deckSpecsBySize).toEqual({ "8.5 wide": option85 });

  // A name-only rename with all five fields empty.
  await chip(page, "8.25").click();
  await name.fill("8.0");
  await dialog.getByRole("button", { name: "저장", exact: true }).click();
  await expect(dialog).toBeHidden();
  expect(audit.patches[1]).toEqual({
    version: 4,
    size: "8.25",
    sizeName: "8.0",
    sizeDeckSpec: null,
  });
  await expect(chipNames(page)).toHaveText(["8.0", "8.5 wide"]);

  page.once("dialog", (prompt) => void prompt.accept());
  await page.getByRole("button", { name: /수정 저장/ }).click();
  await expect.poll(() => audit.patches.length).toBe(3);
  expect(audit.patches[2]).toMatchObject({ version: 5, sizes: "8.0, 8.5 wide" });
  expect(item.deckSpecsBySize).toEqual({ "8.5 wide": option85 });
  expect(audit.blocked).toEqual([]);
});

test("an unsaved chip asks to save the product first and a reserved rename explains the hold", async ({
  page,
}) => {
  const audit = await setup(page, "/admin?section=products", undefined, {
    sizes: ["8.25", "8.5"],
    deckSpecsBySize: { "8.5": SPEC },
  });
  await editDeck(page);
  await expect(page.getByText("기본 미등록 · 옵션별 1개")).toBeVisible();
  await page.getByRole("button", { name: "8.5 삭제", exact: true }).click();
  await page.getByRole("textbox", { name: "사이즈 / 옵션" }).fill("8.75");
  await page.getByRole("button", { name: "옵션 추가", exact: true }).click();
  await expect(chipNames(page)).toHaveText(["8.25", "8.75"]);
  await chip(page, "8.75").click();
  await expect(page.getByRole("dialog")).toHaveCount(0);
  await expect(
    page.getByRole("alert").filter({ hasText: "상품을 먼저 저장해 주세요." }),
  ).toBeVisible();

  let refusal: string | null = "CATALOG_PRODUCT_RESERVED";
  await page.route(`${API}admin/catalog/products/*`, (route) =>
    route.request().method() === "PATCH" && refusal
      ? respond(route, { code: refusal }, 409)
      : route.fallback(),
  );
  await chip(page, "8.25").click();
  const dialog = page.getByRole("dialog");
  const save = dialog.getByRole("button", { name: "저장", exact: true });
  // A chip added but not saved yet still counts as a taken name.
  await dialog.getByRole("textbox", { name: "옵션 이름" }).fill("8.75");
  await expect(dialog).toContainText("이미 있는 옵션 이름입니다.");
  await expect(save).toBeDisabled();
  await dialog.getByRole("textbox", { name: "옵션 이름" }).fill("8.0");
  await save.click();
  // The reason is shown inside the open dialog, not behind it.
  await expect(dialog.getByRole("alert")).toContainText(
    "결제 대기 중인 주문이 있어 지금은 옵션 이름을 바꿀 수 없습니다.",
  );
  refusal = "CATALOG_PRODUCT_DUPLICATE";
  await save.click();
  await expect(dialog.getByRole("alert")).toContainText(
    "같은 이름·브랜드의 다른 상품에 이 옵션이 있어",
  );
  await expect(chipNames(page)).toHaveText(["8.25", "8.75"]);

  // A later success leaves no refusal text anywhere on the page.
  refusal = null;
  await save.click();
  await expect(dialog).toBeHidden();
  await expect(chipNames(page)).toHaveText(["8.0", "8.75"]);
  await expect(page.getByText("결제 대기 중인 주문이 있어")).toHaveCount(0);
  await expect(page.getByText("같은 이름·브랜드의 다른 상품")).toHaveCount(0);
  expect(audit.blocked).toEqual([]);
});

test("a duplicated legacy option name opens its chart without a name field", async ({
  page,
}) => {
  const audit = await setup(page, "/admin?section=products", SPEC, {
    sizes: ["M", "M", "L"],
  });
  await editDeck(page);
  const dialog = page.getByRole("dialog");
  const reason = "같은 이름의 옵션이 여러 개 저장돼 있어 이름은 바꿀 수 없고";
  await page
    .getByRole("list", { name: "추가된 옵션" })
    .getByRole("button", { name: "M", exact: true })
    .nth(1)
    .click();
  await expect(dialog.getByRole("heading")).toContainText("· M");
  await expect(dialog.getByRole("textbox", { name: "옵션 이름" })).toHaveCount(0);
  // The reason is inside the open dialog.
  await expect(dialog).toContainText(reason);
  for (const [field, value] of Object.entries(SPEC))
    await dialog.getByRole("textbox", { name: field }).fill(String(value));
  await dialog.getByRole("button", { name: "저장", exact: true }).click();
  await expect(dialog).toBeHidden();
  expect(audit.patches).toEqual([{ version: 3, size: "M", sizeDeckSpec: SPEC }]);
  await expect(chipNames(page)).toHaveText(["M", "M", "L"]);

  // Removing one M only in the draft still saves both, so the same reason shows with no name field.
  await page.getByRole("button", { name: "M 삭제", exact: true }).first().click();
  await expect(chipNames(page)).toHaveText(["M", "L"]);
  await page
    .getByRole("list", { name: "추가된 옵션" })
    .getByRole("button", { name: "M", exact: true })
    .click();
  await expect(dialog.getByRole("textbox", { name: "옵션 이름" })).toHaveCount(0);
  await expect(dialog).toContainText(reason);
  expect(audit.blocked).toEqual([]);
});

test("Esc closes the help inside the size chart dialog first, then the dialog, and nothing stays locked", async ({
  page,
}) => {
  const audit = await setup(page, "/admin?section=products");
  await editDeck(page);
  const open = page.getByRole("button", { name: "+ 상세사이즈 등록" });
  await open.click();
  const chart = page.getByRole("dialog", {
    name: /^상세사이즈 · \[TEST\] Deck size A/,
  });
  await expect(chart).toBeVisible();
  // The inch explanation is behind the help button.
  await expect(chart).not.toContainText("인치로 입력하면");
  const help = chart.getByRole("button", {
    name: "상세사이즈 입력 도움말",
    exact: true,
  });
  await help.click();
  const helpDialog = page.getByRole("dialog", { name: "상세사이즈 입력 도움말" });
  await expect(helpDialog).toContainText("인치로 입력하면 cm는 자동으로 계산됩니다.");
  const inert = (locator: typeof chart) =>
    locator.evaluate((element) => element.closest("[inert]") !== null);
  expect(await inert(chart)).toBe(true);

  await page.keyboard.press("Escape");
  await expect(helpDialog).toHaveCount(0);
  await expect(chart).toBeVisible();
  await expect(help).toBeFocused();
  expect(await inert(chart)).toBe(false);

  // A wrong value brings the range back as an error tied to that field.
  const nose = chart.getByRole("textbox", { name: "nose" });
  await nose.fill("0");
  await expect(chart).toContainText(
    "0 초과 100 이하의 인치로, 소수 4자리까지 입력해 주세요.",
  );
  await expect(nose).toHaveAccessibleDescription(
    "0 초과 100 이하의 인치로, 소수 4자리까지 입력해 주세요.",
  );

  await page.keyboard.press("Escape");
  await expect(chart).toHaveCount(0);
  expect(
    await page.evaluate(() => ({
      overflow: document.body.style.overflow,
      inert: [...document.body.children].some(
        (element) => (element as HTMLElement).inert,
      ),
    })),
  ).toEqual({ overflow: "", inert: false });
  await expect(open).toBeEnabled();
  await open.click();
  await expect(chart).toBeVisible();
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

test("a product name entered on two lines shows on two lines on the product page", async ({
  page,
}) => {
  const audit = await setup(page, `/products/${DECK.slug}`, undefined, {
    name: "[TEST] Two line\nDeck",
  });
  const heading = page.getByRole("heading", { level: 1 });
  await expect(heading).toBeVisible();
  expect(await heading.innerText()).toBe("[TEST] Two line\nDeck");
  const lineHeight = await heading.evaluate((h1) =>
    parseFloat(getComputedStyle(h1).lineHeight),
  );
  expect((await heading.boundingBox())!.height).toBeGreaterThan(lineHeight * 1.5);
  expect(audit.blocked).toEqual([]);
});

for (const width of [1280, 375]) {
  test(`saved product name line breaks survive home and menu filtering at ${width}px`, async ({
    page,
  }) => {
    await page.setViewportSize({ width, height: 900 });
    await page.emulateMedia({ reducedMotion: "reduce" });
    const name = "[TEST] Two\nDeck";
    const audit = await setup(page, "/", undefined, { name });
    const grid = page.getByRole("list", { name: "PARADAYS products" });
    const card = grid.getByRole("listitem").filter({ hasText: "[TEST] Two" });
    const plain = grid.getByRole("listitem").filter({ hasText: "[TEST] Deck size B" });
    const checkLayout = async () => {
      const heading = card.getByRole("heading", { level: 2 });
      await expect(heading).toBeVisible();
      expect(await heading.innerText()).toBe(name);
      const layout = await card.evaluate((item) => {
        const title = item.querySelector("h2")!;
        const price = item.querySelector("p")!;
        const imageSlot = item.querySelector("img")!.parentElement!;
        const titleBox = title.getBoundingClientRect();
        const priceBox = price.getBoundingClientRect();
        const mediaBox = imageSlot.getBoundingClientRect();
        const cardBox = item.getBoundingClientRect();
        return {
          titleHeight: titleBox.height,
          lineHeight: parseFloat(getComputedStyle(title).lineHeight),
          priceTop: priceBox.top,
          titleBottom: titleBox.bottom,
          mediaBottom: mediaBox.bottom,
          titleTop: titleBox.top,
          mediaHeight: mediaBox.height,
          mediaWidth: mediaBox.width,
          cardBottom: cardBox.bottom,
          priceBottom: priceBox.bottom,
          left: cardBox.left,
          right: cardBox.right,
        };
      });
      expect(layout.titleHeight).toBeGreaterThan(layout.lineHeight * 1.5);
      expect(layout.titleHeight).toBeLessThan(layout.lineHeight * 2.1);
      expect(layout.titleTop).toBeGreaterThanOrEqual(layout.mediaBottom);
      expect(layout.priceTop).toBeGreaterThanOrEqual(layout.titleBottom);
      expect(layout.cardBottom).toBeGreaterThanOrEqual(layout.priceBottom);
      expect(layout.left).toBeGreaterThanOrEqual(0);
      expect(layout.right).toBeLessThanOrEqual(width);
      await expect(plain).toBeVisible();
      const plainImage = await plain.locator("img").boundingBox();
      expect(plainImage!.height).toBeCloseTo(layout.mediaHeight, 0);
      expect(plainImage!.width).toBeCloseTo(layout.mediaWidth, 0);
    };
    await checkLayout();
    const before = await grid.locator("h2").allTextContents();

    const menu = page.getByRole("button", { name: "Menu", exact: true });
    if (width < 768) await menu.click();
    else await menu.press("ArrowDown");
    await expect(menu).toHaveAttribute("aria-expanded", "true");
    const dropdown = page.locator("#store-menu-dropdown");
    await dropdown.getByRole("button", { name: "데크", exact: true }).press("Enter");
    await menu.press("Enter");
    await expect(menu).toHaveAttribute("aria-expanded", "false");
    await checkLayout();
    const after = await grid.locator("h2").allTextContents();
    expect(after).toEqual(before.filter((title) => after.includes(title)));
    expect(audit.patches).toEqual([]);
    expect(audit.blocked).toEqual([]);
  });
}

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

test("a legacy duplicate option chip is removed alone, by its position", async ({
  page,
}) => {
  const audit = await setup(page, "/admin?section=products", undefined, {
    sizes: ["M", "M", "L"],
  });
  await page
    .getByRole("list", { name: "상품 목록" })
    .getByRole("listitem")
    .filter({ hasText: "[TEST] Deck size A" })
    .getByRole("button", { name: "수정", exact: true })
    .click();
  const chips = page
    .getByRole("list", { name: "추가된 옵션" })
    .locator("li > :first-child > span:first-child");
  await expect(chips).toHaveText(["M", "M", "L"]);
  await page.getByRole("button", { name: "M 삭제", exact: true }).nth(1).click();
  await expect(chips).toHaveText(["M", "L"]);

  page.once("dialog", (prompt) => void prompt.accept());
  await page.getByRole("button", { name: /수정 저장/ }).click();
  await expect.poll(() => audit.patches.length).toBe(1);
  expect(audit.patches[0]).toMatchObject({ version: 3, sizes: "M, L" });
  expect(audit.blocked).toEqual([]);
});

const TOP = {
  length: 72,
  shoulder: 50.5,
  chest: 56,
  sleeveLength: 22,
  hem: 55,
  sleeveWidth: 20.5,
  armhole: 24,
};
const TOP_FIELDS: [keyof typeof TOP, string][] = [
  ["length", "총장"],
  ["shoulder", "어깨너비"],
  ["chest", "가슴단면"],
  ["sleeveLength", "소매길이"],
  ["hem", "밑단단면"],
  ["sleeveWidth", "소매통"],
  ["armhole", "암홀"],
];
const topProduct = (extra: Partial<Stored> = {}) => ({
  category: "Top",
  sizes: ["S", "M"],
  ...extra,
});
async function fillTop(
  dialog: ReturnType<Page["getByRole"]>,
  values: Record<string, number>,
) {
  for (const [key, label] of TOP_FIELDS)
    await dialog.getByRole("textbox", { name: label }).fill(String(values[key]));
}

test("a top saves its default and option charts with their own bodies, renames an option and explains a reserved rename", async ({
  page,
}) => {
  const audit = await setup(page, "/admin?section=products", undefined, topProduct());
  const item = audit.store.find((entry) => entry.productId === DECK.id)!;
  await editDeck(page);
  await expect(page.getByText("반팔 · 미등록")).toBeVisible();
  // Clothing chips open their chart now, like deck chips.
  await expect(chip(page, "M")).toBeVisible();

  await page.getByRole("button", { name: "+ 상세사이즈 등록" }).click();
  const dialog = page.getByRole("dialog");
  await expect(dialog.getByRole("combobox", { name: "도면 종류" })).toHaveValue(
    "shortSleeve",
  );
  await expect(
    dialog.getByRole("button", { name: "저장", exact: true }),
  ).toBeDisabled();
  await fillTop(dialog, TOP);
  await expect(dialog).toContainText('(28.3")');
  await expect(dialog.locator("svg")).toContainText("72cm");
  await dialog.getByRole("button", { name: "저장", exact: true }).click();
  await expect(dialog).toBeHidden();
  expect(audit.patches).toEqual([
    { version: 3, sizeChart: { kind: "shortSleeve", values: TOP } },
  ]);
  await expect(page.getByText('반팔 · 총장 72cm (28.3")')).toBeVisible();

  let refusal: string | null = "CATALOG_PRODUCT_RESERVED";
  await page.route(`${API}admin/catalog/products/*`, (route) =>
    route.request().method() === "PATCH" && refusal
      ? respond(route, { code: refusal }, 409)
      : route.fallback(),
  );
  const option = { ...TOP, length: 74 };
  await chip(page, "M").click();
  await expect(dialog.getByRole("heading")).toContainText("· M");
  await expect(dialog.getByRole("combobox", { name: "도면 종류" })).toBeDisabled();
  await expect(dialog).toContainText("이 옵션은 지금 기본값을 표시합니다.");
  await fillTop(dialog, option);
  await dialog.getByRole("textbox", { name: "옵션 이름" }).fill("L");
  const save = dialog.getByRole("button", { name: "저장", exact: true });
  await save.click();
  await expect(dialog.getByRole("alert")).toContainText(
    "결제 대기 중인 주문이 있어 지금은 옵션 이름을 바꿀 수 없습니다.",
  );
  refusal = null;
  await save.click();
  await expect(dialog).toBeHidden();
  expect(audit.patches.at(-1)).toEqual({
    version: 4,
    size: "M",
    sizeName: "L",
    sizeChartValues: option,
  });
  expect(item.sizeChartsBySize).toEqual({ L: option });
  await expect(chipNames(page)).toHaveText(["S", "L"]);
  await expect(page.getByRole("list", { name: "추가된 옵션" })).toContainText("L상세");
  await expect(page.getByText(/기본 총장 72cm \(28\.3"\) · 옵션별 1개/)).toBeVisible();

  // The next product save sends the renamed chip instead of undoing it.
  page.once("dialog", (prompt) => void prompt.accept());
  await page.getByRole("button", { name: /수정 저장/ }).click();
  await expect(page.getByText("상품을 공개 상태로 저장했습니다")).toBeVisible();
  expect(audit.patches.at(-1)).toMatchObject({ version: 5, sizes: "S, L" });
  expect(audit.blocked).toEqual([]);
});

test("switching the drawing asks first, keeps focus through cancel, failure and success, and clears every value", async ({
  page,
}) => {
  const audit = await setup(
    page,
    "/admin?section=products",
    undefined,
    topProduct({
      sizeChart: { kind: "shortSleeve", values: TOP },
      sizeChartKind: "shortSleeve",
      sizeChartsBySize: { M: TOP },
    }),
  );
  const item = audit.store.find((entry) => entry.productId === DECK.id)!;
  await editDeck(page);
  await page.getByRole("button", { name: "상세사이즈 수정" }).click();
  const dialog = page.getByRole("dialog");
  const kind = dialog.getByRole("combobox", { name: "도면 종류" });
  // The submit button reads "저장 중…" while anything is being sent.
  const save = dialog.locator('button[type="submit"]');
  const remove = dialog.getByRole("button", { name: "삭제", exact: true });

  await kind.selectOption("raglanLongSleeve");
  await expect(dialog.getByRole("alert")).toContainText(
    "도면 종류를 '래글런 긴팔'(으)로 바꾸면 기본값과 옵션별로 입력한 상세사이즈가 모두 지워집니다.",
  );
  await expect(save).toBeDisabled();
  await expect(remove).toBeDisabled();
  await dialog.getByRole("button", { name: "그대로 두기" }).click();
  await expect(kind).toBeFocused();
  await expect(kind).toHaveValue("shortSleeve");
  await expect(dialog.getByRole("textbox", { name: "총장" })).toHaveValue("72");

  // A held, then failed switch: Esc does not close it and nothing else can be sent meanwhile.
  let release = () => {};
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  let fail = true;
  await page.route(`${API}admin/catalog/products/*`, async (route) => {
    if (route.request().method() !== "PATCH" || !fail) return route.fallback();
    await gate;
    return respond(route, { code: "CATALOG_STORAGE_UNAVAILABLE" }, 503);
  });
  await kind.selectOption("raglanLongSleeve");
  const change = dialog.getByRole("button", { name: "바꾸고 지우기" });
  await change.click();
  await page.keyboard.press("Escape");
  await expect(dialog).toBeVisible();
  await expect(save).toBeDisabled();
  await expect(remove).toBeDisabled();
  await expect(kind).toBeDisabled();
  release();
  await expect(dialog.getByRole("alert").last()).toContainText("저장하지 못했습니다");
  await expect(change).toBeFocused();
  expect(item.sizeChart).toEqual({ kind: "shortSleeve", values: TOP });

  fail = false;
  await change.click();
  // The form starts over with the new drawing's fields, focused on the drawing.
  await expect(dialog.getByRole("textbox", { name: "화장" })).toHaveValue("");
  await expect(kind).toHaveValue("raglanLongSleeve");
  await expect(kind).toBeFocused();
  await expect(dialog.getByRole("textbox", { name: "소매통" })).toHaveCount(0);
  await expect(dialog.getByRole("button", { name: "삭제", exact: true })).toHaveCount(
    0,
  );
  expect(audit.patches).toEqual([{ version: 3, sizeChartKind: "raglanLongSleeve" }]);
  expect(item.sizeChart).toBeUndefined();
  expect(item.sizeChartsBySize).toBeUndefined();

  // Switching back to the drawing the modal opened with focuses the new form too.
  await kind.selectOption("shortSleeve");
  await dialog.getByRole("button", { name: "바꾸고 지우기" }).click();
  await expect(dialog.getByRole("textbox", { name: "소매통" })).toHaveValue("");
  await expect(kind).toHaveValue("shortSleeve");
  await expect(kind).toBeFocused();
  // And once more away from it.
  await kind.selectOption("raglanLongSleeve");
  await dialog.getByRole("button", { name: "바꾸고 지우기" }).click();
  await expect(dialog.getByRole("textbox", { name: "화장" })).toBeVisible();
  await expect(kind).toBeFocused();
  expect(audit.patches).toEqual([
    { version: 3, sizeChartKind: "raglanLongSleeve" },
    { version: 4, sizeChartKind: "shortSleeve" },
    { version: 5, sizeChartKind: "raglanLongSleeve" },
  ]);
  await page.keyboard.press("Escape");
  await expect(dialog).toBeHidden();
  await expect(page.getByText("래글런 긴팔 · 미등록")).toBeVisible();
  await expect(page.getByRole("list", { name: "추가된 옵션" })).not.toContainText(
    "상세",
  );
  expect(audit.blocked).toEqual([]);
});

test("a wheel has one drawing in mm, nested help closes first, unsaved chips ask for a save, and it fits 375px", async ({
  page,
}) => {
  await page.setViewportSize({ width: 375, height: 800 });
  const audit = await setup(page, "/admin?section=products", undefined, {
    category: "Wheels",
    sizes: ["54mm 99a"],
  });
  await editDeck(page);
  await page.getByRole("textbox", { name: "사이즈 / 옵션" }).fill("56mm 99a");
  await page.getByRole("button", { name: "옵션 추가", exact: true }).click();
  await chip(page, "56mm 99a").click();
  await expect(page.getByRole("dialog")).toHaveCount(0);
  await expect(
    page.getByRole("alert").filter({ hasText: "상품을 먼저 저장해 주세요." }),
  ).toBeVisible();

  const open = page.getByRole("button", { name: "+ 상세사이즈 등록" });
  await open.click();
  const dialog = page.getByRole("dialog", { name: /^상세사이즈 · / });
  const kind = dialog.getByRole("combobox", { name: "도면 종류" });
  await expect(kind).toBeDisabled();
  await expect(kind).toHaveAccessibleDescription(
    "이 카테고리는 도면 종류가 하나뿐입니다.",
  );
  for (const [label, value] of [
    ["지름", "54"],
    ["W 전체 폭", "33.5"],
    ["T 바닥 닿는 폭", "20"],
  ])
    await dialog.getByRole("textbox", { name: label }).fill(value);
  await expect(dialog.locator("svg")).toContainText("54mm");
  await expect(dialog).not.toContainText('"');
  // The modal fits the phone width without a sideways scroll.
  const box = (await dialog.boundingBox())!;
  expect(box.x).toBeGreaterThanOrEqual(0);
  expect(box.x + box.width).toBeLessThanOrEqual(375);
  expect(
    await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth),
  ).toBe(true);

  const help = dialog.getByRole("button", { name: "상세사이즈 입력 도움말" });
  await help.click();
  const helpDialog = page.getByRole("dialog", { name: "상세사이즈 입력 도움말" });
  await expect(helpDialog).toContainText("mm로 입력합니다.");
  await page.keyboard.press("Escape");
  await expect(helpDialog).toHaveCount(0);
  await expect(dialog).toBeVisible();
  await expect(help).toBeFocused();

  await dialog
    .getByRole("button", { name: "저장", exact: true })
    .scrollIntoViewIfNeeded();
  await dialog.getByRole("button", { name: "저장", exact: true }).click();
  await expect(dialog).toBeHidden();
  expect(audit.patches).toEqual([
    {
      version: 3,
      sizeChart: {
        kind: "wheel",
        values: { diameter: 54, width: 33.5, contactWidth: 20 },
      },
    },
  ]);
  await expect(page.getByText("휠 · 지름 54mm")).toBeVisible();
  expect(audit.blocked).toEqual([]);
});

const storefrontChart = async (page: Page) => {
  await page.getByRole("button", { name: "상세사이즈" }).click();
  const svg = page.getByRole("dialog").locator("svg");
  await expect(svg).toBeVisible();
  return svg;
};

test("a top's storefront chart uses the selected size's values, then the default", async ({
  page,
}, testInfo) => {
  const audit = await setup(page, `/products/${DECK.slug}`, undefined, {
    category: "Top",
    sizes: ["S", "M"],
    sizeChart: { kind: "shortSleeve", values: TOP },
    sizeChartKind: "shortSleeve",
    sizeChartsBySize: { S: { ...TOP, length: 74 } },
  });
  await expect(page.getByRole("heading", { name: "[TEST] Deck size A" })).toBeVisible();
  let svg = await storefrontChart(page);
  await expect(svg).toHaveAttribute("aria-label", /^반팔: 총장 74cm \(29\.1"\)/);
  for (const text of ["74cm", '(29.1")', "50.5cm", '(19.9")'])
    await expect(svg).toContainText(text);
  await page.screenshot({ path: testInfo.outputPath("size-chart-desktop-light.png") });
  // A wide screen shows the whole drawing, so there is no extra scroll stop.
  await expect(page.getByRole("dialog").getByRole("region")).toHaveCount(0);
  await page.keyboard.press("Escape");

  // M has no values of its own, so the default shows.
  await page.getByRole("button", { name: "M", exact: true }).click();
  svg = await storefrontChart(page);
  await expect(svg).toContainText("72cm");
  await expect(svg).not.toContainText("74cm");
  await page.keyboard.press("Escape");
  expect(audit.blocked).toEqual([]);
});

test("bottoms show only sizes with values when there is no default, and wheels stay in mm", async ({
  page,
}) => {
  const pants = { length: 100, waist: 40, hip: 52, thigh: 32, rise: 30, hem: 21.5 };
  const audit = await setup(page, `/products/${DECK.slug}`, undefined, {
    category: "Bottom",
    sizes: ["30", "32"],
    sizeChartKind: "longPants",
    sizeChartsBySize: { "32": pants },
  });
  await expect(page.getByRole("heading", { name: "[TEST] Deck size A" })).toBeVisible();
  await expect(page.getByRole("button", { name: "상세사이즈" })).toHaveCount(0);
  await page.getByRole("button", { name: "32", exact: true }).click();
  const svg = await storefrontChart(page);
  await expect(svg).toHaveAttribute("aria-label", /^긴바지: 총장 100cm/);
  await expect(svg).toContainText("21.5cm");
  await page.keyboard.press("Escape");
  expect(audit.blocked).toEqual([]);

  const wheels = await setup(page, `/products/${DECK.slug}`, undefined, {
    category: "Wheels",
    sizes: ["54mm 99a", "56mm 99a"],
    sizeChart: {
      kind: "wheel",
      values: { diameter: 54, width: 33.5, contactWidth: 20 },
    },
    sizeChartKind: "wheel",
  });
  for (const size of ["54mm 99a", "56mm 99a"]) {
    await page.getByRole("button", { name: size, exact: true }).click();
    const wheel = await storefrontChart(page);
    await expect(wheel).toContainText("33.5mm");
    await expect(wheel).not.toContainText('"');
    await page.keyboard.press("Escape");
  }
  expect(wheels.blocked).toEqual([]);
});

test("the product's category picks the chart when both a deck spec and a size chart remain", async ({
  page,
}) => {
  // A deck spec saved before the category changed stays on the record next to the new chart.
  const both = {
    sizes: ["S"],
    deckSpec: SPEC,
    sizeChart: { kind: "shortSleeve", values: TOP },
    sizeChartKind: "shortSleeve",
  };
  const audit = await setup(page, `/products/${DECK.slug}`, undefined, {
    ...both,
    category: "Top",
  });
  await expect(page.getByRole("heading", { name: "[TEST] Deck size A" })).toBeVisible();
  let svg = await storefrontChart(page);
  await expect(svg).toHaveAttribute("aria-label", /^반팔: 총장 72cm/);
  await expect(svg).not.toContainText('8.5"');
  await page.keyboard.press("Escape");
  expect(audit.blocked).toEqual([]);

  // A deck keeps its deck drawing; the public parser already drops the top chart for it.
  const deck = await setup(page, `/products/${DECK.slug}`, undefined, {
    ...both,
    category: "Deck",
  });
  svg = await storefrontChart(page);
  await expect(svg).toContainText('8.5"');
  await expect(svg).not.toContainText("72cm");
  await page.keyboard.press("Escape");
  expect(deck.blocked).toEqual([]);
});

test("a top without any size chart shows no size chart button", async ({ page }) => {
  const audit = await setup(page, `/products/${DECK.slug}`, undefined, {
    category: "Top",
    sizes: ["S", "M"],
  });
  await expect(page.getByRole("heading", { name: "[TEST] Deck size A" })).toBeVisible();
  for (const size of ["S", "M"]) {
    await page.getByRole("button", { name: size, exact: true }).click();
    await expect(page.getByRole("button", { name: "상세사이즈" })).toHaveCount(0);
  }
  expect(audit.blocked).toEqual([]);
});

/** Rendered size of a value and its inch note: the SVG font size times the drawing's scale. */
async function renderedLabelSizes(svg: ReturnType<Page["locator"]>) {
  return svg.evaluate((element) => {
    const drawing = element as SVGSVGElement;
    const scale = drawing.getBoundingClientRect().width / drawing.viewBox.baseVal.width;
    const size = (selector: string) =>
      Math.min(
        ...[...drawing.querySelectorAll(selector)].map(
          (node) => parseFloat(getComputedStyle(node).fontSize) * scale,
        ),
      );
    return { value: size("text"), inch: size("tspan") };
  });
}

test("the wide clothing drawing keeps readable labels at 375, 768, 1024 and 1440px and scrolls only when its box is narrower", async ({
  page,
}) => {
  const audit = await setup(page, `/products/${DECK.slug}`, undefined, {
    category: "Bottom",
    sizes: ["32"],
    sizeChart: {
      kind: "longPants",
      values: {
        length: 288.8,
        waist: 288.8,
        hip: 288.8,
        thigh: 288.8,
        rise: 288.8,
        hem: 288.8,
      },
    },
    sizeChartKind: "longPants",
  });
  const region = page
    .getByRole("dialog")
    .getByRole("region", { name: "상세사이즈 도면, 옆으로 넘겨 보기" });
  const seen: Record<number, boolean> = {};
  for (const width of [375, 768, 1024, 1440]) {
    await page.setViewportSize({ width, height: 900 });
    const svg = await storefrontChart(page);
    const sizes = await renderedLabelSizes(svg);
    expect(sizes.value, `${width}px value`).toBeGreaterThanOrEqual(12);
    expect(sizes.inch, `${width}px inch`).toBeGreaterThanOrEqual(10);
    const box = svg.locator("xpath=..");
    const overflows = await box.evaluate(
      (element) => element.scrollWidth > element.clientWidth,
    );
    seen[width] = overflows;
    if (overflows) {
      // Only a box that really scrolls is a keyboard stop.
      await expect(region).toHaveCount(1);
      await region.focus();
      await page.keyboard.press("ArrowRight");
      await expect
        .poll(() => region.evaluate((element) => element.scrollLeft))
        .toBeGreaterThan(0);
    } else await expect(region).toHaveCount(0);
    expect(
      await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth),
    ).toBe(true);
    await page.keyboard.press("Escape");
  }
  // A phone scrolls inside the box; a wide desktop shows the whole drawing.
  expect(seen[375]).toBe(true);
  expect(seen[1440]).toBe(false);
  expect(audit.blocked).toEqual([]);
});

test("widening the screen while the scrolling box has focus keeps the focus in the dialog", async ({
  page,
}) => {
  await page.setViewportSize({ width: 375, height: 800 });
  const audit = await setup(page, `/products/${DECK.slug}`, undefined, {
    category: "Top",
    sizes: ["S"],
    sizeChart: { kind: "shortSleeve", values: TOP },
    sizeChartKind: "shortSleeve",
  });
  await storefrontChart(page);
  const dialog = page.getByRole("dialog");
  const region = dialog.getByRole("region", {
    name: "상세사이즈 도면, 옆으로 넘겨 보기",
  });
  await region.focus();
  await expect(region).toBeFocused();
  await page.setViewportSize({ width: 1440, height: 900 });
  await expect(region).toHaveCount(0);
  const inDialog = () =>
    page.evaluate(() => Boolean(document.activeElement?.closest('[role="dialog"]')));
  expect(await inDialog()).toBe(true);
  // Tab still cycles inside the dialog.
  await page.keyboard.press("Tab");
  expect(await inDialog()).toBe(true);
  await page.keyboard.press("Escape");
  await expect(dialog).toHaveCount(0);
  expect(audit.blocked).toEqual([]);
});

for (const theme of ["light", "dark"] as const)
  test(`the wide clothing drawing stays readable on a 375px screen in the ${theme} theme`, async ({
    page,
  }, testInfo) => {
    await page.setViewportSize({ width: 375, height: 800 });
    await page.addInitScript(
      (value) => localStorage.setItem("paradays-theme", value),
      theme,
    );
    const audit = await setup(page, `/products/${DECK.slug}`, undefined, {
      category: "Top",
      sizes: ["S"],
      sizeChart: {
        kind: "raglanLongSleeve",
        values: {
          length: 288.8,
          chest: 288.8,
          cuff: 288.8,
          neckToCuff: 288.8,
          hem: 288.8,
          armhole: 288.8,
        },
      },
      sizeChartKind: "raglanLongSleeve",
    });
    await expect(page.locator("html")).toHaveAttribute("data-theme", theme);
    const svg = await storefrontChart(page);
    const sizes = await renderedLabelSizes(svg);
    expect(sizes.value).toBeGreaterThanOrEqual(12);
    expect(sizes.inch).toBeGreaterThanOrEqual(10);
    // The wider drawing scrolls inside its own box; the page itself never scrolls sideways.
    const box = page
      .getByRole("dialog")
      .getByRole("region", { name: "상세사이즈 도면, 옆으로 넘겨 보기" });
    expect(
      await box.evaluate((element) => element.scrollWidth > element.clientWidth),
    ).toBe(true);
    // The keyboard reaches the box and scrolls it.
    await box.focus();
    await expect(box).toBeFocused();
    await page.keyboard.press("ArrowRight");
    await expect
      .poll(() => box.evaluate((element) => element.scrollLeft))
      .toBeGreaterThan(0);
    expect(
      await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth),
    ).toBe(true);
    await svg.scrollIntoViewIfNeeded();
    await page.screenshot({ path: testInfo.outputPath(`size-chart-375-${theme}.png`) });
    await page.keyboard.press("Escape");
    expect(audit.blocked).toEqual([]);
  });

test("a deck saves a partial size chart with null, shows null, reopens empty and deletes when emptied", async ({
  page,
}) => {
  const audit = await setup(page, "/admin?section=products");
  await editDeck(page);
  await page.getByRole("button", { name: "+ 상세사이즈 등록" }).click();
  const dialog = page.getByRole("dialog");
  const input = (field: string) => dialog.getByRole("textbox", { name: field });
  const save = dialog.getByRole("button", { name: "저장", exact: true });
  // Nothing saved and nothing typed: nothing to save.
  await expect(save).toBeDisabled();
  await input("width").fill("8.5");
  await input("length").fill("31.75");
  // The preview shows at once, with null on the blank fields.
  await expect(dialog.locator("svg")).toHaveAttribute(
    "aria-label",
    /^nose null, tail null/,
  );
  await save.click();
  await expect(dialog).toBeHidden();
  const partial = {
    nose: null,
    tail: null,
    width: 8.5,
    length: 31.75,
    wheelbase: null,
  };
  expect(audit.patches).toEqual([{ version: 3, deckSpec: partial }]);
  await expect(
    page.getByText('8.5" × 31.75" · WB null', { exact: true }),
  ).toBeVisible();

  // Reopened, blank fields are empty inputs, not the word null.
  await page.getByRole("button", { name: "상세사이즈 수정" }).click();
  await expect(input("nose")).toHaveValue("");
  await expect(input("width")).toHaveValue("8.5");
  // Emptying every field is the same as deleting.
  await input("width").fill("");
  await input("length").fill("");
  await expect(save).toBeEnabled();
  await save.click();
  await expect(dialog).toBeHidden();
  expect(audit.patches[1]).toEqual({ version: 4, deckSpec: null });
  await expect(page.getByRole("button", { name: "+ 상세사이즈 등록" })).toBeVisible();
  expect(audit.blocked).toEqual([]);
});

test("a top saves partial default and option values with null, renames with every field empty, and an empty form saves nothing", async ({
  page,
}) => {
  const audit = await setup(page, "/admin?section=products", undefined, topProduct());
  const item = audit.store.find((entry) => entry.productId === DECK.id)!;
  await editDeck(page);
  await page.getByRole("button", { name: "+ 상세사이즈 등록" }).click();
  const dialog = page.getByRole("dialog");
  const save = dialog.getByRole("button", { name: "저장", exact: true });
  await dialog.getByRole("textbox", { name: "가슴단면" }).fill("56");
  await expect(dialog.locator("svg")).toHaveAttribute(
    "aria-label",
    /^반팔: 총장 null, 어깨너비 null, 가슴단면 56cm/,
  );
  await save.click();
  await expect(dialog).toBeHidden();
  const blank = Object.fromEntries(Object.keys(TOP).map((key) => [key, null]));
  expect(audit.patches[0]).toEqual({
    version: 3,
    sizeChart: { kind: "shortSleeve", values: { ...blank, chest: 56 } },
  });
  // The summary names the first measurement even when it is blank.
  await expect(page.getByText("반팔 · 총장 null", { exact: true })).toBeVisible();

  // An option with nothing saved and nothing typed has nothing to save.
  await chip(page, "M").click();
  await expect(save).toBeDisabled();
  // A new name with every field empty saves the name alone.
  await dialog.getByRole("textbox", { name: "옵션 이름" }).fill("L");
  await expect(save).toBeEnabled();
  await save.click();
  await expect(dialog).toBeHidden();
  expect(audit.patches[1]).toEqual({
    version: 4,
    size: "M",
    sizeName: "L",
    sizeChartValues: null,
  });
  await expect(chipNames(page)).toHaveText(["S", "L"]);

  // A partial option value saves with null.
  await chip(page, "L").click();
  await dialog.getByRole("textbox", { name: "총장" }).fill("74");
  await save.click();
  await expect(dialog).toBeHidden();
  expect(audit.patches[2]).toEqual({
    version: 5,
    size: "L",
    sizeChartValues: { ...blank, length: 74 },
  });
  expect(item.sizeChartsBySize).toEqual({ L: { ...blank, length: 74 } });
  expect(audit.blocked).toEqual([]);
});

test("the store draws blank fields as null for decks and tops, and switching sizes changes the numbers", async ({
  page,
}) => {
  const blank = Object.fromEntries(Object.keys(TOP).map((key) => [key, null]));
  const audit = await setup(page, `/products/${DECK.slug}`, undefined, {
    category: "Top",
    sizes: ["S", "M"],
    sizeChart: { kind: "shortSleeve", values: { ...blank, length: 72, chest: 56 } },
    sizeChartKind: "shortSleeve",
    sizeChartsBySize: { M: { ...blank, length: 74 } },
  });
  await expect(page.getByRole("heading", { name: "[TEST] Deck size A" })).toBeVisible();
  let svg = await storefrontChart(page);
  await expect(svg).toHaveAttribute(
    "aria-label",
    /^반팔: 총장 72cm \(28\.3"\), 어깨너비 null, 가슴단면 56cm/,
  );
  await expect(svg).toContainText("null");
  await expect(svg).not.toContainText("nullcm");
  await page.keyboard.press("Escape");
  await page.getByRole("button", { name: "M", exact: true }).click();
  svg = await storefrontChart(page);
  await expect(svg).toHaveAttribute(
    "aria-label",
    /^반팔: 총장 74cm \(29\.1"\), 어깨너비 null, 가슴단면 null/,
  );
  await page.keyboard.press("Escape");
  expect(audit.blocked).toEqual([]);

  const deck = await setup(page, `/products/${DECK.slug}`, {
    ...SPEC,
    nose: null,
    tail: null,
  } as unknown as typeof SPEC);
  svg = await storefrontChart(page);
  await expect(svg).toHaveAttribute("aria-label", /^nose null, tail null, width 8\.5"/);
  await expect(svg).not.toContainText('null"');
  await page.keyboard.press("Escape");
  expect(deck.blocked).toEqual([]);
});
