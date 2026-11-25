// 역할: 관리자 영어 화면 검사의 모의 API 설정과 허용 목록 밖 한글 수집·도움말·화면 안내 순회 도우미를 제공함.
import { expect, type Page, type Route } from "@playwright/test";
import {
  parseOcrTableRows,
  type OcrMapping,
} from "../infra/lambda/ocr-table-parser.js";
import {
  AS_OF,
  catalog,
  members,
  order,
  dayReport,
  ocrTokens,
  initialOcrJob,
  publicShape,
} from "./admin-english-data-fixtures";

const ORIGIN = "http://127.0.0.1:3139";

const API = "https://api.sales.test/prod/";

const SUBJECT = "english-synthetic-admin";

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

let ocrJob = initialOcrJob();

/** 테스트가 고정 카탈로그 옆에 추가하는 상품임. setup이 초기화함. */
let extraCatalog: Record<string, unknown>[] = [];

async function setup(
  page: Page,
  path = "/admin",
  extra: Record<string, unknown>[] = [],
) {
  extraCatalog = extra;
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
      path === "catalog/products" &&
      method === "GET" &&
      url.searchParams.has("slug")
    ) {
      const found = [...catalog, ...extraCatalog].find(
        (item) => item.slug === url.searchParams.get("slug"),
      );
      return found
        ? respond(route, { product: publicShape(found) })
        : respond(route, { code: "NOT_FOUND" }, 404);
    }
    if (
      ["admin/catalog/products", "catalog/products"].includes(path) &&
      method === "GET"
    )
      return respond(route, { products: [...catalog, ...extraCatalog] });
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

/** '?' 도움말 대화상자 하나를 열고, 열린 상태로 페이지 전체를 검사한 뒤 Esc로 닫음. */
async function scanHelp(page: Page, target: string, found: Map<string, string[]>) {
  const name = `Help: ${target}`;
  await page.getByRole("button", { name, exact: true }).click();
  const dialog = page.getByRole("dialog", { name, exact: true });
  await expect(dialog).toBeVisible();
  // 검사가 의미 있도록 도움말 본문이 실제로 영어로 표시돼야 함.
  await expect(dialog.locator("p").first()).toHaveText(/[A-Za-z]{3}/);
  await scan(page, `help ${target}`, found);
  await page.keyboard.press("Escape");
  await expect(dialog).toHaveCount(0);
}

/**
 * '? Help' 화면 안내를 열어 제공되는 모든 단계(다음부터 완료까지)에서 페이지를 검사하고,
 * 정확히 `steps`단계를 거쳤는지 확인해 빈 상태나 대상 누락이 통과하지 못하게 함.
 */
async function scanGuide(
  page: Page,
  menu: string,
  steps: number,
  found: Map<string, string[]>,
) {
  const open = page.getByRole("button", { name: "Screen help", exact: true });
  await expect(open).toHaveText("?Help");
  await open.click();
  const dialog = page.getByRole("dialog");
  const count = dialog.getByText(/^Step \d+ of \d+$/u);
  await expect(count).toBeVisible();
  const total = Number(/of (\d+)$/u.exec((await count.textContent()) ?? "")?.[1]);
  expect(total, menu).toBe(steps);
  for (let step = 1; step <= total; step += 1) {
    await expect(count).toHaveText(`Step ${step} of ${total}`);
    await scan(page, `guide ${menu} step ${step}`, found);
    await dialog
      .getByRole("button", { name: step === total ? "Done" : "Next", exact: true })
      .click();
  }
  await expect(dialog).toHaveCount(0);
  await expect(open).toBeFocused();
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

export { audits, setup, hangul, scan, scanHelp, scanGuide, expectClean, openSection };
