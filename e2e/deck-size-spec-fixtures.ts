// 역할: 사이즈표 spec 공통 fixture로, 합성 카탈로그 API와 관리자 편집·상점 조작 도우미를 제공함.
import { expect, type Page, type Route } from "@playwright/test";

export const ORIGIN = "http://127.0.0.1:3139";
export const API = "https://api.sales.test/prod/";
export const TRANSLATE = "https://api.mymemory.translated.net/get";
export const SUBJECT = "deck-size-synthetic-admin";
export const DECK = { slug: "odwyer-sync-1-8-375", id: "prd_deck_size_synthetic" };
export const PLAIN = { slug: "synthetic-deck-without-spec", id: "prd_deck_size_plain" };
export const SPEC = {
  nose: 6.875,
  tail: 6.5,
  width: 8.5,
  length: 31.75,
  wheelbase: 14.25,
};

export type Values = Record<string, number | null>;
export type Stored = {
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
/** 서버가 돌려주는 형태의 의류·휠 사이즈표 필드임. */
export function sizeChartShape(item: Stored) {
  return {
    ...(item.sizeChart ? { sizeChart: item.sizeChart } : {}),
    ...(item.sizeChartKind ? { sizeChartKind: item.sizeChartKind } : {}),
    ...(item.sizeChartsBySize ? { sizeChartsBySize: item.sizeChartsBySize } : {}),
  };
}
export type Audit = {
  blocked: string[];
  patches: Record<string, unknown>[];
  patchedIds: string[];
  store: Stored[];
};

export function respond(route: Route, body: unknown, status = 200) {
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

export function adminShape(item: Stored) {
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

export function publicShape(item: Stored) {
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

export async function setup(
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
        // 서버처럼 이름 변경은 두 종류의 옵션 값을 모두 옮김.
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
  // 앱이 해석한 PATCH 응답 수를 셈. React가 결과를 반영하도록 작업 하나와 두 프레임을 더 기다림.
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
export async function editDeck(page: Page) {
  await page
    .getByRole("list", { name: "상품 목록" })
    .getByRole("listitem")
    .filter({ hasText: "[TEST] Deck size A" })
    .getByRole("button", { name: "수정", exact: true })
    .click();
}
export const chipNames = (page: Page) =>
  page
    .getByRole("list", { name: "추가된 옵션" })
    .locator("li > :first-child > span:first-child");
export const chip = (page: Page, name: string) =>
  page
    .getByRole("list", { name: "추가된 옵션" })
    .getByRole("button", { name, exact: true });
export async function openDeckSpecModal(page: Page, productName: string) {
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
export const TOP = {
  length: 72,
  shoulder: 50.5,
  chest: 56,
  sleeveLength: 22,
  hem: 55,
  sleeveWidth: 20.5,
  armhole: 24,
};
export const TOP_FIELDS: [keyof typeof TOP, string][] = [
  ["length", "총장"],
  ["shoulder", "어깨너비"],
  ["chest", "가슴단면"],
  ["sleeveLength", "소매길이"],
  ["hem", "밑단단면"],
  ["sleeveWidth", "소매통"],
  ["armhole", "암홀"],
];
export const topProduct = (extra: Partial<Stored> = {}) => ({
  category: "Top",
  sizes: ["S", "M"],
  ...extra,
});
export async function fillTop(
  dialog: ReturnType<Page["getByRole"]>,
  values: Record<string, number>,
) {
  for (const [key, label] of TOP_FIELDS)
    await dialog.getByRole("textbox", { name: label }).fill(String(values[key]));
}
export const storefrontChart = async (page: Page) => {
  await page.getByRole("button", { name: "상세사이즈" }).click();
  const svg = page.getByRole("dialog").locator("svg");
  await expect(svg).toBeVisible();
  return svg;
};
