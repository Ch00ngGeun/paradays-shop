import { expect, test, type Page, type Route } from "@playwright/test";
import {
  calculateTotals,
  type DayReport,
  type DaySnapshot,
  type OnlineEvent,
  type SaleEntry,
  type SalesCommand,
} from "../infra/lambda/sales-ledger-domain";

const API = "https://api.sales.test/prod/";
const DAY = "2026-10-15";
const AS_OF = "2026-10-16T00:00:00.000Z";
const FINGERPRINT = "a".repeat(64);
const PREVIEW_TOKEN = "b".repeat(64);
const NEW_ENTRY = "판매 등록 · 새 전표";
const CLOSE_DAY = "선택일 장부 마감";
const ACTUAL_MODE = "실제 운영 열기 · 실제 매출·일마감 열기";
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

function sale(overrides: Partial<SaleEntry> = {}): SaleEntry {
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
const audits = new WeakMap<Page, LedgerMock>();

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

async function openSales(page: Page, mode: "choose" | "real" = "real") {
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

async function loadDay(page: Page) {
  await page.getByLabel("영업일 (한국 시간)", { exact: true }).fill(DAY);
  await page.getByRole("button", { name: "장부 조회", exact: true }).click();
  await expect(
    page.getByRole("button", { name: NEW_ENTRY, exact: true }),
  ).toBeEnabled();
}

async function setup(
  page: Page,
  options: {
    entries?: SaleEntry[];
    onlineEvents?: OnlineEvent[];
    warnings?: string[];
    mode?: "choose" | "real";
    load?: boolean;
    readReply?: MockReply;
    handle?: (command: SalesCommand, state: LedgerMock) => MockReply | undefined;
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
            name: "Deck",
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

async function newDraft(page: Page, matched: boolean) {
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

test.afterEach(async ({ page }) => {
  const state = audits.get(page);
  if (state) {
    expect(state.forbidden).toEqual([]);
    expect(state.unexpected).toEqual([]);
  }
});

test("unmatched draft saves the KST time without changing stock or guessing a product", async ({
  page,
}) => {
  const state = await setup(page);
  await newDraft(page, false);
  await page.getByRole("button", { name: "초안 저장", exact: true }).click();
  await expect.poll(() => state.posts.length).toBe(1);
  expect(state.posts[0]).toMatchObject({
    action: "save",
    expectedVersion: 0,
    method: "CARD",
    reference: "CARD-LOCAL-001",
    amount: 10000,
    lines: [
      {
        productId: null,
        name: "아직 연결하지 않은 상품",
        quantity: 1,
        unitAmount: 10000,
      },
    ],
  });
  const save = state.posts[0]!;
  expect(save.action).toBe("save");
  if (save.action === "save")
    expect(new Date(save.soldAt).toISOString()).toBe("2026-10-15T00:30:00.000Z");
  expect(state.entries[0]?.status).toBe("DRAFT");
  expect(state.stock).toBe(10);
  expect(state.stockMoves).toBe(0);
  await expect(
    page.getByRole("button", { name: "판매 확정·재고 반영", exact: true }),
  ).toHaveCount(0);
  const discard = page.getByRole("button", { name: "초안 폐기", exact: true });
  await expect(discard).toBeDisabled();
  await page.getByLabel("보류 전표 폐기 사유", { exact: true }).fill("중복 수기 초안");
  await discard.click();
  await expect.poll(() => state.entries[0]?.status).toBe("VOID");
  expect(state.posts[1]).toMatchObject({
    action: "void",
    reason: "중복 수기 초안",
    version: 1,
  });
  expect(state.stock).toBe(10);
  expect(state.stockMoves).toBe(0);
});

test("matched sale needs a stock preview and explicit confirmation before a single stock debit", async ({
  page,
}) => {
  const state = await setup(page);
  await newDraft(page, true);
  await page.getByRole("button", { name: "초안 저장", exact: true }).click();
  await expect.poll(() => state.entries.length).toBe(1);
  expect(state.stockMoves).toBe(0);
  const post = page.getByRole("button", { name: "판매 확정·재고 반영", exact: true });
  await expect(post).toHaveCount(0);
  await page.getByRole("button", { name: "재고 반영 미리보기", exact: true }).click();
  await expect
    .poll(() => state.posts.filter((item) => item.action === "preview").length)
    .toBe(1);
  await expect(post).toBeDisabled();
  expect(state.stock).toBe(10);
  await page
    .getByLabel("상품·옵션·수량과 재고 변동을 확인했습니다", { exact: true })
    .check();
  await post.click();
  await expect.poll(() => state.stock).toBe(9);
  expect(state.stockMoves).toBe(1);
  expect(state.posts.find((item) => item.action === "post")).toMatchObject({
    action: "post",
    entryId: state.entries[0]!.entryId,
    version: 1,
    previewToken: PREVIEW_TOKEN,
    confirmed: true,
  });
  await page.getByLabel("현금 순매출 수기 대조액", { exact: true }).fill("0");
  await page
    .getByLabel("온라인·오프라인 매출과 경고를 모두 확인했습니다", { exact: true })
    .check();
  await page.getByRole("button", { name: CLOSE_DAY, exact: true }).click();
  await expect.poll(() => state.status).toBe("CLOSED");
  expect(state.posts.map((command) => command.action)).toEqual([
    "save",
    "preview",
    "post",
    "close",
  ]);
  expect(state.stock).toBe(9);
  expect(state.stockMoves).toBe(1);
});

test("entries render in sale-time order with Korean times even in an American browser", async ({
  page,
}) => {
  await setup(page, {
    entries: [
      sale({
        entryId: "sale_late_001",
        reference: "CARD-LATE",
        soldAt: "2026-10-15T11:45:00.000Z",
      }),
      sale({
        entryId: "sale_early_001",
        reference: "CARD-EARLY",
        soldAt: "2026-10-14T15:05:00.000Z",
      }),
      sale({
        entryId: "sale_middle_001",
        reference: "CARD-MIDDLE",
        soldAt: "2026-10-15T00:30:00.000Z",
      }),
    ],
  });
  const choices = page.locator('button[aria-label$=" 전표 선택"]');
  await expect(choices).toHaveCount(3);
  expect(
    await choices.evaluateAll((buttons) =>
      buttons.map((button) => button.getAttribute("aria-label")),
    ),
  ).toEqual([
    "이어서 작성 · sale_early_001 전표 선택",
    "이어서 작성 · sale_middle_001 전표 선택",
    "이어서 작성 · sale_late_001 전표 선택",
  ]);
  await page
    .getByRole("button", {
      name: "이어서 작성 · sale_early_001 전표 선택",
      exact: true,
    })
    .click();
  await expect(page.getByLabel("판매일시 (한국 시간)", { exact: true })).toHaveValue(
    `${DAY}T00:05`,
  );
  await page
    .getByRole("button", { name: "이어서 작성 · sale_late_001 전표 선택", exact: true })
    .click();
  await expect(page.getByLabel("판매일시 (한국 시간)", { exact: true })).toHaveValue(
    `${DAY}T20:45`,
  );
});

test("money-only reversal and physically inspected restocking require separate choices", async ({
  page,
}) => {
  const state = await setup(page, {
    entries: [
      sale({ entryId: "sale_money_001", reference: "CARD-MONEY", status: "POSTED" }),
      sale({ entryId: "sale_stock_001", reference: "CARD-STOCK", status: "POSTED" }),
    ],
  });
  await page
    .getByRole("button", { name: "상세 · sale_money_001 전표 선택", exact: true })
    .click();
  await page.getByLabel("반대전표 사유", { exact: true }).fill("금액만 환불 기록");
  await page
    .getByLabel("반대전표 판매일시 (한국 시간)", { exact: true })
    .fill(`${DAY}T13:00`);
  const reverse = page.getByRole("button", { name: "반대전표 기록", exact: true });
  await expect(reverse).toBeDisabled();
  await page
    .getByLabel("원전표 전체 금액의 반대전표임을 확인했습니다", { exact: true })
    .check();
  await reverse.click();
  await expect
    .poll(() => state.posts.filter((item) => item.action === "reverse").length)
    .toBe(1);
  expect(state.posts[0]).toMatchObject({
    action: "reverse",
    originalId: "sale_money_001",
    restockInspected: false,
    confirmed: true,
  });
  expect(state.stock).toBe(10);
  await page
    .getByRole("button", { name: "상세 · sale_stock_001 전표 선택", exact: true })
    .click();
  await expect(
    page.getByLabel("원전표 전체 금액의 반대전표임을 확인했습니다", { exact: true }),
  ).not.toBeChecked();
  await expect(
    page.getByLabel("실물 입고·검수 완료 및 재판매 가능을 확인했습니다", {
      exact: true,
    }),
  ).not.toBeChecked();
  await page.getByLabel("반대전표 사유", { exact: true }).fill("실물 입고·검수 완료");
  await page
    .getByLabel("반대전표 판매일시 (한국 시간)", { exact: true })
    .fill(`${DAY}T14:00`);
  await page
    .getByLabel("실물 입고·검수 완료 및 재판매 가능을 확인했습니다", { exact: true })
    .check();
  await page
    .getByLabel("원전표 전체 금액의 반대전표임을 확인했습니다", { exact: true })
    .check();
  await reverse.click();
  await expect.poll(() => state.stock).toBe(11);
  expect(state.stockMoves).toBe(1);
  expect(state.posts[1]).toMatchObject({
    action: "reverse",
    originalId: "sale_stock_001",
    restockInspected: true,
    confirmed: true,
  });
});

test("day close is blocked by ledger warnings and requires cash comparison; reopening needs a reason", async ({
  page,
}) => {
  const state = await setup(page, {
    entries: [sale({ method: "CASH", status: "POSTED" })],
    warnings: ["UNPOSTED_SALES"],
  });
  const close = page.getByRole("button", { name: CLOSE_DAY, exact: true });
  await page.getByLabel("현금 순매출 수기 대조액", { exact: true }).fill("10000");
  await expect(
    page.getByLabel("온라인·오프라인 매출과 경고를 모두 확인했습니다", { exact: true }),
  ).toBeDisabled();
  await expect(close).toBeDisabled();
  expect(state.posts).toEqual([]);
  state.warnings = [];
  await loadDay(page);
  await page.getByLabel("현금 순매출 수기 대조액", { exact: true }).fill("10000");
  await page
    .getByLabel("온라인·오프라인 매출과 경고를 모두 확인했습니다", { exact: true })
    .check();
  await close.click();
  await expect.poll(() => state.status).toBe("CLOSED");
  expect(state.posts[0]).toMatchObject({
    action: "close",
    expectedVersion: 3,
    onlineFingerprint: FINGERPRINT,
    cashComparedAmount: 10000,
    confirmed: true,
  });
  const reopen = page.getByRole("button", { name: "마감 재개방", exact: true });
  await expect(reopen).toBeDisabled();
  await page.getByLabel("재개방 사유", { exact: true }).fill("마감 뒤 전표 확인");
  await reopen.click();
  await expect.poll(() => state.status).toBe("OPEN");
  expect(state.posts[1]).toMatchObject({
    action: "reopen",
    expectedVersion: 4,
    reason: "마감 뒤 전표 확인",
  });
});

test("unknown save locks writes and retries the identical request before releasing the lock", async ({
  page,
}) => {
  let failed = false;
  const state = await setup(page, {
    handle: (command) => {
      if (command.action === "save" && !failed) {
        failed = true;
        return { status: 503, body: { code: "SALES_OPERATION_UNAVAILABLE" } };
      }
    },
  });
  await newDraft(page, false);
  await page.getByRole("button", { name: "초안 저장", exact: true }).click();
  await expect(
    page.getByRole("button", { name: "같은 요청 재시도", exact: true }),
  ).toBeVisible();
  await expect(page.getByRole("region", { name: "미확정 요청 보호" })).toBeVisible();
  await expect(
    page.getByRole("heading", { name: "처리 결과 확인 필요", exact: true }),
  ).toBeVisible();
  await expect(
    page.getByRole("button", { name: "모드 선택으로 돌아가기", exact: true }),
  ).toBeDisabled();
  await expect(
    page.getByRole("button", { name: NEW_ENTRY, exact: true }),
  ).toBeDisabled();
  await expect(
    page.getByRole("button", { name: "초안 저장", exact: true }),
  ).toBeDisabled();
  await expect(page.getByLabel("전표 금액", { exact: true })).toBeDisabled();
  await page.getByRole("button", { name: "같은 요청 재시도", exact: true }).click();
  await expect.poll(() => state.posts.length).toBe(2);
  expect(state.rawPosts[1]).toBe(state.rawPosts[0]);
  expect(state.posts[1]).toEqual(state.posts[0]);
  await expect(
    page.getByRole("button", { name: NEW_ENTRY, exact: true }),
  ).toBeEnabled();
  expect(state.entries).toHaveLength(1);
  expect(state.stockMoves).toBe(0);
});

function metric(page: Page, label: string) {
  return page
    .getByRole("article")
    .filter({ has: page.getByText(label, { exact: true }) });
}

async function expectNoDocumentOverflow(page: Page) {
  expect(
    await page.evaluate(
      () =>
        document.documentElement.scrollWidth <=
        document.documentElement.clientWidth + 1,
    ),
  ).toBe(true);
}

test("sales redesign: choosing or practising never reads or writes the actual ledger", async ({
  page,
}) => {
  const state = await setup(page, { mode: "choose" });
  const practice = page.getByRole("button", {
    name: "모의 매출·일마감 체험",
    exact: true,
  });
  await expect(practice).toBeDisabled();
  expect(state.gets).toBe(0);
  expect(state.posts).toEqual([]);
  await page
    .getByLabel("실제 장부와 재고를 바꾸지 않는 모의 체험임을 확인했습니다", {
      exact: true,
    })
    .check();
  await practice.click();
  await expect(
    page.getByRole("region", { name: "모의 매출·일마감", exact: true }),
  ).toContainText("연습 중 · 실제 변경 없음");
  await expect(
    page.getByRole("heading", { name: "모의 매출·일마감 체험", exact: true }),
  ).toBeVisible();
  await page.getByRole("button", { name: "카드 예시 불러오기", exact: true }).click();
  expect(state.gets).toBe(0);
  expect(state.posts).toEqual([]);
  expect(state.stockMoves).toBe(0);
  await page.getByRole("button", { name: "모의 체험 종료", exact: true }).click();
  await expect(
    page.getByRole("heading", { name: "매출·일마감 모드 선택", exact: true }),
  ).toBeVisible();
  await expect(practice).toBeDisabled();
  await page.getByRole("button", { name: ACTUAL_MODE, exact: true }).click();
  await expect(
    page.getByRole("heading", { name: "매출·일마감 관리", exact: true }),
  ).toBeVisible();
  expect(state.gets).toBe(0);
  expect(state.posts).toEqual([]);
  await loadDay(page);
  expect(state.gets).toBe(1);
  expect(state.posts).toEqual([]);
});

test("sales redesign: desktop cards show server net totals and keep closing beside the ledger", async ({
  page,
}, testInfo) => {
  await page.setViewportSize({ width: 1440, height: 1000 });
  const state = await setup(page, {
    entries: [
      sale({
        entryId: "sale_card_001",
        reference: "CARD-NET-001",
        status: "POSTED",
        amount: 10000,
      }),
      sale({
        entryId: "sale_card_refund",
        reference: "CARD-REFUND-001",
        status: "POSTED",
        kind: "REVERSAL",
        amount: 2000,
        original: { businessDay: "2026-10-14", entryId: "sale_card_original" },
        restocked: false,
      }),
      sale({
        entryId: "sale_cash_001",
        reference: "CASH-NET-001",
        status: "POSTED",
        method: "CASH",
        amount: 7000,
      }),
      sale({
        entryId: "sale_cash_refund",
        reference: "CASH-REFUND-001",
        status: "POSTED",
        method: "CASH",
        kind: "REVERSAL",
        amount: 1000,
        original: { businessDay: "2026-10-14", entryId: "sale_cash_original" },
        restocked: false,
      }),
      sale({ entryId: "sale_unposted_001", status: "DRAFT", amount: 99999 }),
      sale({ entryId: "sale_void_001", status: "VOID", amount: 88888 }),
    ],
  });
  const expected = {
    "온라인 순매출": 13000,
    "오프라인 카드 순매출": 8000,
    "오프라인 현금 순매출": 6000,
    "통합 순매출": 27000,
  };
  for (const [label, amount] of Object.entries(expected)) {
    const card = metric(page, label);
    await expect(card).toBeVisible();
    await expect(card.locator("strong")).toHaveText(
      `${amount.toLocaleString("ko-KR")}원`,
    );
  }
  await page.getByText("확정 매출 대조표·집계 기준", { exact: true }).click();
  const totals = page.getByRole("table", {
    name: "확정 매출 대조표 · 원화",
    exact: true,
  });
  await expect(
    totals.getByRole("row", {
      name: "오프라인 카드 10,000원 2,000원 8,000원",
      exact: true,
    }),
  ).toBeVisible();
  await expect(
    totals.getByRole("row", {
      name: "오프라인 현금 7,000원 1,000원 6,000원",
      exact: true,
    }),
  ).toBeVisible();
  await expect(
    totals.getByRole("row", {
      name: "온·오프라인 통합 32,000원 5,000원 27,000원",
      exact: true,
    }),
  ).toBeVisible();
  await page.getByText("확정 매출 대조표·집계 기준", { exact: true }).click();
  const ledger = page
    .getByRole("heading", { name: "오프라인 전표 · 판매 시간순", exact: true })
    .locator("xpath=ancestor::section[1]");
  const close = page.getByRole("region", { name: "일마감", exact: true });
  const ledgerBox = await ledger.boundingBox();
  const closeBox = await close.boundingBox();
  expect(ledgerBox).not.toBeNull();
  expect(closeBox).not.toBeNull();
  expect(closeBox!.x).toBeGreaterThan(ledgerBox!.x + ledgerBox!.width - 1);
  expect(Math.abs(closeBox!.y - ledgerBox!.y)).toBeLessThan(32);
  await expectNoDocumentOverflow(page);
  await page.screenshot({
    path: testInfo.outputPath("sales-redesign-desktop-1440.png"),
    fullPage: true,
  });
  await close.screenshot({
    path: testInfo.outputPath("sales-redesign-desktop-close-1440.png"),
  });
  expect(state.posts).toEqual([]);
  expect(state.stockMoves).toBe(0);
});

test("sales redesign: draft and unresolved online warnings remain visible and prevent closing", async ({
  page,
}) => {
  const state = await setup(page, {
    entries: [sale({ entryId: "sale_pending_001", status: "DRAFT" })],
  });
  await expect(page.getByTestId("ledger-entry-sale_pending_001")).toContainText(
    "보류 초안",
  );
  await page.getByLabel("현금 순매출 수기 대조액", { exact: true }).fill("0");
  const acknowledged = page.getByLabel(
    "온라인·오프라인 매출과 경고를 모두 확인했습니다",
    { exact: true },
  );
  await acknowledged.check();
  await expect(
    page.getByRole("button", { name: CLOSE_DAY, exact: true }),
  ).toBeDisabled();
  expect(state.posts).toEqual([]);
  state.entries = [sale({ entryId: "sale_pending_001", status: "POSTED" })];
  state.warnings = ["ONLINE_PAYMENT_RESULT_PENDING"];
  await loadDay(page);
  await expect(page.getByTestId("ledger-entry-sale_pending_001")).toContainText("확정");
  await expect(page.getByLabel("마감 경고", { exact: true })).toContainText(
    "온라인 결제 결과가 확인 대기 중입니다",
  );
  await expect(acknowledged).toBeDisabled();
  await expect(
    page.getByRole("button", { name: CLOSE_DAY, exact: true }),
  ).toBeDisabled();
  expect(state.posts).toEqual([]);
  expect(state.stockMoves).toBe(0);
});

test("sales redesign: an empty successful report shows zero rather than fabricated sales", async ({
  page,
}) => {
  const state = await setup(page, { onlineEvents: [] });
  for (const label of [
    "온라인 순매출",
    "오프라인 카드 순매출",
    "오프라인 현금 순매출",
    "통합 순매출",
  ])
    await expect(metric(page, label).locator("strong")).toHaveText("0원");
  await expect(
    page.getByText("등록된 전표가 없습니다.", { exact: true }),
  ).toBeVisible();
  await expect(page.getByRole("button", { name: / 전표 선택$/ })).toHaveCount(0);
  expect(state.posts).toEqual([]);
  expect(state.stockMoves).toBe(0);
});

test("sales redesign: a failed query does not replace missing totals with zero or allow closing", async ({
  page,
}) => {
  const state = await setup(page, {
    load: false,
    readReply: { status: 503, body: { code: "SALES_OPERATION_UNAVAILABLE" } },
  });
  await page.getByLabel("영업일 (한국 시간)", { exact: true }).fill(DAY);
  await page.getByRole("button", { name: "장부 조회", exact: true }).click();
  await expect(
    page.getByRole("status").filter({ hasText: "장부를 조회하지 못했습니다" }),
  ).toBeVisible();
  await expect(metric(page, "통합 순매출")).toHaveCount(0);
  await expect(page.getByRole("button", { name: CLOSE_DAY, exact: true })).toHaveCount(
    0,
  );
  await expect(page.getByRole("button", { name: NEW_ENTRY, exact: true })).toHaveCount(
    0,
  );
  expect(state.gets).toBe(1);
  expect(state.posts).toEqual([]);
});

test("sales redesign: mobile ledger and editor reflow at 375 and 320 with usable controls", async ({
  page,
}, testInfo) => {
  await page.setViewportSize({ width: 375, height: 900 });
  const state = await setup(page, {
    entries: [
      sale({ entryId: "sale_mobile_001", reference: "CARD-MOBILE", status: "POSTED" }),
    ],
  });
  await expectNoDocumentOverflow(page);
  await page.screenshot({
    path: testInfo.outputPath("sales-redesign-mobile-375.png"),
    fullPage: true,
  });
  await page.getByRole("region", { name: "일마감", exact: true }).screenshot({
    path: testInfo.outputPath("sales-redesign-mobile-close-375.png"),
  });
  await newDraft(page, true);
  const panel = page.getByRole("region", { name: "매출·일마감 관리", exact: true });
  for (const width of [375, 320]) {
    await page.setViewportSize({ width, height: 900 });
    await expectNoDocumentOverflow(page);
    for (const name of [NEW_ENTRY, "초안 저장", "미매칭 줄 추가", CLOSE_DAY])
      expect(
        (await panel.getByRole("button", { name, exact: true }).boundingBox())?.height,
      ).toBeGreaterThanOrEqual(44);
    for (const label of [
      "영업일 (한국 시간)",
      "판매일시 (한국 시간)",
      "전표 참조번호",
      "전표 금액",
      "현금 순매출 수기 대조액",
    ])
      expect(
        (await panel.getByLabel(label, { exact: true }).boundingBox())?.height,
      ).toBeGreaterThanOrEqual(44);
  }
  await page.screenshot({
    path: testInfo.outputPath("sales-redesign-mobile-editor-320.png"),
    fullPage: true,
  });
  await page.getByRole("region", { name: "일마감", exact: true }).screenshot({
    path: testInfo.outputPath("sales-redesign-mobile-close-320.png"),
  });
  await expect(page.getByLabel("1번 상품명", { exact: true })).toHaveValue("Deck");
  expect(state.posts).toEqual([]);
  expect(state.stockMoves).toBe(0);
});

test("unknown operation survives refresh; a report read alone cannot unlock a new write", async ({
  page,
}) => {
  const state = await setup(page, {
    handle: (command) => (command.action === "save" ? { abort: true } : undefined),
  });
  await newDraft(page, false);
  await page.getByRole("button", { name: "초안 저장", exact: true }).click();
  await expect(
    page.getByRole("button", { name: "결과 재조회", exact: true }),
  ).toBeVisible();
  await page.reload();
  await openSales(page);
  await expect(
    page.getByRole("button", { name: "결과 재조회", exact: true }),
  ).toBeVisible();
  await expect(page.getByRole("button", { name: NEW_ENTRY, exact: true })).toHaveCount(
    0,
  );
  const unlock = page.getByRole("button", {
    name: "미확정 요청 잠금 해제",
    exact: true,
  });
  await expect(unlock).toBeDisabled();
  const beforeRead = state.gets;
  await page.getByRole("button", { name: "결과 재조회", exact: true }).click();
  await expect.poll(() => state.gets).toBeGreaterThan(beforeRead);
  await expect(
    page.getByRole("button", { name: NEW_ENTRY, exact: true }),
  ).toBeDisabled();
  await expect(unlock).toBeDisabled();
  await page
    .getByLabel("재조회한 장부에서 처리 결과를 직접 확인했습니다", { exact: true })
    .check();
  await unlock.click();
  await expect(
    page.getByRole("button", { name: NEW_ENTRY, exact: true }),
  ).toBeEnabled();
  expect(state.posts).toHaveLength(1);
  expect(state.stockMoves).toBe(0);
});
