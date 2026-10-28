/** H-033 완료 판정: 영어 관리자 화면에 번역 제외 데이터 말고는 한글이 없음. 합성 API만 사용함. */
import { expect, test, type Page, type Route } from "@playwright/test";
import { deflateSync } from "node:zlib";
import {
  parseOcrTableRows,
  type OcrMapping,
  type OcrTableToken,
} from "../infra/lambda/ocr-table-parser.js";
import {
  calculateTotals,
  type DayReport,
  type SaleEntry,
} from "../infra/lambda/sales-ledger-domain";

const ORIGIN = "http://127.0.0.1:3139";
const API = "https://api.sales.test/prod/";
const SUBJECT = "english-synthetic-admin";
const DAY = "2026-10-15";
const CLOSED_DAY = "2026-10-14";
const AS_OF = `${DAY}T14:00:00.000Z`;

/** 계획서 '번역 제외' 항목만 정확 일치로 허용함. 부분 문자열 허용은 두지 않음. */
const ALLOWED = new Set([
  // 모의 주문 고정 상품명(order-inventory-simulation.ts). 사용자 결정으로 데이터 취급.
  "[테스트] 합성 데크",
  // 모의 매출 고정 상품명(sales-ledger-simulation.ts). 사용자 결정으로 데이터 취급.
  "[테스트] 가상 데크",
  "[테스트] 가상 그립",
  // 관리자가 입력한 재개방 사유(서버 데이터). 서버 고정 마감 사유만 영어로 매핑함.
  "현금 재확인",
]);

type Audit = { blocked: string[]; dialogs: string[] };
const audits = new WeakMap<Page, Audit>();

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

const catalog = [
  {
    productId: "prd_english_deck",
    slug: "english-synthetic-deck",
    name: "[TEST] English deck",
    brandId: "brand_test",
    brandName: "TEST",
    category: "Deck",
    price: 107_000,
    currency: "KRW",
    status: "PUBLISHED",
    inventoryQuantity: 2,
    featured: false,
    image: "/images/product-placeholder.svg",
    images: ["/images/product-placeholder.svg"],
    description: ["Synthetic English fixture"],
    sizes: ["8.5"],
    sku: "TEST-EN-DECK",
    version: 3,
    createdAt: "2026-10-01T00:00:00Z",
    updatedAt: "2026-10-01T00:00:00Z",
  },
];
const members = [
  {
    username: "member+alex@example.test",
    userSub: "member-synthetic-alex",
    email: "alex@example.test",
    displayName: "[TEST] Alex",
    enabled: true,
    groups: [],
  },
];
const order = {
  orderId: "pd_order_001",
  status: "PAID",
  paymentStatus: "DONE",
  total: 200,
  createdAt: `${DAY}T00:00:00Z`,
  lines: [
    {
      line: 0,
      productId: "prd_deck",
      name: "Deck",
      selectedSize: "8",
      quantity: 2,
      unitPrice: 100,
      lineTotal: 200,
      canceledQuantity: 0,
      restoredQuantity: 0,
    },
  ],
  inventory: {
    state: "DEBITED",
    fulfillment: "SHIPPED",
    expiresAt: `${DAY}T00:30:00Z`,
    refundedAmount: 0,
    pendingRefund: null,
    lastFailure: { operationId: "admin_old", code: "SYNTHETIC_REJECTED" },
  },
};

function sale(overrides: Partial<SaleEntry> = {}): SaleEntry {
  return {
    entryId: "sale_english_001",
    businessDay: DAY,
    recordType: "SALE",
    version: 1,
    status: "POSTED",
    kind: "SALE",
    soldAt: `${DAY}T00:30:00.000Z`,
    method: "CARD",
    reference: "CARD-001",
    amount: 10_000,
    memo: "Synthetic English ledger",
    lines: [
      {
        productId: "prd_deck",
        name: "Deck",
        option: "8.25",
        quantity: 1,
        unitAmount: 10_000,
      },
    ],
    createdAt: AS_OF,
    updatedAt: AS_OF,
    ...overrides,
  };
}
const entries = (day: string) => [
  sale({ businessDay: day, soldAt: `${day}T00:30:00.000Z` }),
  sale({
    entryId: "sale_english_002",
    businessDay: day,
    soldAt: `${day}T00:40:00.000Z`,
    status: "DRAFT",
    method: "CASH",
    reference: "CASH-001",
    amount: 5_000,
    lines: [
      { productId: null, name: "", option: "", quantity: 1, unitAmount: 4_000 },
    ] as unknown as SaleEntry["lines"],
  }),
  sale({
    entryId: "sale_english_003",
    businessDay: day,
    soldAt: `${day}T00:50:00.000Z`,
    kind: "REVERSAL",
    method: "TRANSFER",
    reference: "REV-TRANSFER-001",
    original: { businessDay: day, entryId: "sale_english_001" },
    restocked: false,
  }),
];
const onlineEvents = (day: string) => [
  {
    orderId: "pd_online_001",
    kind: "APPROVAL" as const,
    amount: 30_000,
    occurredAt: `${day}T02:00:00.000Z`,
    timeBasis: "OBSERVED" as const,
  },
  {
    orderId: "pd_online_002",
    kind: "REFUND" as const,
    amount: 5_000,
    occurredAt: `${day}T03:00:00.000Z`,
    timeBasis: "PROVIDER" as const,
  },
];
function dayReport(day: string): DayReport {
  const closed = day === CLOSED_DAY;
  const dayEntries = entries(day);
  const events = onlineEvents(day);
  const totals = calculateTotals(dayEntries, events);
  return {
    businessDay: day,
    timezone: "Asia/Seoul",
    version: 4,
    status: closed ? "CLOSED" : "OPEN",
    asOf: AS_OF,
    entries: dayEntries,
    onlineEvents: events,
    totals,
    warnings: closed ? [] : ["UNPOSTED_SALES", "ONLINE_PAYMENT_RESULT_PENDING"],
    onlineFingerprint: "a".repeat(64),
    snapshots: closed
      ? [
          {
            snapshotId: "close_english_001",
            closedAt: AS_OF,
            version: 3,
            totals,
            onlineFingerprint: "a".repeat(64),
            cashComparedAmount: totals.cash,
            entryManifest: "c".repeat(64),
            entryCount: 3,
            onlineEvents: events,
          },
        ]
      : [],
    history: closed
      ? [
          { action: "CLOSE", reason: "매출 대조 확인", at: AS_OF },
          { action: "REOPEN", reason: "현금 재확인", at: AS_OF },
          { action: "CLOSE", reason: "매출 대조 확인", at: AS_OF },
        ]
      : [],
    complete: true,
  } as DayReport;
}

// OCR 원문 토큰은 ASCII 합성값만 사용함. 영역 지정 결과는 실제 파서로 계산함.
function token(
  id: string,
  sourceText: string,
  left: number,
  top: number,
  width: number,
) {
  return {
    id,
    sourceText,
    confidence: 0.94,
    box: [
      [left, top],
      [left + width, top],
      [left + width, top + 30],
      [left, top + 30],
    ] as [number, number][],
  };
}
const ocrTokens: OcrTableToken[] = [
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
  token("footer", "Total", 100, 420, 80),
  token("footerqty", "5", 1300, 420, 30),
];
const initialOcrJob = () => ({
  jobId: "ocr_english",
  version: 1,
  rawText: ocrTokens.map((row) => row.sourceText).join("\n"),
  rows: ocrTokens.map((row) => ({
    ...row,
    productName: "",
    brand: "",
    option: "",
    quantity: "",
  })) as Record<string, unknown>[],
  analysis: { mode: "unclassified", reason: "header-not-found" } as Record<
    string,
    unknown
  >,
});
let ocrJob = initialOcrJob();
/** 1600×820 흰 PNG. 영역 드래그 좌표가 실제 이미지 크기로 정규화되도록 크기만 맞춤. */
function blankPng(width = 1600, height = 820) {
  const crc = (bytes: Buffer) => {
    let c = 0xffffffff;
    for (const byte of bytes) {
      c ^= byte;
      for (let bit = 0; bit < 8; bit++) c = (c >>> 1) ^ (c & 1 ? 0xedb88320 : 0);
    }
    return (c ^ 0xffffffff) >>> 0;
  };
  const chunk = (name: string, data: Buffer) => {
    const type = Buffer.from(name);
    const size = Buffer.alloc(4);
    const checksum = Buffer.alloc(4);
    size.writeUInt32BE(data.length);
    checksum.writeUInt32BE(crc(Buffer.concat([type, data])));
    return Buffer.concat([size, type, data, checksum]);
  };
  const pixels = Buffer.alloc((width * 3 + 1) * height, 255);
  for (let y = 0; y < height; y++) pixels[y * (width * 3 + 1)] = 0;
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
const PNG = blankPng();

async function setup(page: Page, path = "/admin") {
  const audit: Audit = { blocked: [], dialogs: [] };
  audits.set(page, audit);
  // 네이티브 confirm·alert 문구는 DOM에 없으므로 모두 기록해 afterEach에서 한글 여부를 검사함.
  page.on("dialog", (dialog) => {
    audit.dialogs.push(dialog.message());
    void dialog.accept();
  });
  ocrJob = initialOcrJob();
  await page.route("**/*", async (route) => {
    const request = route.request();
    const url = new URL(request.url());
    const method = request.method();
    if (url.origin === ORIGIN && ["GET", "HEAD"].includes(method))
      return route.continue();
    if (!request.url().startsWith(API)) {
      audit.blocked.push(`${method} ${url.origin}${url.pathname}`);
      return route.abort();
    }
    if (method === "OPTIONS") return respond(route, {});
    const path = url.pathname.replace("/prod/", "");
    if (path === "me")
      return respond(route, { userSub: SUBJECT, marketingConsent: false });
    if (path === "orders") return respond(route, { orders: [] });
    if (path === "admin/overview")
      return respond(route, {
        asOf: AS_OF,
        timezone: "Asia/Seoul",
        todayOrderCount: 3,
        todayPaidRevenue: 139_000,
        todaySoldItemCount: 5,
        todayNewMemberCount: 2,
        lowStockCount: 1,
        lowStockThreshold: 3,
        activeCouponCount: 7,
        marketingConsentCount: 11,
      });
    if (path === "admin/members") return respond(route, { members });
    if (path === `admin/orders/${order.orderId}/refunds`)
      return respond(route, { order });
    if (path.startsWith("admin/sales/")) {
      const day = decodeURIComponent(path.slice("admin/sales/".length));
      if (method === "GET") return respond(route, { report: dayReport(day) });
      const command = request.postDataJSON();
      if (command.action === "preview")
        return respond(route, {
          preview: [
            {
              productId: "prd_deck",
              name: "Deck",
              quantity: 5,
              reserved: 1,
              available: 4,
              delta: -1,
              after: 4,
              version: 4,
            },
          ],
          previewToken: "b".repeat(64),
          entryId: command.entryId,
          version: command.version,
        });
      audit.blocked.push(`${method} ${url.pathname} ${command.action}`);
      return route.abort();
    }
    if (path.startsWith("admin/ocr/jobs")) {
      if (method === "POST") return respond(route, { job: ocrJob }, 201);
      if (method === "GET") return respond(route, { job: ocrJob });
      const body = request.postDataJSON();
      if (body.mapping) {
        const { rows, ...analysis } = parseOcrTableRows(
          ocrTokens,
          body.mapping as OcrMapping,
        );
        const projected = rows.map((row) => ({
          ...row,
          productName: "productName" in row ? String(row.productName) : "",
          brand: "brand" in row ? String(row.brand) : "",
          option: "option" in row ? String(row.option) : "",
          quantity: "quantity" in row ? String(row.quantity) : "",
        }));
        if (body.preview)
          return respond(route, {
            preview: {
              jobId: ocrJob.jobId,
              version: ocrJob.version,
              rows: projected,
              analysis,
            },
          });
        ocrJob = { ...ocrJob, version: ocrJob.version + 1, rows: projected, analysis };
      } else ocrJob = { ...ocrJob, version: ocrJob.version + 1, rows: body.rows };
      return respond(route, { job: ocrJob });
    }
    if (path === "admin/catalog/products" && method === "POST") {
      const body = request.postDataJSON();
      return respond(route, {
        product: {
          ...catalog[0],
          inventoryQuantity: catalog[0].inventoryQuantity + body.quantity,
          version: catalog[0].version + 1,
        },
        receipt: {
          operationId: body.operationId,
          kind: body.kind,
          quantity: body.quantity,
          beforeStock: catalog[0].inventoryQuantity,
          afterStock: catalog[0].inventoryQuantity + body.quantity,
          replayed: false,
        },
      });
    }
    if (
      ["admin/catalog/products", "catalog/products"].includes(path) &&
      method === "GET"
    )
      return respond(route, { products: catalog });
    audit.blocked.push(`${method} ${url.pathname}`);
    return route.abort();
  });
  const accessToken = [
    Buffer.from(JSON.stringify({ alg: "none", typ: "JWT" })).toString("base64url"),
    Buffer.from(
      JSON.stringify({ sub: SUBJECT, exp: 4102444800, "cognito:groups": ["admin"] }),
    ).toString("base64url"),
    "test-only-signature",
  ].join(".");
  await page.addInitScript(
    (session) => {
      sessionStorage.setItem("paradays.auth.session", JSON.stringify(session));
      localStorage.setItem("paradays-locale", "en");
    },
    {
      accessToken,
      expiresAt: 4102444800000,
      user: { sub: SUBJECT, username: "english-admin", groups: ["admin"] },
    },
  );
  await page.clock.setFixedTime(new Date(AS_OF));
  await page.goto(path);
  await page.waitForLoadState("networkidle");
  await expect(page.locator("html")).toHaveAttribute("lang", "en");
}

/** 보이는 텍스트·접근성 이름·placeholder·title·alt·선택지에서 허용 목록 밖 한글을 모음. */
async function hangul(page: Page) {
  await page.evaluate(() => {
    for (const details of document.querySelectorAll("details")) details.open = true;
  });
  const found = await page.evaluate(() => {
    // 완성형·호환 자모뿐 아니라 NFD 조합형·확장 자모까지 Hangul 문자 체계 전체를 잡음.
    const re = /\p{Script=Hangul}/u;
    const out: string[] = [];
    const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
    while (walker.nextNode()) {
      const node = walker.currentNode as Text;
      const parent = node.parentElement;
      if (
        parent &&
        re.test(node.data) &&
        !parent.closest("script,style") &&
        (parent.getClientRects().length || parent.closest("option"))
      )
        out.push(node.data.trim());
    }
    for (const element of document.querySelectorAll(
      "[aria-label],[placeholder],[title],[alt]",
    ))
      for (const name of ["aria-label", "placeholder", "title", "alt"]) {
        const value = element.getAttribute(name);
        if (value && re.test(value)) out.push(`@${name}=${value}`);
      }
    return out;
  });
  return [...new Set(found)];
}
async function scan(page: Page, step: string, found: Map<string, string[]>) {
  const left = (await hangul(page)).filter((text) => !ALLOWED.has(text));
  if (left.length) found.set(step, left);
}
function expectClean(found: Map<string, string[]>) {
  expect(Object.fromEntries(found)).toEqual({});
}
async function openSection(page: Page, name: string) {
  const tab = page.getByRole("tab", { name, exact: true });
  if (!(await tab.isVisible()))
    await page
      .getByRole("button", { name: "Open operations menu", exact: true })
      .click();
  await tab.click();
}

test.afterEach(async ({ page }) => {
  expect(audits.get(page)?.blocked ?? []).toEqual([]);
  expect(
    (audits.get(page)?.dialogs ?? []).filter((message) =>
      /\p{Script=Hangul}/u.test(message),
    ),
  ).toEqual([]);
});

test("all nine menus and the overview order panels show no Korean in English", async ({
  page,
}) => {
  test.setTimeout(120_000);
  await setup(page, "/admin?section=overview");
  const found = new Map<string, string[]>();
  // 검사기 자기 확인: NFD 조합형·확장 자모 한글도 수집해야 함.
  const decomposed = `${"한글".normalize("NFD")}\uA960\uD7B0`;
  await page.evaluate((text) => {
    const probe = document.createElement("p");
    probe.id = "hangul-probe";
    probe.textContent = text;
    document.body.append(probe);
  }, decomposed);
  expect(await hangul(page)).toContain(decomposed);
  await page.evaluate(() => document.getElementById("hangul-probe")?.remove());
  for (const name of [
    "Home (Operations Overview)",
    "Product registration",
    "Stock editing",
    "Sales & daily close",
    "Brands",
    "Members",
    "Coupons",
    "Marketing",
    "Stock-in OCR",
  ]) {
    await openSection(page, name);
    await page.waitForLoadState("networkidle");
    await scan(page, `menu ${name}`, found);
  }
  await openSection(page, "Home (Operations Overview)");
  await page
    .getByRole("textbox", { name: "Order number", exact: true })
    .fill(order.orderId);
  await page.getByRole("button", { name: "Look up order", exact: true }).click();
  await expect(page.getByRole("heading", { name: /pd_order_001/ })).toBeVisible();
  await scan(page, "order stock panel", found);

  await page
    .getByLabel("I understand this mock test does not change real orders or stock", {
      exact: true,
    })
    .check();
  await page.getByRole("button", { name: "Start mock test", exact: true }).click();
  await page
    .getByRole("button", { name: "Mock approve · Deduct 2", exact: true })
    .click();
  await page.getByRole("button", { name: "Mock confirm shipped", exact: true }).click();
  await page
    .getByRole("button", { name: "Mock shipped item refund · No restock", exact: true })
    .click();
  await page
    .getByRole("button", { name: "Mock shipped item refund · No restock", exact: true })
    .click();
  await expect(page.getByRole("status", { name: "Mock result" })).toBeVisible();
  await scan(page, "mock order panel", found);
  expectClean(found);
});

test("product editor, size chart dialog and stock stepper show no Korean in English", async ({
  page,
}) => {
  await setup(page, "/admin?section=products");
  const found = new Map<string, string[]>();
  await page.getByRole("button", { name: "Register new product", exact: true }).click();
  await scan(page, "new product editor", found);
  await openSection(page, "Product registration");
  await page.getByRole("button", { name: "Edit", exact: true }).first().click();
  await page.getByRole("button", { name: "+ Add size chart" }).click();
  await expect(page.getByRole("dialog")).toBeVisible();
  await scan(page, "size chart dialog", found);
  await page.keyboard.press("Escape");
  await openSection(page, "Stock editing");
  await page
    .getByRole("button", { name: "Adjust stock for [TEST] English deck", exact: true })
    .click();
  await scan(page, "stock stepper", found);
  expectClean(found);
});

test("real sales ledger with slips, reversal, close and reopen history shows no Korean in English", async ({
  page,
}) => {
  await setup(page, "/admin?section=sales");
  const found = new Map<string, string[]>();
  await page
    .getByRole("button", {
      name: "Open real operations · Open real sales and daily close",
      exact: true,
    })
    .click();
  await page.getByLabel("Business day (Korea time)", { exact: true }).fill(DAY);
  await page.getByRole("button", { name: "Load ledger", exact: true }).click();
  await expect(page.getByText("CARD-001", { exact: true })).toBeVisible();
  await scan(page, "open ledger", found);
  await page
    .getByRole("button", { name: "Continue editing · Select slip sale_english_002" })
    .click();
  await scan(page, "draft slip editor", found);
  await page
    .getByRole("button", { name: "Register sale · New slip", exact: true })
    .click();
  await page.getByRole("button", { name: "Add unmatched line", exact: true }).click();
  await scan(page, "new slip editor", found);
  await page
    .getByRole("button", { name: "Details · Select slip sale_english_001" })
    .click();
  await scan(page, "posted slip and reversal form", found);
  await page
    .getByRole("button", { name: "Details · Select slip sale_english_003" })
    .click();
  await scan(page, "reversal slip details", found);
  await page.getByLabel("Business day (Korea time)", { exact: true }).fill(CLOSED_DAY);
  await page.getByRole("button", { name: "Load ledger", exact: true }).click();
  // 이력은 접힌 details 안에 있음. scan이 details를 모두 펼친 뒤 검사함.
  await expect(page.getByText("Sales reconciliation confirmed").first()).toBeAttached();
  await scan(page, "closed ledger and history", found);
  await expect(page.getByText("Sales reconciliation confirmed").first()).toBeVisible();
  // 관리자 입력 재개방 사유는 원문 그대로 남고, 허용 목록 정확 일치로만 통과함.
  expect(await hangul(page)).toContain("현금 재확인");
  expectClean(found);
});

test("mock sales practice through posting and daily close shows no Korean in English", async ({
  page,
}) => {
  await setup(page, "/admin?section=sales");
  const found = new Map<string, string[]>();
  await scan(page, "sales mode choice", found);
  await page
    .getByLabel(
      "I confirm this mock practice does not change the real ledger or stock",
      {
        exact: true,
      },
    )
    .check();
  await page
    .getByRole("button", { name: "Try mock sales and daily close", exact: true })
    .click();
  await page.getByRole("button", { name: "Load card example", exact: true }).click();
  await page.getByRole("button", { name: "Save mock draft", exact: true }).click();
  await page
    .getByRole("button", { name: "Check virtual stock plan", exact: true })
    .click();
  // 검사기 자체 확인: 허용 목록의 모의 상품명은 실제로 수집돼야 함.
  expect(await hangul(page)).toContain("[테스트] 가상 데크");
  await scan(page, "mock stock plan", found);
  await page
    .getByLabel("I checked the virtual stock deduction in the plan", { exact: true })
    .check();
  await page.getByRole("button", { name: "Post mock sale", exact: true }).click();
  await page
    .getByLabel("Mock handwritten cash amount (KRW)", { exact: true })
    .fill("0");
  await page
    .getByLabel("I checked the mock totals and cash amount", { exact: true })
    .check();
  await page
    .getByRole("button", { name: "Confirm mock daily close", exact: true })
    .click();
  await expect(page.getByText("TEST_CLOSE_1", { exact: true })).toBeVisible();
  await scan(page, "mock closed day", found);
  expectClean(found);
});

test("member detail, coupon and campaign steps show no Korean in English", async ({
  page,
}) => {
  await setup(page, "/admin?section=members");
  const found = new Map<string, string[]>();
  await page.getByRole("button", { name: "Load member list", exact: true }).click();
  await page
    .getByRole("button", { name: "[TEST] Alex member details", exact: true })
    .click();
  await scan(page, "member detail", found);
  await openSection(page, "Coupons");
  await page.getByLabel("Coupon name (required)").fill("Welcome");
  await scan(page, "coupon draft", found);
  await openSection(page, "Marketing");
  await page.getByLabel("Campaign title (required)").fill("Autumn");
  await page.getByLabel("Message (required)").fill("Synthetic message");
  await scan(page, "campaign draft", found);
  expectClean(found);
});

async function imagePoint(page: Page, x: number, y: number) {
  const image = page.getByRole("img", {
    name: "Receiving sheet image for area mapping",
    exact: true,
  });
  await page
    .getByRole("group", { name: "Image area selection", exact: true })
    .scrollIntoViewIfNeeded();
  await image.evaluate(
    (node, point) => {
      const frame = node.closest("[data-pan]")!.parentElement!;
      frame.scrollLeft = point.x * node.clientWidth - frame.clientWidth / 2;
      frame.scrollTop = point.y * node.clientHeight - frame.clientHeight / 2;
    },
    { x, y },
  );
  const bounds = await image.boundingBox();
  if (!bounds) throw new Error("Image not visible");
  return bounds;
}
async function dragArea(page: Page, label: string, rect: readonly number[]) {
  const button = page.getByRole("button", { name: `${label} area`, exact: true });
  await button.click();
  const [left, top, right, bottom] = rect;
  const bounds = await imagePoint(page, (left + right) / 3200, (top + bottom) / 1640);
  await page.mouse.move(
    bounds.x + (left / 1600) * bounds.width,
    bounds.y + (top / 820) * bounds.height,
  );
  await page.mouse.down();
  await page.mouse.move(
    bounds.x + (right / 1600) * bounds.width,
    bounds.y + (bottom / 820) * bounds.height,
    { steps: 4 },
  );
  await page.mouse.up();
  await expect(button).toContainText("Set · Select again");
}

test("OCR intake, area mapping and stock receipt show no Korean in English", async ({
  page,
}) => {
  test.setTimeout(120_000);
  await setup(page, "/admin?section=ocr");
  const found = new Map<string, string[]>();
  await page
    .locator('input[accept="image/png,image/jpeg,image/webp"]')
    .setInputFiles({ name: "intake.png", mimeType: "image/png", buffer: PNG });
  await page
    .getByRole("button", { name: "Extract text with OCR", exact: true })
    .click();
  await expect(
    page.getByRole("button", { name: "Save review", exact: true }),
  ).toBeEnabled();
  await scan(page, "OCR review and area mapping", found);

  await expect(
    page.getByRole("img", {
      name: "Receiving sheet image for area mapping",
      exact: true,
    }),
  ).toHaveJSProperty("naturalWidth", 1600);
  await dragArea(page, "Product name", [90, 190, 450, 240]);
  await dragArea(page, "Brand", [490, 190, 680, 240]);
  await dragArea(page, "Option", [790, 190, 1000, 240]);
  await dragArea(page, "Quantity", [1270, 190, 1370, 240]);
  const tableEnd = page.getByRole("button", { name: "Set table end", exact: true });
  await tableEnd.click();
  const end = await imagePoint(page, 0.5, 370 / 820);
  await page.mouse.click(end.x + end.width / 2, end.y + (370 / 820) * end.height);
  await expect(tableEnd).toContainText("Set");
  await page
    .getByLabel("The selected quantity area is the actual quantity, not a price", {
      exact: true,
    })
    .check();
  await page.getByRole("button", { name: "Preview areas", exact: true }).click();
  await expect(
    page.getByRole("region", { name: "Area mapping preview table", exact: true }),
  ).toContainText("Synthetic wheels");
  await expect(page.getByText(/^2 products · Total quantity 5/u)).toBeVisible();
  await scan(page, "OCR area mapping preview", found);
  const confirmation = page.waitForEvent("dialog");
  await page.getByRole("button", { name: "Apply area mapping", exact: true }).click();
  // 적용 확인창이 실제로 떴고 영어 문구였는지 단언함. 수락은 공통 핸들러가 함.
  expect((await confirmation).message()).toBe(
    "Replace the current review rows with this area result? Earlier edits to product name, brand, option and quantity will change.",
  );
  await expect(
    page.getByRole("textbox", { name: "Product name", exact: true }).first(),
  ).toHaveValue("Synthetic deck");
  await scan(page, "OCR area mapping applied", found);

  await page.getByRole("button", { name: "Save review", exact: true }).click();
  const panel = page.getByRole("region", { name: "Apply to stock", exact: true });
  await panel.getByRole("button", { name: "Load stock products", exact: true }).click();
  for (const row of [1, 2]) {
    await panel
      .getByRole("combobox", { name: `Stock product ${row}`, exact: true })
      .selectOption("prd_english_deck");
    await panel.getByLabel(`I checked receiving row ${row}`, { exact: true }).check();
  }
  await panel
    .getByRole("button", { name: "Preview stock changes", exact: true })
    .click();
  // 미리보기는 상품 목록 재조회 뒤 비동기로 생기므로 표·예정 행·확인 대기 상태를 기다림.
  const preview = panel.getByRole("table");
  await expect(preview).toContainText("[TEST] English deck");
  await expect(preview.getByRole("row")).toHaveCount(2);
  await expect(preview).toContainText("Awaiting confirmation");
  await scan(page, "OCR stock receipt preview", found);
  await panel
    .getByLabel("I checked the actual product registration and stock changes", {
      exact: true,
    })
    .check();
  await panel
    .getByRole("button", { name: "Apply confirmed receipt", exact: true })
    .click();
  await expect(panel.getByRole("status").last()).toContainText(
    "The receipt is applied",
  );
  await scan(page, "OCR stock receipt result", found);
  expect(audits.get(page)?.dialogs).toHaveLength(1);
  expectClean(found);
});
