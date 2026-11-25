/** admin-ocr 분할 spec 공통 fixture: test-only session, intercepted provider API, synthetic image·region 도우미. */
import { expect, type Page, type Route } from "@playwright/test";
import type { OcrTableAnalysis } from "../lib/admin-ui/types";
import { parseOcrTableRows } from "../infra/lambda/ocr-table-parser.js";
import { deflateSync } from "node:zlib";
import type { OcrMapping, OcrTableToken } from "../infra/lambda/ocr-table-parser.js";

export const TEMPLATE_KEY = "paradays.ocr.column-templates.v1";
export const mapping = {
  schemaVersion: 1 as const,
  headerRow: 0,
  columns: { productName: 0, brand: 1, option: 2, quantity: 3 },
};
export const table = {
  headerRow: 0,
  columns: [
    { index: 0, label: "상품명", role: "productName" },
    { index: 1, label: "브랜드", role: "brand" },
    { index: 2, label: "옵션", role: "option" },
    { index: 3, label: "수량", role: "quantity" },
  ],
};

export const API = "https://api.ocr.test/prod/";
export const OCR_ROUTE = `${API}admin/ocr/jobs**`;
export const REMOTE_DEMO_E2E = process.env.PARADAYS_OCR_E2E_REMOTE_DEMO === "true";
export const LOCAL_MODE_E2E = process.env.PARADAYS_OCR_E2E_LOCAL_MODE === "true";
export const REMOTE_DEMO_API = "https://ocr-relay.demo.test";
export const REMOTE_DEMO_OCR_ROUTE = `${REMOTE_DEMO_API}/admin/ocr/jobs**`;
export const FIREBASE_ORIGIN = "https://paradays.web.app";
export const unexpectedWrites = new WeakMap<Page, string[]>();
// 유효한 합성 PNG임. 외부/개인 이미지 없이 naturalWidth·축척·드래그를 검증함.
export function syntheticPng(width = 1600, height = 820) {
  const crc = (bytes: Buffer) => {
    let result = 0xffffffff;
    for (const byte of bytes) {
      result ^= byte;
      for (let bit = 0; bit < 8; bit++)
        result = (result >>> 1) ^ (result & 1 ? 0xedb88320 : 0);
    }
    return (result ^ 0xffffffff) >>> 0;
  };
  const chunk = (name: string, data: Buffer) => {
    const type = Buffer.from(name),
      size = Buffer.alloc(4),
      checksum = Buffer.alloc(4);
    size.writeUInt32BE(data.length);
    checksum.writeUInt32BE(crc(Buffer.concat([type, data])));
    return Buffer.concat([size, type, data, checksum]);
  };
  const pixels = Buffer.alloc((width * 3 + 1) * height, 255);
  for (let y = 0; y < height; y++) {
    pixels[y * (width * 3 + 1)] = 0;
    for (let x = 0; x < width; x++)
      if ((y >= 200 && y <= 230) || (y >= 320 && y <= 350)) {
        const field =
          x >= 100 && x < 450
            ? 0
            : x >= 500 && x < 680
              ? 1
              : x >= 800 && x < 1000
                ? 2
                : x >= 1280 && x < 1360
                  ? 3
                  : -1;
        if (field >= 0) {
          const start = y * (width * 3 + 1) + 1 + x * 3;
          pixels[start] = [205, 232, 208, 245][field];
          pixels[start + 1] = [220, 210, 235, 220][field];
          pixels[start + 2] = [245, 245, 222, 205][field];
        }
      }
  }
  const header = Buffer.alloc(13);
  header.writeUInt32BE(width, 0);
  header.writeUInt32BE(height, 4);
  header[8] = 8;
  header[9] = 2;
  return Buffer.concat([
    Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
    chunk("IHDR", header),
    chunk("IDAT", deflateSync(pixels)),
    chunk("IEND", Buffer.alloc(0)),
  ]);
}
export const PNG = syntheticPng();
export const JWT = [
  Buffer.from(JSON.stringify({ alg: "none", typ: "JWT" })).toString("base64url"),
  Buffer.from(
    JSON.stringify({
      sub: "ocr-test-admin",
      exp: 4_102_444_800,
      "cognito:groups": ["admin"],
    }),
  ).toString("base64url"),
  "test-only-signature",
].join(".");

export function job(id = "ocr_job_A", text = "Original A", version = 1) {
  return {
    jobId: id,
    version,
    rawText: text,
    analysis: { mode: "table", mapping, table } as OcrTableAnalysis,
    rows: [
      {
        id: "ocr_1",
        sourceText: text,
        confidence: 0.94,
        box: [
          [10, 20],
          [30, 20],
          [30, 40],
          [10, 40],
        ],
        productName: text,
        brand: "PRADAYS",
        option: "8.25",
        quantity: "2",
      },
    ],
  };
}

export async function json(route: Route, body: unknown, status = 200) {
  await route.fulfill({
    status,
    json: body,
    headers: {
      "access-control-allow-origin": "*",
      "access-control-allow-headers": "authorization,content-type",
      "access-control-allow-methods": "GET,POST,PATCH,OPTIONS",
    },
  });
}

export function heldResponse() {
  let entered: (route: Route) => void = () => {};
  const started = new Promise<Route>((resolve) => {
    entered = resolve;
  });
  let release: () => void = () => {};
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  let payload: unknown;
  let status = 200;
  return {
    started,
    async handle(route: Route) {
      entered(route);
      await gate;
      await json(route, payload, status);
    },
    respond(body: unknown, code = 200) {
      payload = body;
      status = code;
      release();
    },
  };
}

export async function flushResponse(
  page: Page,
  response: Promise<import("@playwright/test").Response>,
) {
  await (await response).finished();
  await page.evaluate(
    () =>
      new Promise((resolve) =>
        requestAnimationFrame(() => requestAnimationFrame(() => resolve(null))),
      ),
  );
}

export async function selectFile(page: Page, name: string) {
  await page
    .locator('input[accept="image/png,image/jpeg,image/webp"]')
    .setInputFiles({ name, mimeType: "image/png", buffer: PNG });
  await expect(
    page.getByRole("button", { name: "OCR로 텍스트 추출", exact: true }),
  ).toBeEnabled();
}

export async function selectAdminTab(page: Page, name: string | RegExp) {
  const tab = page.getByRole("tab", { name, exact: typeof name === "string" });
  if (!(await tab.isVisible()))
    await page.getByRole("button", { name: "운영 메뉴 열기", exact: true }).click();
  await tab.click();
}

export async function openRowDetails(page: Page) {
  // Existing contract regressions explicitly reveal the editable source and
  // immutable provider metadata. Redesign tests separately verify the default.
  for (const details of await page
    .locator("article details")
    .filter({
      has: page.locator("summary", { hasText: /^인식 원문·상세 보기$/u }),
    })
    .all()) {
    if (!(await details.evaluate((node) => (node as HTMLDetailsElement).open)))
      await details.locator("summary").click();
  }
}

export async function openAdvancedMapping(page: Page) {
  const details = page.locator("details").filter({
    has: page.locator("summary", {
      hasText: /^표 인식이 다르면 · 열·이미지 영역 직접 지정$/u,
    }),
  });
  if (await details.count()) {
    if (!(await details.evaluate((node) => (node as HTMLDetailsElement).open)))
      await details.locator("summary").click();
  }
}

export async function recognize(page: Page, name = "A.png", revealDetails = true) {
  await selectFile(page, name);
  await page.getByRole("button", { name: "OCR로 텍스트 추출", exact: true }).click();
  await expect(
    page.getByRole("textbox", { name: "상품명", exact: true }).first(),
  ).toBeVisible();
  if (revealDetails) {
    await openRowDetails(page);
    await openAdvancedMapping(page);
    await expect(
      page.getByRole("textbox", { name: "OCR 원문 (수정 가능)", exact: true }).first(),
    ).not.toHaveValue("");
  }
}

export const fieldRects = {
  productName: [90, 190, 450, 240],
  brand: [490, 190, 680, 240],
  option: [790, 190, 1000, 240],
  quantity: [1270, 190, 1370, 240],
} as const;
export function regionTokens(): OcrTableToken[] {
  const token = (
    id: string,
    sourceText: string,
    left: number,
    top: number,
    width: number,
  ) => ({
    id,
    sourceText,
    confidence: 0.94,
    box: [
      [left, top],
      [left + width, top],
      [left + width, top + 30],
      [left, top + 30],
    ] as const,
  });
  return [
    token("title", "Synthetic intake", 100, 70, 260),
    token("name1", "Synthetic deck", 100, 200, 250),
    token("brand1", "Test Maker", 500, 200, 120),
    token("option1", "Black", 800, 200, 120),
    token("qty1", "2", 1300, 200, 30),
    token("price1", "120000", 1100, 200, 100),
    token("name2", "Synthetic wheels", 100, 320, 280),
    token("brand2", "Test Maker", 500, 320, 120),
    token("option2", "White", 800, 320, 120),
    token("qty2", "3", 1300, 320, 30),
    token("price2", "150000", 1100, 320, 100),
    token("footer", "합계", 100, 420, 80),
    token("footerqty", "5", 1300, 420, 30),
  ];
}
export async function setupRegionApi(
  page: Page,
  id = "ocr_region",
  sources = regionTokens(),
) {
  let canonical = {
    jobId: id,
    version: 1,
    rawText: sources.map((row) => row.sourceText).join("\n"),
    rows: sources.map((row) => ({
      ...row,
      productName: "",
      brand: "",
      option: "",
      quantity: "",
    })),
    analysis: { mode: "unclassified", reason: "header-not-found" } as OcrTableAnalysis,
  };
  const calls: Record<string, unknown>[] = [];
  await page.route(OCR_ROUTE, async (route) => {
    const method = route.request().method();
    if (method === "OPTIONS") return json(route, {});
    if (method === "POST") return json(route, { job: canonical }, 201);
    if (method === "GET") return json(route, { job: canonical });
    const body = route.request().postDataJSON();
    calls.push(body);
    if (body.version !== canonical.version)
      return json(route, { code: "OCR_JOB_VERSION_CONFLICT" }, 409);
    if (body.mapping) {
      const parsed = parseOcrTableRows(sources, body.mapping as OcrMapping);
      const { rows, ...analysis } = parsed;
      if (parsed.mode !== "table")
        return json(route, { code: "OCR_JOB_MAPPING_UNUSABLE", analysis }, 400);
      const projected = rows.map((row) => ({
        ...row,
        productName: "productName" in row ? String(row.productName) : "",
        brand: "brand" in row ? String(row.brand) : "",
        option: "option" in row ? String(row.option) : "",
        quantity: "quantity" in row ? String(row.quantity) : "",
      }));
      if (body.preview)
        return json(route, {
          preview: { jobId: id, version: canonical.version, rows: projected, analysis },
        });
      canonical = {
        ...canonical,
        version: canonical.version + 1,
        rows: projected,
        analysis,
      };
    } else
      canonical = { ...canonical, version: canonical.version + 1, rows: body.rows };
    return json(route, { job: canonical });
  });
  return { calls, current: () => canonical };
}
export async function imagePoint(page: Page, x: number, y: number) {
  const surface = page.getByRole("group", { name: "이미지 영역 선택", exact: true });
  const frame = surface.locator("..");
  await frame.scrollIntoViewIfNeeded();
  await frame.evaluate(
    (node, { x, y }) => {
      const image = node.querySelector("img")!;
      node.scrollLeft = x * image.clientWidth - node.clientWidth / 2;
      node.scrollTop = y * image.clientHeight - node.clientHeight / 2;
    },
    { x, y },
  );
  const bounds = await page
    .getByRole("img", { name: "입고표 영역 지정 이미지", exact: true })
    .boundingBox();
  if (!bounds) throw new Error("Image not visible");
  return {
    x: bounds.x + x * bounds.width,
    y: bounds.y + y * bounds.height,
    width: bounds.width,
    height: bounds.height,
  };
}
export async function dragRegion(
  page: Page,
  field: keyof typeof fieldRects,
  reverse = false,
  selection: readonly [number, number, number, number] = fieldRects[field],
) {
  await page
    .getByRole("button", {
      name: `${{ productName: "상품명", brand: "브랜드", option: "옵션", quantity: "수량" }[field]} 영역`,
      exact: true,
    })
    .click();
  const [left, top, right, bottom] = selection;
  const center = await imagePoint(page, (left + right) / 3200, (top + bottom) / 1640);
  const image = await page
    .getByRole("img", { name: "입고표 영역 지정 이미지", exact: true })
    .boundingBox();
  if (!image) throw new Error("Image bounds missing");
  const start = {
    x: image.x + ((reverse ? right : left) / 1600) * center.width,
    y: image.y + ((reverse ? bottom : top) / 820) * center.height,
  };
  const end = {
    x: image.x + ((reverse ? left : right) / 1600) * center.width,
    y: image.y + ((reverse ? top : bottom) / 820) * center.height,
  };
  await page.mouse.move(start.x, start.y);
  await page.mouse.down();
  await page.mouse.move(end.x, end.y, { steps: 4 });
  await page.mouse.up();
  await expect(
    page.getByRole("button", {
      name: `${{ productName: "상품명", brand: "브랜드", option: "옵션", quantity: "수량" }[field]} 영역`,
      exact: true,
    }),
  ).toContainText("지정됨");
}
export async function setTableEnd(page: Page, y = 370) {
  await page.getByRole("button", { name: /^표 끝 지정/u }).click();
  const point = await imagePoint(page, 0.5, y / 820);
  await page.mouse.click(point.x, point.y);
  await expect(page.getByRole("button", { name: /^표 끝 지정/u })).toContainText(
    "지정됨",
  );
}
export async function configureRegions(page: Page, missing = false) {
  await expect(
    page.getByRole("img", { name: "입고표 영역 지정 이미지", exact: true }),
  ).toHaveJSProperty("naturalWidth", 1600);
  await dragRegion(page, "productName", true);
  if (missing) {
    await page.getByRole("button", { name: "브랜드 없음", exact: true }).click();
    await page.getByRole("button", { name: "옵션 없음", exact: true }).click();
  } else {
    await dragRegion(page, "brand");
    await dragRegion(page, "option");
  }
  await dragRegion(page, "quantity");
  await setTableEnd(page);
  await page
    .getByRole("checkbox", {
      name: "선택한 수량 영역은 금액이 아닌 실제 수량입니다",
      exact: true,
    })
    .check();
  await expect(
    page.getByRole("button", { name: "영역 미리보기", exact: true }),
  ).toBeEnabled();
}

export async function adminOcrBeforeEach({ page }: { page: Page }) {
  // All remote requests are intercepted or blocked. Fake JWT/session restore is
  // confined to the test; the production AuthProvider and connector run intact.
  unexpectedWrites.set(page, []);
  await page.route("**/*", async (route) => {
    const url = new URL(route.request().url());
    if (
      url.origin === "http://127.0.0.1:3137" &&
      ["GET", "HEAD"].includes(route.request().method())
    )
      return route.continue();
    if (["POST", "PUT", "PATCH", "DELETE"].includes(route.request().method())) {
      unexpectedWrites
        .get(page)!
        .push(`${route.request().method()} ${url.origin}${url.pathname}`);
      return route.abort();
    }
    if (!route.request().url().startsWith(API)) return route.abort();
    if (route.request().method() === "OPTIONS") return json(route, {});
    if (url.pathname.endsWith("/admin/catalog/products"))
      return json(route, { products: [] });
    if (url.pathname.endsWith("/admin/overview"))
      return json(route, {
        asOf: "2026-10-07T00:00:00Z",
        timezone: "Asia/Seoul",
        todayOrderCount: 0,
        lowStockCount: 0,
        lowStockThreshold: 3,
        activeCouponCount: 0,
        marketingConsentCount: 0,
      });
    return json(route, {}, 404);
  });
  await page.addInitScript(
    (session) => {
      sessionStorage.setItem("paradays.auth.session", JSON.stringify(session));
      localStorage.setItem("paradays-locale", "ko");
    },
    {
      accessToken: JWT,
      expiresAt: 4_102_444_800_000,
      user: { sub: "ocr-test-admin", username: "test-admin", groups: ["admin"] },
    },
  );
  await page.goto("/admin");
  await selectAdminTab(page, "입고 OCR");
  await expect(
    page.getByRole("heading", { name: "입고 검토", exact: true }),
  ).toBeVisible();
}

export async function adminOcrAfterEach({ page }: { page: Page }) {
  // Every intentional write must have an explicit synthetic fixture above this
  // final deny rule. Even an aborted, unanticipated write fails the regression.
  expect(unexpectedWrites.get(page) ?? []).toEqual([]);
}
