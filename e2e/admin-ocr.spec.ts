/** Real admin UI/client with test-only session and intercepted provider API. */
import { expect, test, type Page, type Route } from "@playwright/test";
import type { AdminOcrIntakeInput, OcrTableAnalysis } from "../lib/admin-ui/types";
import { parseRecognitionResponse } from "../infra/lambda/paddle-ocr.js";
import { parseOcrTableRows } from "../infra/lambda/ocr-table-parser.js";
import baselineProvider from "../tests/fixtures/ocr-baseline-provider.json" with { type: "json" };
import { deflateSync } from "node:zlib";
import type {
  OcrMapping,
  OcrRegionMapping,
  OcrTableToken,
} from "../infra/lambda/ocr-table-parser.js";

const TEMPLATE_KEY = "paradays.ocr.column-templates.v1";
const mapping = {
  schemaVersion: 1 as const,
  headerRow: 0,
  columns: { productName: 0, brand: 1, option: 2, quantity: 3 },
};
const table = {
  headerRow: 0,
  columns: [
    { index: 0, label: "상품명", role: "productName" },
    { index: 1, label: "브랜드", role: "brand" },
    { index: 2, label: "옵션", role: "option" },
    { index: 3, label: "수량", role: "quantity" },
  ],
};

const API = "https://api.ocr.test/prod/";
const OCR_ROUTE = `${API}admin/ocr/jobs**`;
const REMOTE_DEMO_E2E = process.env.PARADAYS_OCR_E2E_REMOTE_DEMO === "true";
const REMOTE_DEMO_API = "https://ocr-relay.demo.test";
const REMOTE_DEMO_OCR_ROUTE = `${REMOTE_DEMO_API}/admin/ocr/jobs**`;
const FIREBASE_ORIGIN = "https://paradays.web.app";
const unexpectedWrites = new WeakMap<Page, string[]>();
// 유효한 합성 PNG임. 외부/개인 이미지 없이 naturalWidth·축척·드래그를 검증함.
function syntheticPng(width = 1600, height = 820) {
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
const PNG = syntheticPng();
const JWT = [
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

function job(id = "ocr_job_A", text = "Original A", version = 1) {
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

async function json(route: Route, body: unknown, status = 200) {
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

function heldResponse() {
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

async function flushResponse(
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

async function selectFile(page: Page, name: string) {
  await page
    .locator('input[accept="image/png,image/jpeg,image/webp"]')
    .setInputFiles({ name, mimeType: "image/png", buffer: PNG });
  await expect(
    page.getByRole("button", { name: "OCR로 텍스트 추출", exact: true }),
  ).toBeEnabled();
}

async function selectAdminTab(page: Page, name: string | RegExp) {
  const tab = page.getByRole("tab", { name, exact: typeof name === "string" });
  if (!(await tab.isVisible()))
    await page.getByRole("button", { name: "운영 메뉴 열기", exact: true }).click();
  await tab.click();
}

async function openRowDetails(page: Page) {
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

async function openAdvancedMapping(page: Page) {
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

async function recognize(page: Page, name = "A.png", revealDetails = true) {
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

const fieldRects = {
  productName: [90, 190, 450, 240],
  brand: [490, 190, 680, 240],
  option: [790, 190, 1000, 240],
  quantity: [1270, 190, 1370, 240],
} as const;
function regionTokens(): OcrTableToken[] {
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
async function setupRegionApi(page: Page, id = "ocr_region", sources = regionTokens()) {
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
async function imagePoint(page: Page, x: number, y: number) {
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
async function dragRegion(
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
async function setTableEnd(page: Page, y = 370) {
  await page.getByRole("button", { name: /^표 끝 지정/u }).click();
  const point = await imagePoint(page, 0.5, y / 820);
  await page.mouse.click(point.x, point.y);
  await expect(page.getByRole("button", { name: /^표 끝 지정/u })).toContainText(
    "지정됨",
  );
}
async function configureRegions(page: Page, missing = false) {
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

test("numeric column settings are removed and local preview decodes the synthetic image", async ({
  page,
}) => {
  await setupRegionApi(page);
  await recognize(page);
  await expect(
    page.getByRole("img", { name: "입고표 영역 지정 이미지", exact: true }),
  ).toHaveJSProperty("naturalWidth", 1600);
  await expect(
    page.getByRole("img", { name: "입고표 영역 지정 이미지", exact: true }),
  ).toHaveJSProperty("naturalHeight", 820);
  await expect(
    page.getByRole("spinbutton", { name: "헤더 줄", exact: true }),
  ).toHaveCount(0);
  await expect(
    page.getByRole("combobox", { name: "상품명 열", exact: true }),
  ).toHaveCount(0);
  await expect(
    page.getByText("고급 설정 · 헤더 줄과 열 번호 지정", { exact: true }),
  ).toHaveCount(0);
  await expect(
    page.getByRole("button", { name: "영역 지정 적용", exact: true }),
  ).toBeDisabled();
});

test.describe("ocr redesign:", () => {
  function summaryMetric(page: Page, name: string) {
    return page
      .locator('[aria-label="현재 검토 행 요약"] article')
      .filter({
        has: page.getByText(name, { exact: true }),
      })
      .locator("strong");
  }

  function detail(page: Page, title: string) {
    return page.locator("details").filter({
      has: page.locator("summary", { hasText: title }),
    });
  }

  test("five stages distinguish unprocessed rows, saved review and separate stock application", async ({
    page,
  }) => {
    const inventory = await setupInventoryCatalogApi(page);
    await setupInventoryReviewApi(page);
    const stages = page.getByRole("list", { name: "OCR 등록 흐름", exact: true });
    await expect(stages.getByRole("listitem")).toHaveText([
      "1이미지 선택",
      "2OCR 인식",
      "3내용 검토",
      "4검토본 저장",
      "5입고 반영",
    ]);
    await expect(stages.locator('[aria-current="step"]')).toContainText("이미지 선택");
    await expect(summaryMetric(page, "검토 행")).toHaveText("0행");
    await expect(
      page.getByRole("button", { name: "검토본 저장", exact: true }),
    ).toBeDisabled();
    await recognize(page, "Design rows.png", false);
    await expect(stages.locator('[aria-current="step"]')).toContainText("내용 검토");
    await expect(summaryMetric(page, "검토 행")).toHaveText("1행");
    await expect(summaryMetric(page, "입력 수량 합계")).toHaveText("4개");
    await expect(
      page.getByRole("textbox", { name: "OCR 원문 (수정 가능)", exact: true }),
    ).toBeHidden();
    await expect(
      detail(page, "표 인식이 다르면 · 열·이미지 영역 직접 지정"),
    ).not.toHaveAttribute("open", "");
    await expect(detail(page, "인식 원문 보기 · 읽기 전용")).not.toHaveAttribute(
      "open",
      "",
    );
    expect(inventory.intakes).toHaveLength(0);
    await page.getByRole("button", { name: "검토본 저장", exact: true }).click();
    await expect(stages.locator('[aria-current="step"]')).toContainText("검토본 저장");
    await expect(
      page.getByRole("region", { name: "검토본 입고 반영", exact: true }),
    ).toBeVisible();
    await expect(
      page.getByRole("region", { name: "인식 결과", exact: true }),
    ).toContainText("재고는 변경되지 않습니다");
    expect(inventory.intakes).toHaveLength(0);
    expect(inventory.products[0]).toMatchObject({
      inventoryQuantity: 5,
      status: "PUBLISHED",
      version: 3,
    });
    await page
      .getByRole("textbox", { name: "상품명", exact: true })
      .fill("Changed after saved review");
    await expect(stages.locator('[aria-current="step"]')).toContainText("내용 검토");
    await expect(inventoryApplicationPanel(page)).toHaveCount(0);
    expect(inventory.intakes).toHaveLength(0);
  });

  test("summary follows actual edits and keyboard-revealed raw text remains immutable", async ({
    page,
  }) => {
    const result = job();
    result.rows[0] = { ...result.rows[0], brand: "", option: "" };
    result.rows.push({
      ...result.rows[0],
      id: "ocr_2",
      sourceText: "Second source",
      productName: "Second product",
      brand: "Maker",
      option: "M",
      quantity: "",
    });
    const methods: string[] = [];
    await page.route(OCR_ROUTE, async (route) => {
      if (route.request().method() === "OPTIONS") return json(route, {});
      methods.push(route.request().method());
      return json(route, { job: result }, 201);
    });
    await recognize(page, "Live summary.png", false);
    await expect(summaryMetric(page, "검토 행")).toHaveText("2행");
    await expect(summaryMetric(page, "입력 수량 합계")).toHaveText("2개");
    await expect(summaryMetric(page, "빈 항목 포함 행")).toHaveText("2행");
    const quantity = page.getByRole("textbox", { name: "수량", exact: true }).nth(1);
    await quantity.fill("3");
    await expect(summaryMetric(page, "입력 수량 합계")).toHaveText("5개");
    await expect(summaryMetric(page, "빈 항목 포함 행")).toHaveText("1행");
    await quantity.fill("1.5");
    await expect(summaryMetric(page, "입력 수량 합계")).toHaveText("수량 확인 필요");
    await quantity.fill("");
    await expect(summaryMetric(page, "입력 수량 합계")).toHaveText("2개");
    const raw = detail(page, "인식 원문 보기 · 읽기 전용");
    await raw.locator("summary").focus();
    await page.keyboard.press("Enter");
    await expect(raw.locator("pre")).toHaveText("Original A");
    await expect(raw.locator("input,textarea,[contenteditable=true]")).toHaveCount(0);
    const first = page.getByRole("article", { name: "1번째 입고 행", exact: true });
    await first.locator("summary").focus();
    await page.keyboard.press("Space");
    await first
      .getByRole("textbox", { name: "OCR 원문 (수정 가능)", exact: true })
      .fill("Reviewed source only");
    await expect(first.locator("dd")).toHaveText([
      "94%",
      "10, 20 → 30, 20 → 30, 40 → 10, 40",
    ]);
    await expect(first.getByRole("textbox", { name: /신뢰도|좌표/u })).toHaveCount(0);
    await expect(raw.locator("pre")).toHaveText("Original A");
    expect(methods).toEqual(["POST"]);
  });

  test("pending review save sends one exact versioned request and never writes stock", async ({
    page,
  }) => {
    const inventory = await setupInventoryCatalogApi(page);
    const pending = heldResponse();
    const patches: Record<string, unknown>[] = [];
    await page.route(OCR_ROUTE, async (route) => {
      if (route.request().method() === "OPTIONS") return json(route, {});
      if (route.request().method() === "POST") return json(route, { job: job() }, 201);
      expect(route.request().method()).toBe("PATCH");
      patches.push(route.request().postDataJSON());
      return pending.handle(route);
    });
    await recognize(page, "Pending review.png", false);
    await page.getByRole("button", { name: "검토본 저장", exact: true }).dblclick();
    await pending.started;
    await expect(
      page.getByRole("button", { name: "처리 중…", exact: true }),
    ).toBeDisabled();
    expect(patches).toHaveLength(1);
    expect(Object.keys(patches[0]).sort()).toEqual(["rawText", "rows", "version"]);
    expect(patches[0]).toEqual({
      version: 1,
      rawText: "Original A",
      rows: [
        {
          id: "ocr_1",
          sourceText: "Original A",
          productName: "Original A",
          brand: "PRADAYS",
          option: "8.25",
          quantity: "2",
        },
      ],
    });
    expect(inventory.intakes).toHaveLength(0);
    pending.respond({ job: job("ocr_job_A", "Original A", 2) });
    await expect(
      page.getByText("검토본 저장됨 · 서버 버전 2", { exact: true }),
    ).toBeVisible();
    expect(patches).toHaveLength(1);
    expect(inventory.intakes).toHaveLength(0);
  });

  for (const width of [1440, 375]) {
    test(`image and editable rows reflow at ${width} with usable controls and keyboard enlargement`, async ({
      page,
    }, testInfo) => {
      await page.setViewportSize({ width, height: 1000 });
      const result = job();
      result.rows.push({
        ...result.rows[0],
        id: "ocr_2",
        productName: "Second synthetic product",
        quantity: "3",
      });
      await page.route(OCR_ROUTE, async (route) => json(route, { job: result }, 201));
      await recognize(page, "Synthetic intake.png", false);
      const image = page.getByRole("img", {
        name: "선택한 입고 원본 이미지",
        exact: true,
      });
      await expect
        .poll(() => image.evaluate((node) => (node as HTMLImageElement).naturalWidth))
        .toBe(1600);
      await expect(
        page.getByRole("article", { name: "1번째 입고 행", exact: true }),
      ).toBeVisible();
      const review = page.getByRole("region", { name: "인식 결과", exact: true });
      const controls = review.getByRole("textbox").filter({ visible: true });
      for (const control of await controls.all()) {
        const bounds = await control.boundingBox();
        expect(bounds!.height).toBeGreaterThanOrEqual(44);
      }
      for (const button of [
        page.getByRole("button", { name: "OCR로 텍스트 추출", exact: true }),
        review.getByRole("button", { name: "행 추가", exact: true }),
        review.getByRole("button", { name: "1번 입고 행 삭제", exact: true }),
      ]) {
        const bounds = await button.boundingBox();
        expect(bounds!.height).toBeGreaterThanOrEqual(44);
      }
      expect(
        await page.evaluate(() => document.documentElement.scrollWidth),
      ).toBeLessThanOrEqual(width);
      await page.screenshot({
        path: testInfo.outputPath(`ocr-redesign-${width}.png`),
        fullPage: true,
      });
      const enlarge = page.getByRole("button", {
        name: "원본 이미지 확대 보기",
        exact: true,
      });
      await enlarge.focus();
      await page.keyboard.press("Enter");
      const dialog = page.getByRole("dialog", {
        name: "원본 이미지 확대",
        exact: true,
      });
      await expect(dialog).toBeVisible();
      await expect(
        dialog.getByRole("button", { name: "확대 보기 닫기", exact: true }),
      ).toBeFocused();
      await page.keyboard.press("Escape");
      await expect(dialog).toBeHidden();
      await expect(enlarge).toBeFocused();
      if (width === 375) {
        await page.setViewportSize({ width: 320, height: 900 });
        expect(
          await page.evaluate(() => document.documentElement.scrollWidth),
        ).toBeLessThanOrEqual(320);
        await page.screenshot({
          path: testInfo.outputPath("ocr-redesign-320.png"),
          fullPage: true,
        });
      }
    });
  }

  test("collapsed advanced mapping remains discoverable and keyboard operable without a write", async ({
    page,
  }) => {
    const api = await setupRegionApi(page);
    await recognize(page, "Keyboard mapping.png", false);
    const advanced = detail(page, "표 인식이 다르면 · 열·이미지 영역 직접 지정");
    await expect(
      page.getByRole("group", { name: "이미지 영역 선택", exact: true }),
    ).toBeHidden();
    await advanced.locator("summary").focus();
    await page.keyboard.press("Enter");
    await expect(
      page.getByRole("group", { name: "이미지 영역 선택", exact: true }),
    ).toBeVisible();
    await page.getByRole("button", { name: "상품명 영역", exact: true }).click();
    const frame = page.getByRole("group", { name: "이미지 영역 선택", exact: true });
    await frame.focus();
    await page.keyboard.press("Space");
    await page.keyboard.press("ArrowRight");
    await page.keyboard.press("ArrowDown");
    await page.keyboard.press("Enter");
    await expect(
      page.getByRole("button", { name: "상품명 영역", exact: true }),
    ).toContainText("지정됨");
    expect(api.calls).toHaveLength(0);
  });
});

test("actual approved baseline tokens map six products and 29 units through drag selection", async ({
  page,
}) => {
  const recognized = parseRecognitionResponse(baselineProvider);
  await setupRegionApi(page, "ocr_baseline", [...recognized.sourceRows!]);
  await recognize(page);
  await dragRegion(page, "productName", false, [60, 255, 620, 325]);
  await dragRegion(page, "brand", false, [680, 255, 860, 325]);
  await dragRegion(page, "option", false, [940, 255, 1260, 325]);
  await dragRegion(page, "quantity", false, [1410, 255, 1510, 325]);
  await setTableEnd(page, 730);
  await page
    .getByRole("checkbox", {
      name: "선택한 수량 영역은 금액이 아닌 실제 수량입니다",
      exact: true,
    })
    .check();
  await page.getByRole("button", { name: "영역 미리보기", exact: true }).click();
  await expect(
    page.getByText("상품 6개 · 수량 합계 29개 · 수량 미확인 0행", { exact: true }),
  ).toBeVisible();
  await expect(
    page.getByRole("region", { name: "영역 지정 미리보기 표", exact: true }),
  ).toContainText("메이플 데크");
});

test("region preview conflict loads latest canonical job and disables obsolete apply", async ({
  page,
}) => {
  const latest = job("ocr_region", "Latest canonical", 5);
  await setupRegionApi(page);
  await recognize(page);
  await configureRegions(page);
  await page.route(OCR_ROUTE, async (route) => {
    if (route.request().method() === "PATCH")
      return json(route, { code: "OCR_JOB_VERSION_CONFLICT" }, 409);
    if (route.request().method() === "GET") return json(route, { job: latest });
    return route.fallback();
  });
  await page.getByRole("button", { name: "영역 미리보기", exact: true }).click();
  await expect(page.getByRole("textbox", { name: "상품명", exact: true })).toHaveCount(
    1,
  );
  await expect(page.getByRole("textbox", { name: "상품명", exact: true })).toHaveValue(
    "Latest canonical",
  );
  await expect(
    page.getByRole("button", { name: "영역 지정 적용", exact: true }),
  ).toBeDisabled();
  await expect(page.getByRole("tabpanel").getByRole("alert")).toContainText(
    "열 지정을 다시 미리보기",
  );
});

test("saved regions refuse a mismatched image ratio without changing new selections", async ({
  page,
}) => {
  await setupRegionApi(page);
  await recognize(page);
  await configureRegions(page);
  await page.getByRole("button", { name: "현재 영역 양식 저장", exact: true }).click();
  await page.locator('input[accept="image/png,image/jpeg,image/webp"]').setInputFiles({
    name: "square.png",
    mimeType: "image/png",
    buffer: syntheticPng(800, 800),
  });
  await page.getByRole("button", { name: "OCR로 텍스트 추출", exact: true }).click();
  await expect(
    page.getByRole("textbox", { name: "상품명", exact: true }).first(),
  ).toBeVisible();
  await openAdvancedMapping(page);
  await expect(
    page.getByRole("img", { name: "입고표 영역 지정 이미지", exact: true }),
  ).toHaveJSProperty("naturalWidth", 800);
  await page.getByRole("button", { name: "영역 양식 불러오기", exact: true }).click();
  await page
    .getByRole("combobox", { name: "저장 영역 양식", exact: true })
    .selectOption({ label: "양식 1" });
  await page.getByRole("button", { name: "영역 양식 재사용", exact: true }).click();
  await expect(
    page.getByText(
      "이미지 비율이 저장된 영역 양식과 맞지 않아 재사용할 수 없습니다. 현재 영역 지정은 유지됩니다.",
      { exact: true },
    ),
  ).toBeVisible();
  await expect(
    page.getByRole("button", { name: "상품명 영역", exact: true }),
  ).toContainText("선택 필요");
  await expect(
    page.getByRole("button", { name: "영역 지정 적용", exact: true }),
  ).toBeDisabled();
});

test("four reversed/forward drag boxes preview canonical originals, apply then review save", async ({
  page,
}, testInfo) => {
  const api = await setupRegionApi(page);
  await recognize(page);
  await configureRegions(page);
  await page.getByRole("button", { name: "영역 미리보기", exact: true }).click();
  await expect(
    page.getByRole("region", { name: "영역 지정 미리보기 표", exact: true }),
  ).toContainText("Synthetic deck");
  await expect(
    page.getByText("상품 2개 · 수량 합계 5개 · 수량 미확인 0행", { exact: true }),
  ).toBeVisible();
  await expect(
    page.getByRole("textbox", { name: "상품명", exact: true }).first(),
  ).toHaveValue("");
  expect(api.current().version).toBe(1);
  const mapped = api.calls[0].mapping as OcrRegionMapping;
  expect(mapped.schemaVersion).toBe(2);
  expect(mapped.image).toEqual({ width: 1600, height: 820 });
  expect(mapped.firstRow.productName.left).toBeCloseTo(90 / 1600, 3);
  expect(mapped.firstRow.productName.right).toBeCloseTo(450 / 1600, 3);
  expect(mapped.tableBottom).toBeCloseTo(370 / 820, 3);
  expect(Object.keys(api.calls[0]).sort()).toEqual(["mapping", "preview", "version"]);
  await page
    .getByRole("region", { name: "이미지에서 영역 지정", exact: true })
    .screenshot({ path: testInfo.outputPath("drag-desktop.png") });
  page.once("dialog", (dialog) => dialog.accept());
  await page.getByRole("button", { name: "영역 지정 적용", exact: true }).click();
  await expect(
    page.getByRole("textbox", { name: "상품명", exact: true }).first(),
  ).toHaveValue("Synthetic deck");
  await expect(
    page.getByRole("textbox", { name: "수량", exact: true }).nth(1),
  ).toHaveValue("3");
  await openRowDetails(page);
  await expect(page.locator("dd").filter({ hasText: /^94%$/u })).toHaveCount(2);
  await page.getByRole("button", { name: "검토본 저장", exact: true }).click();
  await expect(
    page.getByText("서버 버전 3을 적용했습니다.", { exact: false }),
  ).toBeVisible();
  expect(api.calls[1].version).toBe(1);
  expect(api.calls[2].version).toBe(2);
});

test("missing brand and option stay blank; changing a region clears the ready preview", async ({
  page,
}) => {
  await setupRegionApi(page);
  await recognize(page);
  await configureRegions(page, true);
  await page.getByRole("button", { name: "영역 미리보기", exact: true }).click();
  await expect(
    page.getByRole("region", { name: "영역 지정 미리보기 표", exact: true }),
  ).toContainText("Synthetic wheels");
  const previewRows = page
    .getByRole("region", { name: "영역 지정 미리보기 표", exact: true })
    .locator("tbody tr");
  await expect(previewRows.first().locator("td").nth(1)).toHaveText("—");
  await expect(previewRows.first().locator("td").nth(2)).toHaveText("—");
  await dragRegion(page, "productName");
  await expect(
    page.getByRole("button", { name: "영역 지정 적용", exact: true }),
  ).toBeDisabled();
  await expect(
    page.getByRole("region", { name: "영역 지정 미리보기 표", exact: true }),
  ).toHaveCount(0);
});

test("headerless rows without quantity require a valid aligned second-product hint", async ({
  page,
}) => {
  await setupRegionApi(page);
  await recognize(page);
  await dragRegion(page, "productName");
  for (const name of ["브랜드 없음", "옵션 없음", "수량 없음"])
    await page.getByRole("button", { name, exact: true }).click();
  await setTableEnd(page);
  await page.getByRole("button", { name: "영역 미리보기", exact: true }).click();
  await expect(page.getByRole("tabpanel").getByRole("alert")).toContainText(
    "두 번째 상품 위치",
  );
  await page.getByRole("button", { name: /^두 번째 상품 위치$/u }).click();
  const wrong = await imagePoint(page, 0.9, 335 / 820);
  await page.mouse.click(wrong.x, wrong.y);
  await expect(
    page.getByText(
      "두 번째 상품명을 첫 상품명과 같은 열에서, 첫 상품 아래와 표 끝 사이에 지정해 주세요.",
      { exact: true },
    ),
  ).toBeVisible();
  const correct = await imagePoint(page, 0.16, 335 / 820);
  await page.mouse.click(correct.x, correct.y);
  await page.getByRole("button", { name: "영역 미리보기", exact: true }).click();
  await expect(
    page.getByText("상품 2개 · 수량 합계 0개 · 수량 미확인 2행", { exact: true }),
  ).toBeVisible();
});

test("region templates persist settings only, retain old storage, reuse then delete/reset", async ({
  page,
}) => {
  await page.evaluate(
    ({ key, mapping }) =>
      localStorage.setItem(
        key,
        JSON.stringify({
          schemaVersion: 1,
          templates: [
            {
              id: "old-column",
              name: "양식 1",
              mapping,
              layout: { roles: ["productName", "brand", "option", "quantity"] },
            },
          ],
        }),
      ),
    { key: TEMPLATE_KEY, mapping },
  );
  await setupRegionApi(page);
  await recognize(page);
  await configureRegions(page);
  await page.getByRole("button", { name: "현재 영역 양식 저장", exact: true }).click();
  const stored = await page.evaluate((key) => localStorage.getItem(key), TEMPLATE_KEY);
  expect(stored).not.toMatch(
    /sourceText|rawText|imageBase64|blob:|fileName|ocr_region|Synthetic|token|confidence/u,
  );
  const saved = JSON.parse(stored!);
  expect(saved.templates).toHaveLength(2);
  expect(saved.templates[0].mapping.schemaVersion).toBe(1);
  expect(saved.templates[1]).toMatchObject({
    name: "양식 2",
    mapping: { schemaVersion: 2, image: { width: 1600, height: 820 } },
  });
  await page.reload();
  await selectAdminTab(page, "입고 OCR");
  await recognize(page, "second.png");
  await page.getByRole("button", { name: "영역 양식 불러오기", exact: true }).click();
  const templates = page.getByRole("combobox", { name: "저장 영역 양식", exact: true });
  await expect(templates.locator("option")).toHaveText(["양식 선택", "양식 2"]);
  await templates.selectOption({ label: "양식 2" });
  await page.getByRole("button", { name: "영역 양식 재사용", exact: true }).click();
  await expect(
    page.getByRole("checkbox", {
      name: "선택한 수량 영역은 금액이 아닌 실제 수량입니다",
      exact: true,
    }),
  ).not.toBeChecked();
  await expect(
    page.getByRole("button", { name: "영역 미리보기", exact: true }),
  ).toBeDisabled();
  await page
    .getByRole("checkbox", {
      name: "선택한 수량 영역은 금액이 아닌 실제 수량입니다",
      exact: true,
    })
    .check();
  await page.getByRole("button", { name: "영역 미리보기", exact: true }).click();
  await expect(
    page.getByText("상품 2개 · 수량 합계 5개 · 수량 미확인 0행", { exact: true }),
  ).toBeVisible();
  await page.getByRole("button", { name: "선택 영역 양식 삭제", exact: true }).click();
  expect(
    JSON.parse((await page.evaluate((key) => localStorage.getItem(key), TEMPLATE_KEY))!)
      .templates,
  ).toHaveLength(1);
  page.once("dialog", (dialog) => dialog.accept());
  await page.getByRole("button", { name: "전체 양식 삭제", exact: true }).click();
  expect(
    await page.evaluate((key) => localStorage.getItem(key), TEMPLATE_KEY),
  ).toBeNull();
});

test("zoom and scroll preserve normalized rectangles and mobile width", async ({
  page,
}, testInfo) => {
  await page.setViewportSize({ width: 390, height: 900 });
  await setupRegionApi(page);
  await recognize(page);
  await page
    .getByRole("combobox", { name: "이미지 확대 배율", exact: true })
    .selectOption("2");
  await page.getByRole("button", { name: "이미지 이동", exact: true }).click();
  await expect(
    page.getByRole("group", { name: "이미지 영역 선택", exact: true }),
  ).toHaveCSS("touch-action", "auto");
  await configureRegions(page);
  await expect(
    page.getByRole("button", { name: "이미지 이동", exact: true }),
  ).toHaveAttribute("aria-pressed", "false");
  await page.getByRole("button", { name: "영역 미리보기", exact: true }).click();
  await expect(
    page.getByText("상품 2개 · 수량 합계 5개 · 수량 미확인 0행", { exact: true }),
  ).toBeVisible();
  const panel = page.getByRole("region", { name: "이미지에서 영역 지정", exact: true });
  const bounds = await panel.evaluate((node) => ({
    right: node.getBoundingClientRect().right,
    width: window.innerWidth,
  }));
  expect(bounds.right).toBeLessThanOrEqual(bounds.width);
  await panel.screenshot({ path: testInfo.outputPath("drag-mobile.png") });
});

test("touch cancel and a second finger cannot commit an unintended selection", async ({
  page,
}) => {
  await page.setViewportSize({ width: 390, height: 900 });
  await setupRegionApi(page);
  await recognize(page);
  const cdp = await page.context().newCDPSession(page);
  const point = await imagePoint(page, 0.1, 0.26);
  await cdp.send("Input.dispatchTouchEvent", {
    type: "touchStart",
    touchPoints: [{ x: point.x, y: point.y, id: 1 }],
  });
  await cdp.send("Input.dispatchTouchEvent", {
    type: "touchMove",
    touchPoints: [{ x: point.x + 40, y: point.y + 10, id: 1 }],
  });
  await cdp.send("Input.dispatchTouchEvent", { type: "touchCancel", touchPoints: [] });
  await expect(
    page.getByRole("button", { name: "상품명 영역", exact: true }),
  ).toContainText("선택 필요");
  await cdp.send("Input.dispatchTouchEvent", {
    type: "touchStart",
    touchPoints: [{ x: point.x, y: point.y, id: 1 }],
  });
  await cdp.send("Input.dispatchTouchEvent", {
    type: "touchStart",
    touchPoints: [
      { x: point.x, y: point.y, id: 1 },
      { x: point.x + 40, y: point.y + 10, id: 2 },
    ],
  });
  await cdp.send("Input.dispatchTouchEvent", { type: "touchEnd", touchPoints: [] });
  await expect(
    page.getByRole("button", { name: "상품명 영역", exact: true }),
  ).toContainText("선택 필요");
  await cdp.detach();
});

test("tiny or overlapping boxes are rejected and keyboard selection works", async ({
  page,
}) => {
  await setupRegionApi(page);
  await recognize(page);
  const point = await imagePoint(page, 0.1, 0.26);
  await page.mouse.click(point.x, point.y);
  await expect(
    page.getByText("글자를 포함하도록 영역을 조금 더 크게 드래그해 주세요.", {
      exact: true,
    }),
  ).toBeVisible();
  await dragRegion(page, "productName");
  await page.getByRole("button", { name: "브랜드 영역", exact: true }).click();
  const center = await imagePoint(page, 0.15, 0.26);
  await page.mouse.move(center.x, center.y);
  await page.mouse.down();
  await page.mouse.move(center.x + 30, center.y + 8);
  await page.mouse.up();
  await expect(
    page.getByText(
      "선택 영역이 다른 항목과 겹칩니다. 각각의 글자를 나누어 지정해 주세요.",
      { exact: true },
    ),
  ).toBeVisible();
  await page.getByRole("button", { name: "전체 영역 지우기", exact: true }).click();
  const surface = page.getByRole("group", { name: "이미지 영역 선택", exact: true });
  await surface.focus();
  await surface.press("Space");
  await surface.press("ArrowRight");
  await surface.press("ArrowDown");
  await surface.press("Enter");
  await expect(
    page.getByRole("button", { name: "상품명 영역", exact: true }),
  ).toContainText("지정됨");
});

test("old preview responses cannot populate a replacement file and object URLs are revoked", async ({
  page,
}) => {
  await page.evaluate(() => {
    const create = URL.createObjectURL.bind(URL),
      revoke = URL.revokeObjectURL.bind(URL);
    const tracker = { active: [] as string[], revoked: [] as string[] };
    Object.assign(window, { ocrUrls: tracker });
    URL.createObjectURL = (blob) => {
      const url = create(blob);
      tracker.active.push(url);
      return url;
    };
    URL.revokeObjectURL = (url) => {
      tracker.active = tracker.active.filter((value) => value !== url);
      tracker.revoked.push(url);
      revoke(url);
    };
  });
  await setupRegionApi(page);
  await recognize(page);
  await configureRegions(page);
  const pending = heldResponse();
  let previewPayload: unknown;
  await page.route(OCR_ROUTE, async (route) => {
    if (route.request().method() !== "PATCH") return route.fallback();
    const body = route.request().postDataJSON();
    const { rows, ...analysis } = parseOcrTableRows(regionTokens(), body.mapping);
    previewPayload = { preview: { jobId: "ocr_region", version: 1, rows, analysis } };
    return pending.handle(route);
  });
  await page.getByRole("button", { name: "영역 미리보기", exact: true }).click();
  await pending.started;
  await recognize(page, "newfile.png");
  const response = page.waitForResponse(
    (value) => value.request().method() === "PATCH",
  );
  pending.respond(previewPayload);
  await flushResponse(page, response);
  await expect(
    page.getByRole("region", { name: "영역 지정 미리보기 표", exact: true }),
  ).toHaveCount(0);
  await expect(
    page.getByRole("button", { name: "상품명 영역", exact: true }),
  ).toContainText("선택 필요");
  await selectAdminTab(page, /^홈/u);
  const tracking = await page.evaluate(
    () => Reflect.get(window, "ocrUrls") as { active: string[]; revoked: string[] },
  );
  expect(tracking.active).toHaveLength(0);
  expect(tracking.revoked.length).toBeGreaterThan(0);
});

test.beforeEach(async ({ page }) => {
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
});

test.afterEach(async ({ page }) => {
  // Every intentional write must have an explicit synthetic fixture above this
  // final deny rule. Even an aborted, unanticipated write fails the regression.
  expect(unexpectedWrites.get(page) ?? []).toEqual([]);
});

test("local OCR English safety keeps local-only memory and retry boundaries without contacting a relay", async ({
  page,
}) => {
  // Executed only by the approved temporary local-mode wrapper config. The
  // original OCR config remains pinned off; neither mode contacts port 8011.
  const relayRequests: string[] = [];
  page.on("request", (request) => {
    const url = new URL(request.url());
    if (["8010", "8011"].includes(url.port)) relayRequests.push(request.url());
  });
  await page.getByRole("button", { name: "영어", exact: true }).click();
  const note = page.getByRole("note", { name: "Local OCR test", exact: true });
  await expect(note).toContainText("this computer’s local relay");
  await expect(note).toContainText("this computer’s memory");
  await expect(note).toContainText("deleted when the server restarts");
  await expect(note).toContainText(
    "does not save products, inventory or AWS data, or publish products",
  );
  await expect(note).toContainText(
    "Separately confirming inventory application changes real product inventory",
  );
  await page
    .getByText("Processing route, limits and connection help", { exact: true })
    .click();
  const help = page.locator("details[open]").filter({
    has: page.getByText("Processing route, limits and connection help", {
      exact: true,
    }),
  });
  await expect(help).toContainText(
    "Images are sent only to this computer’s local relay and are not stored",
  );
  await expect(help).toContainText("PaddleOCR shared secret stays on the local server");
  await expect(help).toContainText("up to about 2 minutes");
  await expect(help).toContainText("times out or the connection fails");
  await expect(help).toContainText("before retrying");
  await expect(help).toContainText("4 MiB");
  await expect(
    page.getByRole("note", { name: "Temporary PC OCR test", exact: true }),
  ).toHaveCount(0);
  expect(relayRequests).toEqual([]);
});

test("remote OCR demo stays off on localhost despite query and stored overrides", async ({
  page,
}) => {
  await page.evaluate((origin) => {
    localStorage.setItem("paradays.ocr.demo.enabled", "true");
    localStorage.setItem("paradays.ocr.demo.api-url", origin);
    localStorage.setItem("paradays.ocr.demo.allowed-api-origin", origin);
  }, REMOTE_DEMO_API);
  await page.goto(
    `/admin?ocrDemo=true&ocrApiUrl=${encodeURIComponent(REMOTE_DEMO_API)}`,
  );
  await selectAdminTab(page, "입고 OCR");
  await expect(
    page.getByRole("note", { name: "PC OCR 임시 테스트", exact: true }),
  ).toHaveCount(0);
  let remoteRequests = 0;
  await page.route(REMOTE_DEMO_OCR_ROUTE, async (route) => {
    remoteRequests++;
    await route.abort();
  });
  await page.route(OCR_ROUTE, async (route) => json(route, { job: job() }, 201));
  await recognize(page);
  expect(remoteRequests).toBe(0);
});

test.describe("remote PC OCR demo fixture", () => {
  test.skip(
    !REMOTE_DEMO_E2E,
    "Requires the separate explicit demo-enabled build fixture, never a browser guard override.",
  );

  async function openRemoteFixture(page: Page) {
    // The browser sees the real allowed HTTPS origin; every byte still comes
    // from the fixed local test server. Never contact Firebase or a tunnel.
    await page.routeWebSocket("**/*", (socket) => {
      const url = new URL(socket.url());
      if (
        url.origin !== "wss://paradays.web.app" ||
        url.pathname !== "/_next/hmr" ||
        !url.searchParams.get("id") ||
        [...url.searchParams.keys()].some((key) => key !== "id")
      )
        return socket.close();
      // Next 16 dev hydration needs its React debug stream over HMR. Bridge
      // only this fixed loopback endpoint, never the requested external host.
      const upstream = new WebSocket(`ws://127.0.0.1:3137/_next/hmr${url.search}`);
      upstream.binaryType = "arraybuffer";
      const pending: Array<string | Buffer> = [];
      upstream.addEventListener("open", () => {
        for (const message of pending.splice(0)) upstream.send(message);
      });
      socket.onMessage((message) => {
        if (upstream.readyState === WebSocket.OPEN) upstream.send(message);
        else if (upstream.readyState === WebSocket.CONNECTING) pending.push(message);
      });
      upstream.addEventListener("message", (event) => {
        socket.send(
          event.data instanceof ArrayBuffer ? Buffer.from(event.data) : event.data,
        );
      });
      socket.onClose(() => upstream.close());
      upstream.addEventListener("close", () => void socket.close());
      upstream.addEventListener("error", () => void socket.close());
    });
    await page.route(`${FIREBASE_ORIGIN}/**`, async (route) => {
      const request = route.request(),
        url = new URL(request.url());
      if (url.origin !== FIREBASE_ORIGIN || request.method() !== "GET")
        return route.abort();
      const response = await page.request.get(
        `http://127.0.0.1:3137${url.pathname}${url.search}`,
        { maxRedirects: 0 },
      );
      if (response.status() >= 300 && response.status() < 400) return route.abort();
      // APIRequestContext decodes compressed bodies; transport headers must
      // not describe the already-decoded bytes fulfilled to the browser.
      const headers = Object.fromEntries(
        Object.entries(response.headers()).filter(
          ([name]) =>
            ![
              "content-encoding",
              "content-length",
              "transfer-encoding",
              "connection",
            ].includes(name.toLowerCase()),
        ),
      );
      await route.fulfill({
        status: response.status(),
        headers,
        body: await response.body(),
      });
    });
    await page.goto(`${FIREBASE_ORIGIN}/admin`);
    await selectAdminTab(page, "입고 OCR");
    await expect(
      page.getByRole("note", { name: "PC OCR 임시 테스트", exact: true }),
    ).toBeVisible();
  }

  test("notice names the operator PC and relay; only OCR POST PATCH GET use the demo", async ({
    page,
  }) => {
    const methods: string[] = [],
      requestedUrls: string[] = [];
    page.on("request", (request) => requestedUrls.push(request.url()));
    await page.route(REMOTE_DEMO_OCR_ROUTE, async (route) => {
      const method = route.request().method();
      if (method === "OPTIONS") return json(route, {});
      methods.push(method);
      expect(route.request().headers().authorization).toBe(`Bearer ${JWT}`);
      if (method === "POST") return json(route, { job: job() }, 201);
      if (method === "PATCH")
        return json(route, { code: "OCR_JOB_VERSION_CONFLICT" }, 409);
      return json(route, { job: job("ocr_job_A", "Remote canonical", 2) });
    });
    await openRemoteFixture(page);
    const note = page.getByRole("note", {
      name: "PC OCR 임시 테스트",
      exact: true,
    });
    await expect(note).toContainText("제3자 HTTPS 중계망");
    await expect(note).toContainText("PC 메모리에 임시 보관");
    await expect(note).toContainText("서버 재시작 시 삭제");
    await expect(note).toContainText("상품·재고·AWS에는 저장하지 않습니다");
    await expect(note).toContainText("별도로 확인한 입고 반영은 실제 재고를 변경");
    await page.getByText("처리 경로·용량·연결 안내", { exact: true }).click();
    const help = page
      .getByRole("region", { name: "원본 이미지", exact: true })
      .locator("details[open]");
    await expect(help).toContainText("이미지 파일을 저장하지 않습니다");
    await expect(help).toContainText("공유 비밀값은 운영자 PC에만");
    await expect(help).toContainText("admin 권한이 없으면 요청이 거부됩니다(403)");
    await expect(help).toContainText("최대 2분");
    await expect(help).toContainText("시간 초과·연결 오류");
    await expect(
      page.getByRole("note", { name: "로컬 OCR 테스트", exact: true }),
    ).toHaveCount(0);
    await expect(page.getByText(/현재 컴퓨터의 PaddleOCR/u)).toHaveCount(0);
    await page.getByRole("button", { name: "영어", exact: true }).click();
    const english = page.getByRole("note", {
      name: "Temporary PC OCR test",
      exact: true,
    });
    await expect(english).toContainText("third-party HTTPS relay to the operator’s PC");
    await expect(english).toContainText(
      "Check images for personal information before sending",
    );
    await expect(english).toContainText("only in the operator’s PC memory");
    await expect(english).toContainText("deleted when the server restarts");
    await expect(english).toContainText(
      "does not save products, inventory or AWS data, or publish products",
    );
    await expect(english).toContainText(
      "Separately confirming inventory application changes real product inventory",
    );
    await expect(help).toContainText("does not store image files");
    await expect(help).toContainText("shared secret stays only on the operator’s PC");
    await expect(help).toContainText(
      "signed authentication token lacks the admin group",
    );
    await expect(help).toContainText("rejected (403)");
    await expect(help).toContainText("up to about 2 minutes");
    await expect(help).toContainText("times out or the connection fails");
    await expect(help).toContainText("before retrying");
    await page.getByRole("button", { name: "KOR", exact: true }).click();
    await recognize(page, "Remote intake.png");
    await page.getByRole("button", { name: "검토본 저장", exact: true }).click();
    await expect(
      page.getByRole("textbox", { name: "상품명", exact: true }),
    ).toHaveValue("Remote canonical");
    expect(methods).toEqual(["POST", "PATCH", "GET"]);
    expect(
      requestedUrls.some((url) => url.startsWith(`${API}admin/catalog/products`)),
    ).toBe(true);
    expect(requestedUrls.some((url) => url.startsWith(`${API}admin/ocr/`))).toBe(false);
    const stored = await page.evaluate(() =>
      [localStorage, sessionStorage].flatMap((storage) =>
        Array.from(
          { length: storage.length },
          (_, index) => storage.getItem(storage.key(index)!) ?? "",
        ),
      ),
    );
    for (const value of stored) {
      expect(value).not.toContain("Remote canonical");
      expect(value).not.toContain("Remote intake.png");
      expect(value).not.toContain("data:image");
    }
  });

  test("signed admin access is required even with a test-restored UI session", async ({
    page,
  }) => {
    await page.route(REMOTE_DEMO_OCR_ROUTE, async (route) => {
      if (route.request().method() === "OPTIONS") return json(route, {});
      return json(
        route,
        { code: "ADMIN_ROLE_REQUIRED", detail: "mock-private-provider-detail" },
        403,
      );
    });
    await openRemoteFixture(page);
    await selectFile(page, "Denied.png");
    await page.getByRole("button", { name: "OCR로 텍스트 추출", exact: true }).click();
    await expect(page.getByRole("alert").filter({ hasText: "PC OCR" })).toContainText(
      "admin 그룹 권한",
    );
    await expect(page.getByText("mock-private-provider-detail")).toHaveCount(0);
    await expect(
      page.getByRole("textbox", { name: "상품명", exact: true }),
    ).toHaveCount(0);
  });

  test("saved remote review applies explicitly selected inventory only through Commerce", async ({
    page,
  }) => {
    const inventory = await setupInventoryCatalogApi(page);
    const reviewMethods = await setupInventoryReviewApi(page, REMOTE_DEMO_OCR_ROUTE);
    await openRemoteFixture(page);
    await saveInventoryReview(page);
    expect(reviewMethods).toEqual(["POST", "PATCH"]);
    expect(inventory.intakes).toHaveLength(0);
    await prepareInventoryApplication(page, ["inventory-product-1"]);
    await confirmInventoryApplication(page);
    await expect.poll(() => inventory.intakes.length).toBe(1);
    expect(inventory.intakes[0]).toEqual(
      expectedExistingIntake("inventory-product-1", 3, 4),
    );
    expect(reviewMethods).toEqual(["POST", "PATCH"]);
    expect(inventory.intakeUrls).toEqual([`${API}admin/catalog/products`]);
    await expect(inventoryApplicationPanel(page).getByRole("status")).toContainText(
      "입고 반영이 완료",
    );
  });

  test("offline PC or expired tunnel gives safe retry guidance", async ({ page }) => {
    await page.route(REMOTE_DEMO_OCR_ROUTE, (route) => route.abort("connectionfailed"));
    await openRemoteFixture(page);
    await selectFile(page, "Offline.png");
    await page.getByRole("button", { name: "OCR로 텍스트 추출", exact: true }).click();
    const notice = page.getByRole("alert").filter({ hasText: "PC OCR" });
    await expect(notice).toContainText("PC OCR 임시 연결에 접속하지 못했습니다");
    await expect(notice).toContainText("HTTPS 중계");
    await expect(notice).toContainText("다시 시도");
    await expect(
      page.getByRole("button", { name: "OCR로 텍스트 추출", exact: true }),
    ).toBeEnabled();
  });
});

test("recognition directly fills review rows; save preserves rawText and immutable confidence/box", async ({
  page,
}) => {
  let saved: Record<string, unknown> | undefined;
  await page.route(OCR_ROUTE, async (route) => {
    if (route.request().method() === "OPTIONS") return json(route, {});
    expect(route.request().headers().authorization).toBe(`Bearer ${JWT}`);
    if (route.request().method() === "POST") return json(route, { job: job() }, 201);
    saved = route.request().postDataJSON();
    return json(route, {
      job: {
        ...job("ocr_job_A", String(saved?.rawText), 2),
        rows: (saved?.rows as Record<string, unknown>[]).map((row) => ({
          ...row,
          confidence: job().rows[0].confidence,
          box: job().rows[0].box,
        })),
      },
    });
  });
  await recognize(page);
  await expect(page.getByText("OCR OUTPUT", { exact: true })).toHaveCount(0);
  await expect(
    page.getByRole("textbox", { name: "OCR 원문 텍스트", exact: true }),
  ).toHaveCount(0);
  await expect(
    page.getByRole("button", { name: "편집 행으로 변환", exact: true }),
  ).toHaveCount(0);
  await expect(page.locator("dd").filter({ hasText: /^94%$/u })).toBeVisible();
  await expect(
    page.getByText("10, 20 → 30, 20 → 30, 40 → 10, 40", { exact: true }),
  ).toBeVisible();
  await page
    .getByRole("textbox", { name: "OCR 원문 (수정 가능)", exact: true })
    .fill("Edited row source");
  await page
    .getByRole("textbox", { name: "상품명", exact: true })
    .fill("Reviewed product");
  await page.getByRole("button", { name: "검토본 저장", exact: true }).click();
  await expect(page.getByText(/서버 버전 2을 적용/)).toBeVisible();
  expect(saved?.rawText).toBe("Original A");
  expect(saved?.version).toBe(1);
  expect((saved?.rows as Record<string, unknown>[])[0]).toMatchObject({
    sourceText: "Edited row source",
    productName: "Reviewed product",
  });
  expect((saved?.rows as Record<string, unknown>[])[0]).not.toHaveProperty(
    "confidence",
  );
  expect((saved?.rows as Record<string, unknown>[])[0]).not.toHaveProperty("box");
  await expect(
    page.getByRole("textbox", { name: "OCR 원문 (수정 가능)", exact: true }),
  ).toHaveValue("Edited row source");
  await expect(page.locator("dd").filter({ hasText: /^94%$/u })).toBeVisible();
});

test("structured canonical products fill every editable column immediately", async ({
  page,
}) => {
  const result = job();
  result.rawText = "입고표\n상품명\n브랜드\n옵션\n수량\nTest board\nExample\nLarge\n7";
  result.rows[0] = {
    ...result.rows[0],
    sourceText: "Test board | Example | Large | 7",
    productName: "Test board",
    brand: "Example",
    option: "Large",
    quantity: "7",
  };
  await page.route(OCR_ROUTE, async (route) => json(route, { job: result }, 201));
  await recognize(page);
  await expect(page.getByRole("textbox", { name: "상품명", exact: true })).toHaveValue(
    "Test board",
  );
  await expect(page.getByRole("textbox", { name: "브랜드", exact: true })).toHaveValue(
    "Example",
  );
  await expect(page.getByRole("textbox", { name: "옵션", exact: true })).toHaveValue(
    "Large",
  );
  await expect(page.getByRole("textbox", { name: "수량", exact: true })).toHaveValue(
    "7",
  );
  await expect(
    page.getByText("1개 상품 행을 인식했습니다.", { exact: false }),
  ).toBeVisible();
});

test("uncertain table structure explicitly retains unclassified source rows", async ({
  page,
}) => {
  const result = job();
  result.analysis = { mode: "unclassified", reason: "header-not-found" };
  result.rows[0] = {
    ...result.rows[0],
    productName: "",
    brand: "",
    option: "",
    quantity: "",
  };
  await page.route(OCR_ROUTE, async (route) => json(route, { job: result }, 201));
  await recognize(page);
  await expect(page.getByRole("tabpanel").getByRole("alert")).toContainText(
    "미분류 원문 1개를 그대로 표시",
  );
  await expect(
    page.getByRole("textbox", { name: "OCR 원문 (수정 가능)", exact: true }),
  ).toHaveValue("Original A");
  await expect(page.getByRole("textbox", { name: "상품명", exact: true })).toHaveValue(
    "",
  );
  await expect(page.getByRole("textbox", { name: "수량", exact: true })).toHaveValue(
    "",
  );
});

test("multiple provider rows appear automatically beside the image on desktop and reflow on mobile", async ({
  page,
}) => {
  const result = job();
  result.rows.push({
    ...result.rows[0],
    id: "ocr_2",
    sourceText: "Second product",
    productName: "Second product",
  });
  await page.route(OCR_ROUTE, async (route) => json(route, { job: result }, 201));
  await recognize(page);
  await expect(page.getByRole("textbox", { name: "상품명", exact: true })).toHaveCount(
    2,
  );
  await expect(
    page.getByRole("textbox", { name: "상품명", exact: true }).nth(1),
  ).toHaveValue("Second product");
  const panel = page.getByRole("region", { name: "인식 결과", exact: true });
  const source = page.getByRole("region", { name: "원본 이미지", exact: true });
  for (const width of [1440, 390]) {
    await page.setViewportSize({ width, height: 900 });
    const reviewBox = await panel.boundingBox();
    const imageBox = await source.boundingBox();
    expect(reviewBox).not.toBeNull();
    expect(imageBox).not.toBeNull();
    if (width === 1440) {
      expect(imageBox!.x + imageBox!.width).toBeLessThanOrEqual(reviewBox!.x);
      expect(Math.abs(imageBox!.y - reviewBox!.y)).toBeLessThan(2);
    } else {
      expect(imageBox!.y + imageBox!.height).toBeLessThanOrEqual(reviewBox!.y);
      expect(Math.abs(imageBox!.width - reviewBox!.width)).toBeLessThan(2);
    }
    expect(
      await page.evaluate(() => document.documentElement.scrollWidth),
    ).toBeLessThanOrEqual(width);
  }
});

test("empty recognition allows manual review rows but cannot save an empty review", async ({
  page,
}) => {
  await expect(
    page.getByRole("button", { name: "검토본 저장", exact: true }),
  ).toBeDisabled();
  await page.route(OCR_ROUTE, async (route) =>
    json(route, { job: { ...job(), rawText: "", rows: [] } }, 201),
  );
  await selectFile(page, "Empty.png");
  await page.getByRole("button", { name: "OCR로 텍스트 추출", exact: true }).click();
  await expect(
    page.getByText("인식된 텍스트가 없습니다.", { exact: false }),
  ).toBeVisible();
  await expect(
    page.getByRole("button", { name: "검토본 저장", exact: true }),
  ).toBeDisabled();
  await page.getByRole("button", { name: "행 추가", exact: true }).click();
  await page
    .getByRole("textbox", { name: "상품명", exact: true })
    .fill("Manual product");
  await expect(
    page.getByRole("button", { name: "검토본 저장", exact: true }),
  ).toBeEnabled();
});

test("older recognition cannot overwrite a newer file/job when responses finish in reverse order", async ({
  page,
}) => {
  const first = heldResponse();
  await page.route(OCR_ROUTE, async (route) => {
    if (route.request().method() === "OPTIONS") return json(route, {});
    if (route.request().postDataJSON().fileName === "A.png") return first.handle(route);
    return json(route, { job: job("ocr_job_B", "Newest B") }, 201);
  });
  await selectFile(page, "A.png");
  await page.getByRole("button", { name: "OCR로 텍스트 추출", exact: true }).click();
  await first.started;
  await recognize(page, "B.png");
  await expect(
    page.getByRole("textbox", { name: "OCR 원문 (수정 가능)", exact: true }),
  ).toHaveValue("Newest B");
  const response = page.waitForResponse(
    (r) =>
      r.request().method() === "POST" &&
      r.request().postDataJSON().fileName === "A.png",
  );
  first.respond({ job: job("ocr_job_A", "Obsolete A") }, 201);
  await flushResponse(page, response);
  await expect(
    page.getByRole("textbox", { name: "OCR 원문 (수정 가능)", exact: true }),
  ).toHaveValue("Newest B");
});

test("obsolete recognition error cannot replace the newer file's successful review", async ({
  page,
}) => {
  const first = heldResponse();
  await page.route(OCR_ROUTE, async (route) => {
    if (route.request().method() === "OPTIONS") return json(route, {});
    if (route.request().postDataJSON().fileName === "A.png") return first.handle(route);
    return json(route, { job: job("ocr_job_B", "Newest B") }, 201);
  });
  await selectFile(page, "A.png");
  await page.getByRole("button", { name: "OCR로 텍스트 추출", exact: true }).click();
  await first.started;
  await recognize(page, "B.png");
  const response = page.waitForResponse(
    (r) =>
      r.request().method() === "POST" &&
      r.request().postDataJSON().fileName === "A.png",
  );
  first.respond({ code: "OCR_PROVIDER_REQUEST_FAILED" }, 502);
  await flushResponse(page, response);
  await expect(
    page.getByRole("textbox", { name: "OCR 원문 (수정 가능)", exact: true }),
  ).toHaveValue("Newest B");
  await expect(
    page.getByRole("button", { name: "검토본 저장", exact: true }),
  ).toBeEnabled();
  await expect(page.getByText(/PaddleOCR 서비스 호출에 실패/)).toHaveCount(0);
});

test("older save and its finally cannot overwrite a new job or clear its pending save", async ({
  page,
}) => {
  const saveA = heldResponse();
  const saveB = heldResponse();
  await page.route(OCR_ROUTE, async (route) => {
    if (route.request().method() === "OPTIONS") return json(route, {});
    if (route.request().method() === "POST") {
      const isB = route.request().postDataJSON().fileName === "B.png";
      return json(
        route,
        { job: job(isB ? "ocr_job_B" : "ocr_job_A", isB ? "Newest B" : "Original A") },
        201,
      );
    }
    return route.request().url().endsWith("ocr_job_A")
      ? saveA.handle(route)
      : saveB.handle(route);
  });
  await recognize(page);
  await page.getByRole("button", { name: "검토본 저장", exact: true }).click();
  await saveA.started;
  await recognize(page, "B.png");
  await page.getByRole("button", { name: "검토본 저장", exact: true }).click();
  await saveB.started;
  const response = page.waitForResponse(
    (r) => r.request().method() === "PATCH" && r.url().endsWith("ocr_job_A"),
  );
  saveA.respond({ job: job("ocr_job_A", "Obsolete save A", 2) });
  await flushResponse(page, response);
  await expect(
    page.getByRole("textbox", { name: "OCR 원문 (수정 가능)", exact: true }),
  ).toHaveValue("Newest B");
  await expect(
    page.getByRole("button", { name: "처리 중…", exact: true }),
  ).toBeDisabled();
  saveB.respond({ job: job("ocr_job_B", "Newest B", 2) });
  await expect(
    page.getByRole("button", { name: "검토본 저장", exact: true }),
  ).toBeEnabled();
});

test("editing the current draft while PATCH is pending prevents canonical response overwrite", async ({
  page,
}) => {
  const save = heldResponse();
  await page.route(OCR_ROUTE, async (route) => {
    if (route.request().method() === "OPTIONS") return json(route, {});
    if (route.request().method() === "POST") return json(route, { job: job() }, 201);
    return save.handle(route);
  });
  await recognize(page);
  await page.getByRole("button", { name: "검토본 저장", exact: true }).click();
  await save.started;
  await page
    .getByRole("textbox", { name: "OCR 원문 (수정 가능)", exact: true })
    .fill("New unsaved draft");
  await page
    .getByRole("textbox", { name: "상품명", exact: true })
    .fill("New unsaved product");
  const response = page.waitForResponse((r) => r.request().method() === "PATCH");
  save.respond({ job: job("ocr_job_A", "Old saved content", 2) });
  await flushResponse(page, response);
  await expect(
    page.getByRole("textbox", { name: "OCR 원문 (수정 가능)", exact: true }),
  ).toHaveValue("New unsaved draft");
  await expect(page.getByRole("textbox", { name: "상품명", exact: true })).toHaveValue(
    "New unsaved product",
  );
  await expect(
    page.getByRole("button", { name: "검토본 저장", exact: true }),
  ).toBeEnabled();
});

test("stale conflict GET cannot overwrite an edit made after the PATCH response", async ({
  page,
}) => {
  const latest = heldResponse();
  await page.route(OCR_ROUTE, async (route) => {
    const method = route.request().method();
    if (method === "OPTIONS") return json(route, {});
    if (method === "POST") return json(route, { job: job() }, 201);
    if (method === "PATCH")
      return json(route, { code: "OCR_JOB_VERSION_CONFLICT" }, 409);
    return latest.handle(route);
  });
  await recognize(page);
  await page.getByRole("button", { name: "검토본 저장", exact: true }).click();
  await latest.started;
  await page
    .getByRole("textbox", { name: "OCR 원문 (수정 가능)", exact: true })
    .fill("Newest local draft");
  const response = page.waitForResponse(
    (r) => r.request().method() === "GET" && r.url().includes("/ocr/jobs/"),
  );
  latest.respond({ job: job("ocr_job_A", "Obsolete conflict snapshot", 5) });
  await flushResponse(page, response);
  await expect(
    page.getByRole("textbox", { name: "OCR 원문 (수정 가능)", exact: true }),
  ).toHaveValue("Newest local draft");
  await expect(page.getByText(/다른 관리자의 수정이 먼저 저장/)).toHaveCount(0);
});

test("current conflict still loads latest canonical job/version and next save uses that version", async ({
  page,
}) => {
  let patches = 0;
  await page.route(OCR_ROUTE, async (route) => {
    const method = route.request().method();
    if (method === "OPTIONS") return json(route, {});
    if (method === "POST") return json(route, { job: job() }, 201);
    if (method === "GET")
      return json(route, { job: job("ocr_job_A", "Latest server text", 5) });
    patches += 1;
    if (patches === 1) return json(route, { code: "OCR_JOB_VERSION_CONFLICT" }, 409);
    expect(route.request().postDataJSON().version).toBe(5);
    return json(route, { job: job("ocr_job_A", "Latest server text", 6) });
  });
  await recognize(page);
  await page.getByRole("button", { name: "검토본 저장", exact: true }).click();
  await expect(page.getByText(/다른 관리자의 수정이 먼저 저장/)).toBeVisible();
  await expect(
    page.getByRole("textbox", { name: "OCR 원문 (수정 가능)", exact: true }),
  ).toHaveValue("Latest server text");
  await page.getByRole("button", { name: "검토본 저장", exact: true }).click();
  await expect(page.getByText(/서버 버전 6을 적용/)).toBeVisible();
});

test("same-job draft edit permits a new save while obsolete finally cannot clear its busy state", async ({
  page,
}) => {
  const first = heldResponse();
  const second = heldResponse();
  let patches = 0;
  await page.route(OCR_ROUTE, async (route) => {
    if (route.request().method() === "OPTIONS") return json(route, {});
    if (route.request().method() === "POST") return json(route, { job: job() }, 201);
    patches += 1;
    return patches === 1 ? first.handle(route) : second.handle(route);
  });
  await recognize(page);
  await page.getByRole("button", { name: "검토본 저장", exact: true }).click();
  await first.started;
  await page
    .getByRole("textbox", { name: "OCR 원문 (수정 가능)", exact: true })
    .fill("New draft to save");
  await expect(
    page.getByRole("button", { name: "검토본 저장", exact: true }),
  ).toBeEnabled();
  await page.getByRole("button", { name: "검토본 저장", exact: true }).click();
  await second.started;
  const response = page.waitForResponse(
    (r) =>
      r.request().method() === "PATCH" &&
      r.request().postDataJSON().rows[0].sourceText === "Original A",
  );
  first.respond({ job: job("ocr_job_A", "Old response", 2) });
  await flushResponse(page, response);
  await expect(
    page.getByRole("textbox", { name: "OCR 원문 (수정 가능)", exact: true }),
  ).toHaveValue("New draft to save");
  await expect(
    page.getByRole("button", { name: "처리 중…", exact: true }),
  ).toBeDisabled();
  second.respond({ job: job("ocr_job_A", "New draft to save", 2) });
  await expect(
    page.getByRole("button", { name: "검토본 저장", exact: true }),
  ).toBeEnabled();
  await expect(page.getByText(/서버 버전 2을 적용/)).toBeVisible();
});

test("adding/editing a review row during recognition invalidates response and releases recognize state", async ({
  page,
}) => {
  const pending = heldResponse();
  await page.route(OCR_ROUTE, async (route) => {
    if (route.request().method() === "OPTIONS") return json(route, {});
    return pending.handle(route);
  });
  await selectFile(page, "A.png");
  await page.getByRole("button", { name: "OCR로 텍스트 추출", exact: true }).click();
  await pending.started;
  await page.getByRole("button", { name: "행 추가", exact: true }).click();
  await openRowDetails(page);
  await page
    .getByRole("textbox", { name: "OCR 원문 (수정 가능)", exact: true })
    .fill("Local manual draft");
  await page
    .getByRole("textbox", { name: "상품명", exact: true })
    .fill("Local manual draft");
  await expect(
    page.getByRole("button", { name: "OCR로 텍스트 추출", exact: true }),
  ).toBeEnabled();
  const response = page.waitForResponse(
    (r) => r.request().method() === "POST" && r.url().includes("/ocr/jobs"),
  );
  pending.respond({ job: job("ocr_job_A", "Obsolete recognition") }, 201);
  await flushResponse(page, response);
  await expect(
    page.getByRole("textbox", { name: "OCR 원문 (수정 가능)", exact: true }),
  ).toHaveValue("Local manual draft");
  await expect(page.getByRole("textbox", { name: "상품명", exact: true })).toHaveValue(
    "Local manual draft",
  );
  await expect(
    page.getByRole("button", { name: "검토본 저장", exact: true }),
  ).toBeDisabled();
});

type InventoryCatalogFixture = {
  productId: string;
  name: string;
  brandName: string;
  category: string;
  price: number;
  inventoryQuantity: number;
  status: "PUBLISHED" | "DRAFT";
  featured: boolean;
  version: number;
  description: string[];
  sizes: string[];
  sku?: string;
};

function inventoryCatalogProduct(index = 1): InventoryCatalogFixture {
  return {
    productId: `inventory-product-${index}`,
    name: `Inventory deck ${index}`,
    brandName: "Test Maker",
    category: "Deck",
    price: 100000,
    inventoryQuantity: index === 1 ? 5 : index * 10,
    status: "PUBLISHED",
    featured: false,
    version: index + 2,
    description: ["Synthetic inventory fixture"],
    sizes: ["8.25"],
    sku: `TEST-INVENTORY-${index}`,
  };
}

function inventoryReviewRow(index = 1, quantity = "4") {
  return {
    ...job().rows[0],
    id: `inventory-row-${index}`,
    sourceText: `Synthetic intake line ${index}`,
    productName: `Inventory deck ${index}`,
    brand: "Test Maker",
    option: "8.25",
    quantity,
  };
}

async function setupInventoryCatalogApi(
  page: Page,
  products = [inventoryCatalogProduct()],
  failure?: { id: string; kind: "conflict" | "response-lost" | "duplicate" },
) {
  const state = {
    products,
    gets: 0,
    intakes: [] as Array<AdminOcrIntakeInput & { action: "ocr-intake" }>,
    intakeUrls: [] as string[],
  };
  await page.route(`${API}admin/catalog/products**`, async (route) => {
    const request = route.request();
    if (request.method() === "OPTIONS") return json(route, {});
    expect(request.headers().authorization).toBe(`Bearer ${JWT}`);
    const url = new URL(request.url());
    if (request.method() === "GET" && url.pathname.endsWith("/products")) {
      state.gets += 1;
      return json(route, { products: state.products });
    }
    if (request.method() !== "POST" || !url.pathname.endsWith("/products"))
      throw new Error(
        `Unexpected catalog mutation: ${request.method()} ${url.pathname}`,
      );
    const body = request.postDataJSON() as AdminOcrIntakeInput & {
      action: "ocr-intake";
    };
    expect(body.action).toBe("ocr-intake");
    expect(body.operationId).toMatch(/^[A-Za-z0-9._-]+$/u);
    expect(Number.isSafeInteger(body.quantity)).toBe(true);
    expect(body.quantity).toBeGreaterThan(0);
    expect(body.source.jobId).toBe("ocr_inventory");
    expect(body.source.rowIds.length).toBeGreaterThan(0);
    expect(new Set(body.source.rowIds).size).toBe(body.source.rowIds.length);
    for (const rowId of body.source.rowIds)
      expect(rowId).toMatch(/^inventory-row-[1-3]$/u);
    state.intakes.push(body);
    state.intakeUrls.push(request.url());
    const id =
      body.kind === "existing" ? body.existing.productId : "inventory-new-product";
    if (failure?.id === id && failure.kind === "conflict")
      return json(route, { code: "PRODUCT_VERSION_CONFLICT" }, 409);
    if (failure?.id === id && failure.kind === "duplicate")
      return json(route, { code: "OCR_INTAKE_DUPLICATE_PRODUCT" }, 409);
    let product: InventoryCatalogFixture;
    let beforeStock = 0;
    if (body.kind === "existing") {
      const existing = state.products.find((item) => item.productId === id);
      if (!existing) return json(route, {}, 404);
      expect(body.existing.version).toBe(existing.version);
      beforeStock = existing.inventoryQuantity;
      existing.inventoryQuantity += body.quantity;
      existing.version += 1;
      product = existing;
    } else {
      product = {
        ...inventoryCatalogProduct(),
        productId: id,
        ...body.product,
        inventoryQuantity: body.quantity,
        status: "DRAFT",
        version: 1,
        sizes: body.product.option ? [body.product.option] : [],
        sku: body.product.sku,
      };
      state.products.push(product);
    }
    // Model a committed write whose response was lost. It must not be retried
    // with a rebased stock increment or followed by the next product's POST.
    if (failure?.id === id && failure.kind === "response-lost")
      return route.abort("connectionfailed");
    return json(route, intakeResponse(body, product, beforeStock));
  });
  return state;
}

function intakeResponse(
  input: AdminOcrIntakeInput,
  product: InventoryCatalogFixture,
  beforeStock: number,
) {
  return {
    product,
    receipt: {
      operationId: input.operationId,
      kind: input.kind,
      quantity: input.quantity,
      beforeStock,
      afterStock: product.inventoryQuantity,
      replayed: false,
    },
  };
}

function expectedExistingIntake(
  productId: string,
  version: number,
  quantity: number,
  rowIds = ["inventory-row-1"],
) {
  return {
    action: "ocr-intake",
    operationId: expect.any(String),
    kind: "existing",
    quantity,
    source: { jobId: "ocr_inventory", rowIds },
    existing: { productId, version },
  };
}

function isIntakeRequest(request: import("@playwright/test").Request) {
  return (
    request.method() === "POST" && request.url() === `${API}admin/catalog/products`
  );
}

async function setupInventoryReviewApi(
  page: Page,
  routePattern = OCR_ROUTE,
  rows = [inventoryReviewRow()],
) {
  const methods: string[] = [];
  let current = { ...job("ocr_inventory", "Synthetic inventory intake"), rows };
  await page.route(routePattern, async (route) => {
    const request = route.request();
    if (request.method() === "OPTIONS") return json(route, {});
    expect(request.headers().authorization).toBe(`Bearer ${JWT}`);
    methods.push(request.method());
    if (request.method() === "POST") return json(route, { job: current }, 201);
    if (request.method() === "GET") return json(route, { job: current });
    const body = request.postDataJSON();
    expect(body.version).toBe(current.version);
    current = {
      ...current,
      version: current.version + 1,
      rawText: body.rawText ?? current.rawText,
      rows: body.rows.map((row: ReturnType<typeof inventoryReviewRow>) => ({
        ...row,
        confidence:
          current.rows.find((item) => item.id === row.id)?.confidence ??
          job().rows[0].confidence,
        box: current.rows.find((item) => item.id === row.id)?.box ?? job().rows[0].box,
      })),
    };
    return json(route, { job: current });
  });
  return methods;
}

function inventoryApplicationPanel(page: Page) {
  return page.getByRole("region", { name: "재고 반영", exact: true });
}

async function saveInventoryReview(page: Page) {
  await recognize(page, "Synthetic inventory.png");
  await page.getByRole("button", { name: "검토본 저장", exact: true }).click();
  await expect(
    page.getByRole("heading", { name: "재고 반영", exact: true }),
  ).toBeVisible();
}

async function prepareInventoryApplication(page: Page, productIds: string[]) {
  const panel = inventoryApplicationPanel(page);
  await panel.getByRole("button", { name: "재고 상품 불러오기", exact: true }).click();
  for (const [index, id] of productIds.entries()) {
    await panel
      .getByRole("combobox", { name: `재고 상품 선택 ${index + 1}`, exact: true })
      .selectOption(id);
    await panel
      .getByRole("checkbox", {
        name: `입고 행 ${index + 1} 내용을 확인했습니다`,
        exact: true,
      })
      .check();
  }
  await panel.getByRole("button", { name: "재고 반영 미리보기", exact: true }).click();
  await expect(
    panel.getByRole("checkbox", {
      name: "실제 상품 등록·재고 변경 내용을 확인했습니다",
      exact: true,
    }),
  ).toBeEnabled();
}

async function confirmInventoryApplication(page: Page) {
  const panel = inventoryApplicationPanel(page);
  await panel
    .getByRole("checkbox", {
      name: "실제 상품 등록·재고 변경 내용을 확인했습니다",
      exact: true,
    })
    .check();
  await panel.getByRole("button", { name: "확인한 입고 반영", exact: true }).click();
}

async function chooseNewInventoryProduct(
  page: Page,
  row = 1,
  price = "89000",
  category = "Deck",
) {
  const panel = inventoryApplicationPanel(page);
  await panel
    .getByRole("combobox", { name: `입고 방식 ${row}`, exact: true })
    .selectOption("new");
  await panel.getByLabel(`신규 가격 ${row}`, { exact: true }).fill(price);
  await panel
    .getByRole("combobox", { name: `신규 카테고리 ${row}`, exact: true })
    .selectOption(category);
}

async function confirmInventoryRow(page: Page, row: number) {
  await inventoryApplicationPanel(page)
    .getByRole("checkbox", {
      name: `입고 행 ${row} 내용을 확인했습니다`,
      exact: true,
    })
    .check();
}

async function previewInventoryApplication(page: Page) {
  await inventoryApplicationPanel(page)
    .getByRole("button", {
      name: "재고 반영 미리보기",
      exact: true,
    })
    .click();
}

async function openInventorySection(page: Page, label: "재고 수정" | "입고 OCR") {
  await selectAdminTab(page, label);
}

async function expectInventoryStock(
  page: Page,
  quantity: number,
  name = "Inventory deck 1",
) {
  await expect(
    page
      .getByRole("button", { name: `${name} 재고 조정`, exact: true })
      .getByText(`${quantity}개`, { exact: true }),
  ).toBeVisible();
}

test.describe("OCR inventory application", () => {
  test("a new product requires price and category and is created as a private draft with intake stock", async ({
    page,
  }) => {
    const inventory = await setupInventoryCatalogApi(page, []);
    const rows = [{ ...inventoryReviewRow(), productName: "New synthetic deck" }];
    const methods = await setupInventoryReviewApi(page, OCR_ROUTE, rows);
    await saveInventoryReview(page);
    const panel = inventoryApplicationPanel(page);
    await panel
      .getByRole("button", { name: "재고 상품 불러오기", exact: true })
      .click();
    await expect(panel).toContainText("일치 후보 없음 · 신규 입력 가능");
    await panel
      .getByRole("combobox", { name: "입고 방식 1", exact: true })
      .selectOption("new");
    await expect(panel.getByLabel("신규 가격 1", { exact: true })).toHaveValue("");
    await expect(
      panel.getByRole("combobox", { name: "신규 카테고리 1", exact: true }),
    ).toHaveValue("");
    const rowConfirmation = panel.getByRole("checkbox", {
      name: "입고 행 1 내용을 확인했습니다",
      exact: true,
    });
    await expect(rowConfirmation).toBeDisabled();
    await panel.getByLabel("신규 가격 1", { exact: true }).fill("89000");
    await expect(rowConfirmation).toBeDisabled();
    await panel
      .getByRole("combobox", { name: "신규 카테고리 1", exact: true })
      .selectOption("Deck");
    await confirmInventoryRow(page, 1);
    await previewInventoryApplication(page);
    await expect(panel).toContainText("신규 · 비공개 초안");
    await expect(panel).toContainText("89,000");
    expect(inventory.intakes).toHaveLength(0);
    // Editing even a valid price invalidates both row confirmation and the preview.
    await panel.getByLabel("신규 가격 1", { exact: true }).fill("90000");
    await expect(rowConfirmation).not.toBeChecked();
    await expect(
      panel.getByRole("button", { name: "확인한 입고 반영", exact: true }),
    ).toHaveCount(0);
    await confirmInventoryRow(page, 1);
    await previewInventoryApplication(page);
    await confirmInventoryApplication(page);
    await expect(panel.getByRole("status")).toContainText("입고 반영이 완료");
    expect(inventory.intakes).toEqual([
      {
        action: "ocr-intake",
        operationId: expect.any(String),
        kind: "new",
        quantity: 4,
        source: { jobId: "ocr_inventory", rowIds: ["inventory-row-1"] },
        product: {
          name: "New synthetic deck",
          brandName: "Test Maker",
          option: "8.25",
          price: 90000,
          category: "Deck",
        },
      },
    ]);
    expect(inventory.products[0]).toMatchObject({
      status: "DRAFT",
      version: 1,
      inventoryQuantity: 4,
      price: 90000,
      category: "Deck",
      sizes: ["8.25"],
    });
    expect(methods).toEqual(["POST", "PATCH"]);
    await expect(
      page.getByRole("textbox", { name: "OCR 원문 (수정 가능)", exact: true }).first(),
    ).toHaveValue(rows[0].sourceText);
    expect(JSON.stringify(inventory.intakes)).not.toMatch(
      /rawText|sourceText|confidence|"box"/u,
    );
  });

  test("ambiguous normalized composite candidates are never auto-selected or newly duplicated", async ({
    page,
  }) => {
    const first = inventoryCatalogProduct(1);
    const second = { ...inventoryCatalogProduct(2), name: first.name };
    const inventory = await setupInventoryCatalogApi(page, [first, second]);
    await setupInventoryReviewApi(page, OCR_ROUTE, [
      {
        ...inventoryReviewRow(),
        productName: "  INVENTORY   deck 1  ",
        brand: " test MAKER ",
        option: " 8.25 ",
      },
    ]);
    await saveInventoryReview(page);
    const panel = inventoryApplicationPanel(page);
    await panel
      .getByRole("button", { name: "재고 상품 불러오기", exact: true })
      .click();
    await expect(panel).toContainText("이름·브랜드·옵션 일치 후보 2개");
    await expect(
      panel.getByRole("combobox", { name: "재고 상품 선택 1", exact: true }),
    ).toHaveValue("");
    await expect(
      panel.getByRole("checkbox", {
        name: "입고 행 1 내용을 확인했습니다",
        exact: true,
      }),
    ).toBeDisabled();
    await chooseNewInventoryProduct(page);
    await expect(panel).toContainText(
      "기존 상품 또는 중복 후보가 있어 신규 등록할 수 없습니다",
    );
    await expect(
      panel.getByRole("checkbox", {
        name: "입고 행 1 내용을 확인했습니다",
        exact: true,
      }),
    ).toBeDisabled();
    expect(inventory.intakes).toHaveLength(0);
    await panel
      .getByRole("combobox", { name: "입고 방식 1", exact: true })
      .selectOption("existing");
    await panel
      .getByRole("combobox", { name: "재고 상품 선택 1", exact: true })
      .selectOption(second.productId);
    await confirmInventoryRow(page, 1);
    await previewInventoryApplication(page);
    await confirmInventoryApplication(page);
    await expect.poll(() => inventory.intakes.length).toBe(1);
    expect(inventory.intakes[0]).toEqual(
      expectedExistingIntake(second.productId, 4, 4),
    );
    expect(first.inventoryQuantity).toBe(5);
    expect(second.inventoryQuantity).toBe(24);
  });

  test("exact ID and SKU only suggest candidates and similar names never become automatic matches", async ({
    page,
  }) => {
    const inventory = await setupInventoryCatalogApi(page);
    await setupInventoryReviewApi(page, OCR_ROUTE, [
      { ...inventoryReviewRow(), productName: "Inventory deck 1!" },
    ]);
    await saveInventoryReview(page);
    const panel = inventoryApplicationPanel(page);
    await panel
      .getByRole("button", { name: "재고 상품 불러오기", exact: true })
      .click();
    await expect(panel).toContainText("일치 후보 없음 · 신규 입력 가능");
    await panel.getByLabel("정확한 SKU 1", { exact: true }).fill("TEST-INVENTORY-1");
    await expect(panel).toContainText("정확한 SKU 후보 1개");
    await expect(
      panel.getByRole("combobox", { name: "재고 상품 선택 1", exact: true }),
    ).toHaveValue("");
    await panel
      .getByLabel("정확한 상품 ID 1", { exact: true })
      .fill("inventory-product-missing");
    await expect(panel).toContainText("해당 상품 ID를 찾지 못했습니다");
    await chooseNewInventoryProduct(page);
    await expect(
      panel.getByRole("checkbox", {
        name: "입고 행 1 내용을 확인했습니다",
        exact: true,
      }),
    ).toBeDisabled();
    expect(inventory.intakes).toHaveLength(0);
  });

  test("invalid price and unsupported category cannot confirm or write a new product", async ({
    page,
  }) => {
    const inventory = await setupInventoryCatalogApi(page, []);
    await setupInventoryReviewApi(page, OCR_ROUTE, [
      { ...inventoryReviewRow(), productName: "Invalid price fixture" },
    ]);
    await saveInventoryReview(page);
    const panel = inventoryApplicationPanel(page);
    await panel
      .getByRole("button", { name: "재고 상품 불러오기", exact: true })
      .click();
    await chooseNewInventoryProduct(page);
    const confirmation = panel.getByRole("checkbox", {
      name: "입고 행 1 내용을 확인했습니다",
      exact: true,
    });
    for (const price of ["", "-1", "1.5", "NaN", "100000001"]) {
      await panel.getByLabel("신규 가격 1", { exact: true }).fill(price);
      await expect(confirmation).toBeDisabled();
      expect(inventory.intakes).toHaveLength(0);
    }
    await panel.getByLabel("신규 가격 1", { exact: true }).fill("0");
    await expect(confirmation).toBeEnabled();
    const category = panel.getByRole("combobox", {
      name: "신규 카테고리 1",
      exact: true,
    });
    await expect(category.locator('option[value="Unapproved"]')).toHaveCount(0);
    await category.selectOption("");
    await expect(confirmation).toBeDisabled();
    expect(inventory.intakes).toHaveLength(0);
  });

  for (const quantity of ["", "0", "1000001"]) {
    test(`saved review quantity ${JSON.stringify(quantity)} cannot produce an intake write`, async ({
      page,
    }) => {
      const inventory = await setupInventoryCatalogApi(page);
      await setupInventoryReviewApi(page, OCR_ROUTE, [inventoryReviewRow(1, quantity)]);
      await saveInventoryReview(page);
      const panel = inventoryApplicationPanel(page);
      await panel
        .getByRole("button", { name: "재고 상품 불러오기", exact: true })
        .click();
      await panel
        .getByRole("combobox", { name: "재고 상품 선택 1", exact: true })
        .selectOption("inventory-product-1");
      await previewInventoryApplication(page);
      await expect(panel.getByRole("alert")).toContainText(
        "입고 수량은 1~1,000,000 정수",
      );
      await expect(
        panel.getByRole("button", { name: "확인한 입고 반영", exact: true }),
      ).toHaveCount(0);
      expect(inventory.intakes).toHaveLength(0);
    });
  }

  test("concurrent duplicate creation stops a mixed plan after its first success without retrying", async ({
    page,
  }) => {
    const inventory = await setupInventoryCatalogApi(
      page,
      [inventoryCatalogProduct(1), inventoryCatalogProduct(3)],
      { id: "inventory-new-product", kind: "duplicate" },
    );
    await setupInventoryReviewApi(page, OCR_ROUTE, [
      inventoryReviewRow(1, "4"),
      { ...inventoryReviewRow(2, "2"), productName: "New concurrent fixture" },
      inventoryReviewRow(3, "1"),
    ]);
    await saveInventoryReview(page);
    const panel = inventoryApplicationPanel(page);
    await panel
      .getByRole("button", { name: "재고 상품 불러오기", exact: true })
      .click();
    await panel
      .getByRole("combobox", { name: "재고 상품 선택 1", exact: true })
      .selectOption("inventory-product-1");
    await confirmInventoryRow(page, 1);
    await chooseNewInventoryProduct(page, 2);
    await confirmInventoryRow(page, 2);
    await panel
      .getByRole("combobox", { name: "재고 상품 선택 3", exact: true })
      .selectOption("inventory-product-3");
    await confirmInventoryRow(page, 3);
    await previewInventoryApplication(page);
    await confirmInventoryApplication(page);
    await expect(panel.getByRole("alert")).toContainText("입고 반영이 중단");
    await expect(panel).toContainText("다른 관리자가 등록했거나 기존 상품·버전과 충돌");
    await expect(panel).toContainText("반영 완료");
    await expect(panel).toContainText("미반영");
    expect(inventory.intakes).toHaveLength(2);
    expect(inventory.intakes[0]).toEqual(
      expectedExistingIntake("inventory-product-1", 3, 4),
    );
    expect(inventory.intakes[1]).toMatchObject({ kind: "new", quantity: 2 });
    expect(
      inventory.products.find((product) => product.productId === "inventory-product-1")
        ?.inventoryQuantity,
    ).toBe(9);
    expect(
      inventory.products.find((product) => product.productId === "inventory-product-3")
        ?.inventoryQuantity,
    ).toBe(30);
    await openInventorySection(page, "재고 수정");
    await openInventorySection(page, "입고 OCR");
    await expect(
      panel.getByRole("button", { name: "확인한 입고 반영", exact: true }),
    ).toBeDisabled();
    expect(inventory.intakes).toHaveLength(2);
  });

  test("saving the review draft does not change catalog inventory", async ({
    page,
  }) => {
    const inventory = await setupInventoryCatalogApi(page);
    await setupInventoryReviewApi(page);
    await recognize(page, "Draft only.png");
    await expect(inventoryApplicationPanel(page)).toHaveCount(0);
    await page.getByRole("button", { name: "검토본 저장", exact: true }).click();
    await expect(inventoryApplicationPanel(page)).toBeVisible();
    expect(inventory.intakes).toHaveLength(0);
    await expect(
      inventoryApplicationPanel(page).getByRole("button", {
        name: "확인한 입고 반영",
        exact: true,
      }),
    ).toHaveCount(0);
  });

  test("manual add applies a fresh versioned stock plan and locks that job after navigation or edits", async ({
    page,
  }, testInfo) => {
    const inventory = await setupInventoryCatalogApi(page);
    await setupInventoryReviewApi(page);
    await saveInventoryReview(page);
    const panel = inventoryApplicationPanel(page);
    await expect(
      panel.getByRole("combobox", { name: "재고 반영 방식", exact: true }),
    ).toHaveCount(0);
    await prepareInventoryApplication(page, ["inventory-product-1"]);
    const colors = await panel.evaluate((element) => {
      const select = element.querySelector("select");
      const button = [...element.querySelectorAll("button")].find((item) =>
        item.textContent?.includes("재고 상품 불러오기"),
      );
      return {
        background: getComputedStyle(element).backgroundColor,
        text: getComputedStyle(element).color,
        selectBackground: select ? getComputedStyle(select).backgroundColor : null,
        selectText: select ? getComputedStyle(select).color : null,
        buttonText: button ? getComputedStyle(button).color : null,
      };
    });
    expect(colors.background).not.toBe(colors.text);
    expect(colors.selectBackground).not.toBe(colors.selectText);
    expect(colors.background).not.toBe(colors.buttonText);
    await panel.screenshot({ path: testInfo.outputPath("ocr-inventory-preview.png") });
    expect(inventory.gets).toBeGreaterThanOrEqual(2);
    await expect(
      panel.getByRole("button", { name: "확인한 입고 반영", exact: true }),
    ).toBeDisabled();
    await confirmInventoryApplication(page);
    await expect.poll(() => inventory.intakes.length).toBe(1);
    expect(inventory.intakes[0]).toEqual(
      expectedExistingIntake("inventory-product-1", 3, 4),
    );
    await expect(
      panel.getByRole("button", { name: "확인한 입고 반영", exact: true }),
    ).toBeDisabled();
    await openInventorySection(page, "재고 수정");
    await expectInventoryStock(page, 9);
    await openInventorySection(page, "입고 OCR");
    await expect(
      panel.getByRole("button", { name: "확인한 입고 반영", exact: true }),
    ).toBeDisabled();
    await page
      .getByRole("textbox", { name: "상품명", exact: true })
      .fill("Edited after stock apply");
    await page.getByRole("button", { name: "검토본 저장", exact: true }).click();
    await expect(panel).toBeVisible();
    await expect(
      panel.getByRole("button", { name: "확인한 입고 반영", exact: true }),
    ).toBeDisabled();
    expect(inventory.intakes).toHaveLength(1);
  });

  test("an exact candidate still requires explicit selection and cannot produce an intake POST", async ({
    page,
  }) => {
    const inventory = await setupInventoryCatalogApi(page);
    await setupInventoryReviewApi(page);
    await saveInventoryReview(page);
    const panel = inventoryApplicationPanel(page);
    await panel
      .getByRole("button", { name: "재고 상품 불러오기", exact: true })
      .click();
    await expect(
      panel.getByRole("combobox", { name: "재고 상품 선택 1", exact: true }),
    ).toHaveValue("");
    const preview = panel.getByRole("button", {
      name: "재고 반영 미리보기",
      exact: true,
    });
    if (await preview.isEnabled()) await preview.click();
    await expect(panel.getByRole("alert")).toContainText("개별 확인");
    await expect(
      panel.getByRole("button", { name: "확인한 입고 반영", exact: true }),
    ).toHaveCount(0);
    expect(inventory.intakes).toHaveLength(0);
  });

  test("version conflict stops inventory writes and does not offer an automatic retry", async ({
    page,
  }) => {
    const inventory = await setupInventoryCatalogApi(
      page,
      [inventoryCatalogProduct()],
      {
        id: "inventory-product-1",
        kind: "conflict",
      },
    );
    await setupInventoryReviewApi(page);
    await saveInventoryReview(page);
    await prepareInventoryApplication(page, ["inventory-product-1"]);
    const response = page.waitForResponse((value) => isIntakeRequest(value.request()));
    await confirmInventoryApplication(page);
    await flushResponse(page, response);
    await expect(inventoryApplicationPanel(page).getByRole("alert")).toContainText(
      "재고",
    );
    await expect(
      inventoryApplicationPanel(page).getByRole("button", {
        name: "확인한 입고 반영",
        exact: true,
      }),
    ).toBeDisabled();
    expect(inventory.intakes).toEqual([
      expectedExistingIntake("inventory-product-1", 3, 4),
    ]);
    await openInventorySection(page, "재고 수정");
    // The shared beforeEach initially returned an empty catalog before this
    // test's fixture was installed. A conflict has no successful product to
    // merge, so explicitly reload the current inventory for operator review.
    await page.getByRole("button", { name: "새로고침", exact: true }).click();
    await expectInventoryStock(page, 5);
    await openInventorySection(page, "입고 OCR");
    await expect(
      inventoryApplicationPanel(page).getByRole("button", {
        name: "확인한 입고 반영",
        exact: true,
      }),
    ).toBeDisabled();
    expect(inventory.intakes).toHaveLength(1);
  });

  test("two rows for the same product sum their increments without replacing existing stock", async ({
    page,
  }) => {
    const inventory = await setupInventoryCatalogApi(page);
    await setupInventoryReviewApi(page, OCR_ROUTE, [
      inventoryReviewRow(1, "4"),
      { ...inventoryReviewRow(2, "2"), productName: "Inventory deck 1" },
    ]);
    await saveInventoryReview(page);
    await expect(
      inventoryApplicationPanel(page).getByRole("combobox", {
        name: "재고 반영 방식",
        exact: true,
      }),
    ).toHaveCount(0);
    await prepareInventoryApplication(page, [
      "inventory-product-1",
      "inventory-product-1",
    ]);
    await confirmInventoryApplication(page);
    await expect.poll(() => inventory.intakes.length).toBe(1);
    expect(inventory.intakes[0]).toEqual(
      expectedExistingIntake("inventory-product-1", 3, 6, [
        "inventory-row-1",
        "inventory-row-2",
      ]),
    );
    await openInventorySection(page, "재고 수정");
    await expectInventoryStock(page, 11);
  });

  test("an in-flight stock response still updates inventory after review editing hides its panel", async ({
    page,
  }) => {
    await setupInventoryCatalogApi(page);
    await setupInventoryReviewApi(page);
    const pending = heldResponse();
    const intakes: AdminOcrIntakeInput[] = [];
    await page.route(`${API}admin/catalog/products`, async (route) => {
      if (route.request().method() === "OPTIONS") return json(route, {});
      if (route.request().method() !== "POST") return route.fallback();
      intakes.push(route.request().postDataJSON());
      return pending.handle(route);
    });
    await saveInventoryReview(page);
    await prepareInventoryApplication(page, ["inventory-product-1"]);
    await confirmInventoryApplication(page);
    await pending.started;
    await page
      .getByRole("textbox", { name: "상품명", exact: true })
      .fill("Edited while inventory is pending");
    await expect(inventoryApplicationPanel(page)).toHaveCount(0);
    const response = page.waitForResponse((value) => isIntakeRequest(value.request()));
    pending.respond(
      intakeResponse(
        intakes[0],
        { ...inventoryCatalogProduct(), inventoryQuantity: 9, version: 4 },
        5,
      ),
    );
    await flushResponse(page, response);
    await expect(
      page.getByRole("textbox", { name: "상품명", exact: true }),
    ).toHaveValue("Edited while inventory is pending");
    await openInventorySection(page, "재고 수정");
    await expectInventoryStock(page, 9);
    await openInventorySection(page, "입고 OCR");
    await page.getByRole("button", { name: "검토본 저장", exact: true }).click();
    await expect(inventoryApplicationPanel(page)).toBeVisible();
    await expect(
      inventoryApplicationPanel(page).getByRole("button", {
        name: "확인한 입고 반영",
        exact: true,
      }),
    ).toBeDisabled();
    expect(intakes).toEqual([expectedExistingIntake("inventory-product-1", 3, 4)]);
  });

  test("partial success followed by a lost response stops before the third product", async ({
    page,
  }) => {
    const inventory = await setupInventoryCatalogApi(
      page,
      [
        inventoryCatalogProduct(1),
        inventoryCatalogProduct(2),
        inventoryCatalogProduct(3),
      ],
      { id: "inventory-product-2", kind: "response-lost" },
    );
    await setupInventoryReviewApi(page, OCR_ROUTE, [
      inventoryReviewRow(1, "4"),
      inventoryReviewRow(2, "2"),
      inventoryReviewRow(3, "1"),
    ]);
    await saveInventoryReview(page);
    await prepareInventoryApplication(page, [
      "inventory-product-1",
      "inventory-product-2",
      "inventory-product-3",
    ]);
    const failed = page.waitForEvent(
      "requestfailed",
      (request) =>
        isIntakeRequest(request) &&
        request.postDataJSON().existing?.productId === "inventory-product-2",
    );
    await confirmInventoryApplication(page);
    await failed;
    await expect(inventoryApplicationPanel(page).getByRole("alert")).toContainText(
      "재고",
    );
    await expect(
      inventoryApplicationPanel(page).getByRole("button", {
        name: "확인한 입고 반영",
        exact: true,
      }),
    ).toBeDisabled();
    expect(inventory.intakes).toEqual([
      expectedExistingIntake("inventory-product-1", 3, 4),
      expectedExistingIntake("inventory-product-2", 4, 2, ["inventory-row-2"]),
    ]);
    await openInventorySection(page, "재고 수정");
    await expectInventoryStock(page, 9);
    await openInventorySection(page, "입고 OCR");
    await expect(
      inventoryApplicationPanel(page).getByRole("button", {
        name: "확인한 입고 반영",
        exact: true,
      }),
    ).toBeDisabled();
    expect(inventory.intakes).toHaveLength(2);
  });

  test("pending inventory finishes visibly after the OCR panel is unmounted and reopened", async ({
    page,
  }) => {
    await setupInventoryCatalogApi(page);
    await setupInventoryReviewApi(page);
    const pending = heldResponse();
    const intakes: AdminOcrIntakeInput[] = [];
    await page.route(`${API}admin/catalog/products`, async (route) => {
      if (route.request().method() === "OPTIONS") return json(route, {});
      if (route.request().method() !== "POST") return route.fallback();
      intakes.push(route.request().postDataJSON());
      return pending.handle(route);
    });
    await saveInventoryReview(page);
    await prepareInventoryApplication(page, ["inventory-product-1"]);
    await inventoryApplicationPanel(page)
      .getByRole("checkbox", {
        name: "실제 상품 등록·재고 변경 내용을 확인했습니다",
        exact: true,
      })
      .check();
    await inventoryApplicationPanel(page)
      .getByRole("button", {
        name: "확인한 입고 반영",
        exact: true,
      })
      .dblclick();
    await pending.started;
    expect(intakes).toHaveLength(1);
    await openInventorySection(page, "재고 수정");
    await openInventorySection(page, "입고 OCR");
    await expect(
      inventoryApplicationPanel(page).getByRole("button", {
        name: "입고 반영 중…",
        exact: true,
      }),
    ).toBeDisabled();
    const response = page.waitForResponse((value) => isIntakeRequest(value.request()));
    pending.respond(
      intakeResponse(
        intakes[0],
        { ...inventoryCatalogProduct(), inventoryQuantity: 9, version: 4 },
        5,
      ),
    );
    await flushResponse(page, response);
    await expect(inventoryApplicationPanel(page).getByRole("status")).toContainText(
      "입고 반영이 완료",
    );
    await expect(
      inventoryApplicationPanel(page).getByRole("button", {
        name: "확인한 입고 반영",
        exact: true,
      }),
    ).toBeDisabled();
    expect(intakes).toEqual([expectedExistingIntake("inventory-product-1", 3, 4)]);
  });

  test("an older catalog reload cannot replace a later canonical inventory write", async ({
    page,
  }) => {
    await setupInventoryCatalogApi(page);
    await setupInventoryReviewApi(page);
    const stock = heldResponse();
    const catalog = heldResponse();
    const intakes: AdminOcrIntakeInput[] = [];
    await page.route(`${API}admin/catalog/products`, async (route) => {
      if (route.request().method() === "OPTIONS") return json(route, {});
      if (route.request().method() !== "POST") return route.fallback();
      intakes.push(route.request().postDataJSON());
      return stock.handle(route);
    });
    await saveInventoryReview(page);
    await prepareInventoryApplication(page, ["inventory-product-1"]);
    await confirmInventoryApplication(page);
    await stock.started;
    // This GET begins before the successful intake POST result is received, but its
    // captured catalog snapshot is deliberately delivered after the stock write.
    const catalogUrl = new URL(`${API}admin/catalog/products`);
    await page.route(
      (url) => url.origin === catalogUrl.origin && url.pathname === catalogUrl.pathname,
      async (route) => {
        if (route.request().method() === "OPTIONS") return json(route, {});
        if (route.request().method() !== "GET") return route.fallback();
        return catalog.handle(route);
      },
    );
    await openInventorySection(page, "재고 수정");
    await page.getByRole("button", { name: "새로고침", exact: true }).click();
    await catalog.started;
    const stockResponse = page.waitForResponse((value) =>
      isIntakeRequest(value.request()),
    );
    stock.respond(
      intakeResponse(
        intakes[0],
        { ...inventoryCatalogProduct(), inventoryQuantity: 9, version: 4 },
        5,
      ),
    );
    await flushResponse(page, stockResponse);
    await expectInventoryStock(page, 9);
    const catalogResponse = page.waitForResponse(
      (value) =>
        value.request().method() === "GET" &&
        new URL(value.url()).origin === catalogUrl.origin &&
        new URL(value.url()).pathname === catalogUrl.pathname,
    );
    catalog.respond({ products: [inventoryCatalogProduct()] });
    await flushResponse(page, catalogResponse);
    await expectInventoryStock(page, 9);
    await openInventorySection(page, "입고 OCR");
    await expect(inventoryApplicationPanel(page).getByRole("status")).toContainText(
      "입고 반영이 완료",
    );
    expect(intakes).toEqual([expectedExistingIntake("inventory-product-1", 3, 4)]);
  });

  test("a delayed manual stock response cannot overwrite a newer OCR inventory version", async ({
    page,
  }) => {
    const inventory = await setupInventoryCatalogApi(page);
    await setupInventoryReviewApi(page);
    const manual = heldResponse();
    const patches: Record<string, unknown>[] = [];
    let manualSnapshot: InventoryCatalogFixture | undefined;
    await page.route(
      `${API}admin/catalog/products/inventory-product-1`,
      async (route) => {
        const request = route.request();
        if (request.method() === "OPTIONS") return json(route, {});
        expect(request.method()).toBe("PATCH");
        expect(request.headers().authorization).toBe(`Bearer ${JWT}`);
        const body = request.postDataJSON() as { version: number; stock: number };
        const product = inventory.products[0];
        expect(body.version).toBe(product.version);
        patches.push(body);
        product.inventoryQuantity = body.stock;
        product.version += 1;
        if (patches.length === 1) {
          manualSnapshot = { ...product };
          return manual.handle(route);
        }
        return json(route, { product });
      },
    );
    await openInventorySection(page, "재고 수정");
    await page.getByRole("button", { name: "새로고침", exact: true }).click();
    await expectInventoryStock(page, 5);
    await page
      .getByRole("button", { name: "Inventory deck 1 재고 조정", exact: true })
      .click();
    await expect(
      page.getByRole("textbox", { name: "변경 후 재고 수량", exact: true }),
    ).toHaveValue("5");
    await page.getByRole("button", { name: "재고 1개 증가", exact: true }).click();
    await expect(
      page.getByRole("textbox", { name: "변경 후 재고 수량", exact: true }),
    ).toHaveValue("6");
    await page
      .getByRole("textbox", { name: "변경 후 재고 수량", exact: true })
      .press("Enter");
    await page.getByRole("textbox", { name: "변경 후 재고 수량", exact: true }).blur();
    expect(patches).toHaveLength(0);
    page.once("dialog", (dialog) => dialog.accept());
    await page
      .getByRole("button", { name: "재고 변경 내용 확인", exact: true })
      .click();
    await manual.started;
    await openInventorySection(page, "입고 OCR");
    await saveInventoryReview(page);
    await prepareInventoryApplication(page, ["inventory-product-1"]);
    await confirmInventoryApplication(page);
    await expect(inventoryApplicationPanel(page).getByRole("status")).toContainText(
      "입고 반영이 완료",
    );
    await openInventorySection(page, "재고 수정");
    await expectInventoryStock(page, 10);
    const response = page.waitForResponse(
      (value) =>
        value.request().method() === "PATCH" &&
        value.url().endsWith("/inventory-product-1"),
    );
    manual.respond({ product: manualSnapshot });
    await flushResponse(page, response);
    await expectInventoryStock(page, 10);
    expect(patches).toEqual([{ version: 3, stock: 6 }]);
    expect(inventory.intakes).toEqual([
      expectedExistingIntake("inventory-product-1", 4, 4),
    ]);
  });
});
