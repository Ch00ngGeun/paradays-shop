import { expect, type Page, type Route } from "@playwright/test";
import {
  calculateTotals,
  type DayReport,
  type DaySnapshot,
  type OnlineEvent,
  type SaleEntry,
  type SalesCommand,
} from "../infra/lambda/sales-ledger-domain";

const API = "https://api.sales.test/prod/";

export const DAY = "2026-10-15";

const AS_OF = "2026-10-16T00:00:00.000Z";

export const FINGERPRINT = "a".repeat(64);

export const PREVIEW_TOKEN = "b".repeat(64);

export const NEW_ENTRY = "판매 등록 · 새 전표";

export const CLOSE_DAY = "선택일 장부 마감";

export const ACTUAL_MODE = "실제 운영 열기 · 실제 매출·일마감 열기";

const JWT = [
  Buffer.from(JSON.stringify({ alg: "none", typ: "JWT" })).toString("base64url"),
  Buffer.from(
    JSON.stringify({
      sub: "sales-synthetic-admin",
      exp: 4102444800,
      "cognito:groups": ["admin"],
    }),
  ).toString("base64url"),
  "test-only-signature",
].join(".");

export function sale(overrides: Partial<SaleEntry> = {}): SaleEntry {
  return {
    entryId: "sale_deck_001",
    businessDay: DAY,
    recordType: "SALE",
    version: 1,
    status: "DRAFT",
    kind: "SALE",
    soldAt: "2026-10-15T00:30:00.000Z",
    method: "CARD",
    reference: "CARD-001",
    amount: 10000,
    memo: "Synthetic ledger fixture",
    lines: [
      {
        productId: "prd_deck",
        name: "Deck",
        option: "8.25",
        quantity: 1,
        unitAmount: overrides.amount ?? 10000,
      },
    ],
    createdAt: AS_OF,
    updatedAt: AS_OF,
    ...overrides,
  };
}

type MockReply = { status?: number; body?: unknown; abort?: boolean };

type LedgerMock = {
  entries: SaleEntry[];
  onlineEvents: OnlineEvent[];
  warnings: string[];
  status: "OPEN" | "CLOSED";
  version: number;
  snapshots: DaySnapshot[];
  posts: SalesCommand[];
  rawPosts: string[];
  gets: number;
  stock: number;
  stockMoves: number;
  forbidden: string[];
  unexpected: string[];
};

export const audits = new WeakMap<Page, LedgerMock>();

function report(state: LedgerMock): DayReport {
  return {
    businessDay: DAY,
    timezone: "Asia/Seoul",
    version: state.version,
    status: state.status,
    asOf: AS_OF,
    entries: state.entries,
    onlineEvents: state.onlineEvents,
    totals: calculateTotals(state.entries, state.onlineEvents),
    warnings: state.warnings,
    onlineFingerprint: FINGERPRINT,
    snapshots: state.snapshots,
    history: [],
    complete: true,
  };
}

function json(route: Route, body: unknown, status = 200) {
  return route.fulfill({
    status,
    json: body,
    headers: {
      "access-control-allow-origin": "*",
      "access-control-allow-methods": "GET,POST,OPTIONS",
      "access-control-allow-headers": "authorization,content-type",
    },
  });
}

function applyCommand(state: LedgerMock, command: SalesCommand) {
  if (command.action === "preview") {
    const entry = state.entries.find((item) => item.entryId === command.entryId)!;
    return {
      preview: entry.lines.map((line) => ({
        productId: line.productId,
        name: line.name,
        quantity: state.stock,
        reserved: 1,
        available: state.stock - 1,
        delta: -line.quantity,
        after: state.stock - line.quantity,
        version: 4,
      })),
      previewToken: PREVIEW_TOKEN,
      entryId: entry.entryId,
      version: entry.version,
    };
  }
  state.version += 1;
  if (command.action === "close") {
    state.status = "CLOSED";
    state.snapshots.push({
      snapshotId: command.operationId,
      closedAt: AS_OF,
      version: state.version,
      totals: calculateTotals(state.entries, state.onlineEvents),
      onlineFingerprint: FINGERPRINT,
      cashComparedAmount: command.cashComparedAmount,
      entryManifest: "c".repeat(64),
      entryCount: state.entries.length,
      onlineEvents: state.onlineEvents,
    });
    return { report: report(state) };
  }
  if (command.action === "reopen") {
    state.status = "OPEN";
    return { report: report(state) };
  }
  let entry: SaleEntry;
  if (command.action === "save") {
    entry = sale({
      entryId: command.entryId,
      soldAt: command.soldAt,
      method: command.method,
      reference: command.reference,
      amount: command.amount,
      memo: command.memo,
      lines: command.lines,
      version: command.expectedVersion + 1,
    });
  } else if (command.action === "reverse") {
    const original = state.entries.find((item) => item.entryId === command.originalId)!;
    entry = sale({
      ...original,
      entryId: command.entryId,
      soldAt: command.soldAt,
      reference: `REV-${original.reference}`,
      status: "POSTED",
      kind: "REVERSAL",
      memo: command.reason,
      original: { businessDay: command.originalDay, entryId: command.originalId },
      restocked: command.restockInspected,
    });
    if (command.restockInspected) {
      state.stock += original.lines.reduce((sum, line) => sum + line.quantity, 0);
      state.stockMoves += 1;
    }
  } else {
    const original = state.entries.find((item) => item.entryId === command.entryId)!;
    entry = {
      ...original,
      version: original.version + 1,
      status: command.action === "post" ? "POSTED" : "VOID",
    };
    if (command.action === "post") {
      state.stock -= original.lines.reduce((sum, line) => sum + line.quantity, 0);
      state.stockMoves += 1;
    }
  }
  state.entries = [
    ...state.entries.filter((item) => item.entryId !== entry.entryId),
    entry,
  ];
  return { entry };
}

export async function openSales(page: Page, mode: "choose" | "real" = "real") {
  const tab = page.getByRole("tab", { name: "매출·일마감", exact: true });
  const menu = page.getByRole("button", { name: "운영 메뉴 열기", exact: true });
  await expect(tab.or(menu)).toBeVisible();
  if (!(await tab.isVisible())) await menu.click();
  await tab.click();
  await expect(
    page.getByRole("heading", { name: "매출·일마감 모드 선택", exact: true }),
  ).toBeVisible();
  if (mode === "choose") return;
  await page.getByRole("button", { name: ACTUAL_MODE, exact: true }).click();
  await expect(page.getByRole("heading", { name: "매출·일마감 관리" })).toBeVisible();
}

export async function loadDay(page: Page) {
  await page.getByLabel("영업일 (한국 시간)", { exact: true }).fill(DAY);
  await page.getByRole("button", { name: "장부 조회", exact: true }).click();
  await expect(
    page.getByRole("button", { name: NEW_ENTRY, exact: true }),
  ).toBeEnabled();
}

export async function setup(
  page: Page,
  options: {
    entries?: SaleEntry[];
    onlineEvents?: OnlineEvent[];
    warnings?: string[];
    mode?: "choose" | "real";
    load?: boolean;
    readReply?: MockReply;
    handle?: (command: SalesCommand, state: LedgerMock) => MockReply | undefined;
    productName?: string;
  } = {},
) {
  const state: LedgerMock = {
    entries: options.entries ?? [],
    onlineEvents: options.onlineEvents ?? [
      {
        orderId: "pd_online_001",
        kind: "APPROVAL",
        amount: 15000,
        occurredAt: "2026-10-15T01:00:00.000Z",
        timeBasis: "PROVIDER",
      },
      {
        orderId: "pd_online_002",
        kind: "REFUND",
        amount: 2000,
        occurredAt: "2026-10-15T02:00:00.000Z",
        timeBasis: "OBSERVED",
      },
    ],
    warnings: options.warnings ?? [],
    status: "OPEN",
    version: 3,
    snapshots: [],
    posts: [],
    rawPosts: [],
    gets: 0,
    stock: 10,
    stockMoves: 0,
    forbidden: [],
    unexpected: [],
  };
  audits.set(page, state);
  await page.route("**/*", async (route) => {
    const request = route.request();
    const url = new URL(request.url());
    if (
      url.origin === "http://127.0.0.1:3139" &&
      ["GET", "HEAD"].includes(request.method())
    )
      return route.continue();
    if (!request.url().startsWith(API)) {
      state.unexpected.push(`${request.method()} ${url.origin}${url.pathname}`);
      return route.abort();
    }
    if (request.method() === "OPTIONS") return json(route, {});
    if (request.method() === "GET" && url.pathname === "/prod/me")
      return json(route, { userSub: "sales-synthetic-admin", marketingConsent: false });
    if (request.method() === "GET" && url.pathname.endsWith("/admin/overview"))
      return json(route, {
        asOf: AS_OF,
        timezone: "Asia/Seoul",
        todayOrderCount: 0,
        lowStockCount: 0,
        lowStockThreshold: 3,
        activeCouponCount: 0,
        marketingConsentCount: 0,
      });
    if (request.method() === "GET" && url.pathname.endsWith("/admin/catalog/products"))
      return json(route, {
        products: [
          {
            productId: "prd_deck",
            name: options.productName ?? "Deck",
            brandName: "Synthetic Maker",
            category: "Deck",
            price: 10000,
            inventoryQuantity: state.stock,
            status: "PUBLISHED",
            featured: false,
            version: 4,
            description: ["Synthetic catalog fixture"],
            sizes: ["8.25"],
          },
        ],
      });
    if (url.pathname !== `/prod/admin/sales/${DAY}`) {
      state.forbidden.push(`${request.method()} ${url.pathname}`);
      return route.abort();
    }
    expect(request.headers().authorization).toBe(`Bearer ${JWT}`);
    if (request.method() === "GET") {
      state.gets += 1;
      if (options.readReply?.abort) return route.abort("connectionfailed");
      if (options.readReply)
        return json(
          route,
          options.readReply.body ?? {},
          options.readReply.status ?? 200,
        );
      return json(route, { report: report(state) });
    }
    if (request.method() !== "POST") {
      state.forbidden.push(`${request.method()} ${url.pathname}`);
      return route.abort();
    }
    state.rawPosts.push(request.postData()!);
    const command = request.postDataJSON() as SalesCommand;
    state.posts.push(command);
    const reply = options.handle?.(command, state);
    if (reply?.abort) return route.abort("connectionfailed");
    if (reply) return json(route, reply.body ?? {}, reply.status ?? 200);
    return json(route, applyCommand(state, command));
  });
  await page.addInitScript(
    (session) => {
      sessionStorage.setItem("paradays.auth.session", JSON.stringify(session));
      localStorage.setItem("paradays-locale", "ko");
    },
    {
      accessToken: JWT,
      expiresAt: 4102444800000,
      user: {
        sub: "sales-synthetic-admin",
        username: "synthetic-admin",
        groups: ["admin"],
      },
    },
  );
  await page.clock.setFixedTime(new Date("2026-10-15T14:00:00.000Z"));
  await page.goto("/admin");
  await openSales(page, options.mode);
  if (options.mode !== "choose" && options.load !== false) await loadDay(page);
  return state;
}

export async function newDraft(page: Page, matched: boolean) {
  await page.getByRole("button", { name: NEW_ENTRY, exact: true }).click();
  await page.getByLabel("판매일시 (한국 시간)", { exact: true }).fill(`${DAY}T09:30`);
  await page
    .getByRole("combobox", { name: "결제 구분", exact: true })
    .selectOption("CARD");
  await page.getByLabel("전표 참조번호", { exact: true }).fill("CARD-LOCAL-001");
  await page.getByLabel("전표 금액", { exact: true }).fill("10000");
  await page.getByLabel("메모", { exact: true }).fill("Synthetic manual sale");
  if (matched) {
    await page.getByLabel("상품 이름 검색", { exact: true }).fill("Deck");
    await page.getByRole("button", { name: "Deck 연결", exact: true }).click();
  } else {
    await page.getByRole("button", { name: "미매칭 줄 추가", exact: true }).click();
    await page
      .getByLabel("1번 상품명", { exact: true })
      .fill("아직 연결하지 않은 상품");
  }
  if (matched)
    await page
      .getByRole("combobox", { name: "1번 옵션", exact: true })
      .selectOption("8.25");
  else await page.getByLabel("1번 옵션", { exact: true }).fill("8.25");
  await page.getByLabel("1번 수량", { exact: true }).fill("1");
  await page.getByLabel("1번 단가", { exact: true }).fill("10000");
}
