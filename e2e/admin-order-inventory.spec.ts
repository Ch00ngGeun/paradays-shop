import { expect, test, type Page } from "@playwright/test";
const API = "https://api.ocr.test/prod/";
const JWT = [
  Buffer.from(JSON.stringify({ alg: "none", typ: "JWT" })).toString("base64url"),
  Buffer.from(
    JSON.stringify({
      sub: "inventory-test-admin",
      exp: 4102444800,
      "cognito:groups": ["admin"],
    }),
  ).toString("base64url"),
  "test-only-signature",
].join(".");
function order() {
  return {
    orderId: "pd_order_001",
    status: "PAID",
    paymentStatus: "DONE",
    total: 200,
    createdAt: "2026-10-15T00:00:00Z",
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
      fulfillment: "UNCONFIRMED",
      expiresAt: "2026-10-15T00:30:00Z",
      refundedAmount: 0,
      pendingRefund: null as null | {
        operationId: string;
        amount: number;
        createdAt: string;
      },
    },
  };
}
type Order = ReturnType<typeof order>;
async function setup(
  page: Page,
  handle?: (
    body: Record<string, unknown>,
    current: Order,
  ) =>
    | Promise<{ status?: number; body?: unknown }>
    | { status?: number; body?: unknown },
) {
  const current = order();
  const posts: Record<string, unknown>[] = [];
  await page.route("**/*", async (route) => {
    const url = new URL(route.request().url());
    if (
      url.origin === "http://127.0.0.1:3137" &&
      ["GET", "HEAD"].includes(route.request().method())
    )
      return route.continue();
    if (!String(url).startsWith(API)) return route.abort();
    const json = (body: unknown, status = 200) =>
      route.fulfill({
        status,
        json: body,
        headers: {
          "access-control-allow-origin": "*",
          "access-control-allow-headers": "authorization,content-type",
        },
      });
    if (route.request().method() === "OPTIONS") return json({});
    if (url.pathname.endsWith("/admin/overview"))
      return json({
        asOf: "2026-10-15T00:00:00Z",
        timezone: "Asia/Seoul",
        todayOrderCount: 0,
        lowStockCount: 0,
        lowStockThreshold: 3,
        activeCouponCount: 0,
        marketingConsentCount: 0,
      });
    if (url.pathname.endsWith("/admin/catalog/products")) return json({ products: [] });
    if (url.pathname.endsWith("/admin/orders/pd_order_001/refunds")) {
      expect(route.request().headers().authorization).toContain("Bearer ");
      if (route.request().method() === "POST") {
        const body = route.request().postDataJSON() as Record<string, unknown>;
        posts.push(body);
        const result = await handle?.(body, current);
        if (result)
          return json(result.body ?? { order: current }, result.status ?? 200);
      }
      return json({ order: current });
    }
    return json({}, 404);
  });
  await page.addInitScript(
    (session) => {
      sessionStorage.setItem("paradays.auth.session", JSON.stringify(session));
      localStorage.setItem("paradays-locale", "ko");
    },
    {
      accessToken: JWT,
      expiresAt: 4102444800000,
      user: { sub: "inventory-test-admin", username: "test-admin", groups: ["admin"] },
    },
  );
  await page.goto("/admin");
  await expect(
    page.getByRole("heading", { name: "주문 취소·반품 재고 관리" }),
  ).toBeVisible();
  await page
    .getByRole("textbox", { name: "주문번호", exact: true })
    .fill(current.orderId);
  await page.getByRole("button", { name: "주문 조회", exact: true }).click();
  await expect(page.getByRole("heading", { name: /pd_order_001/ })).toBeVisible();
  return { current, posts };
}
test("shipment confirmation and inspected resalable return are separate from monetary refund", async ({
  page,
}) => {
  const { posts } = await setup(page, (body, current) => {
    if (body.action === "fulfillment")
      current.inventory.fulfillment = String(body.state);
    if (body.action === "return") current.lines[0]!.restoredQuantity = 1;
    return {};
  });
  await expect(
    page.getByRole("button", { name: "출고 완료 확인", exact: true }),
  ).toBeDisabled();
  await page.getByLabel("실제 출고 여부를 확인했습니다").check();
  await page.getByRole("button", { name: "출고 완료 확인", exact: true }).click();
  await expect(page.getByText(/출고 확인됨/, { exact: false })).toBeVisible();
  await page.getByRole("spinbutton", { name: "Deck 8 이번 수량" }).fill("1");
  await page.getByRole("textbox", { name: "검수 접수번호" }).fill("RMA-1-batch1");
  await expect(page.getByRole("button", { name: "검수 수량 재입고" })).toBeDisabled();
  await page
    .getByLabel("실물 입고·검수 완료 및 재판매 가능한 수량임을 확인했습니다")
    .check();
  await page.getByRole("button", { name: "검수 수량 재입고" }).click();
  await expect.poll(() => posts.filter((p) => p.action === "return").length).toBe(1);
  expect(posts[1]).toMatchObject({
    action: "return",
    receiptId: "RMA-1-batch1",
    rows: [{ line: 0, quantity: 1 }],
    resalableConfirmed: true,
  });
  expect(posts.some((p) => p.action === "refund")).toBe(false);
});
test("definite validation rejection releases editing; unknown retries preserve exact operation", async ({
  page,
}) => {
  let fail = true;
  const { posts } = await setup(page, (body, current) => {
    if (body.action === "fulfillment") current.inventory.fulfillment = "SHIPPED";
    if (body.action === "return" && fail) {
      fail = false;
      return { status: 409, body: { code: "INVENTORY_RESTORE_EXCEEDS_DEBIT" } };
    }
    if (body.action === "return")
      return { status: 503, body: { code: "ORDER_OPERATION_UNAVAILABLE" } };
    return {};
  });
  await page.getByLabel("실제 출고 여부를 확인했습니다").check();
  await page.getByRole("button", { name: "출고 완료 확인", exact: true }).click();
  await page.getByRole("spinbutton", { name: "Deck 8 이번 수량" }).fill("1");
  await page.getByRole("textbox", { name: "검수 접수번호" }).fill("RMA-2-batch1");
  await page
    .getByLabel("실물 입고·검수 완료 및 재판매 가능한 수량임을 확인했습니다")
    .check();
  await page.getByRole("button", { name: "검수 수량 재입고" }).click();
  await expect(page.getByText(/서버가 요청을 거절했습니다/)).toBeVisible();
  await expect(
    page.getByRole("button", { name: "주문 조회", exact: true }),
  ).toBeEnabled();
  await page.getByRole("button", { name: "검수 수량 재입고" }).click();
  await expect(page.getByRole("button", { name: "같은 요청 재시도" })).toBeVisible();
  await page.getByRole("button", { name: "같은 요청 재시도" }).click();
  await expect.poll(() => posts.filter((p) => p.action === "return").length).toBe(3);
  const retries = posts.filter((p) => p.action === "return");
  expect(retries[2]).toEqual(retries[1]);
});
test("compensation refund sends no stock rows and no inspection action", async ({
  page,
}) => {
  const { posts } = await setup(page, (body, current) => {
    if (body.action === "refund") {
      current.status = "REFUNDED";
      current.paymentStatus = "CANCELED";
      current.inventory.refundedAmount = 200;
    }
    return {};
  });
  await page.getByRole("textbox", { name: "환불 사유", exact: true }).fill("보상 환불");
  await page.getByRole("spinbutton", { name: "보상 환불 금액" }).fill("200");
  await page.getByLabel("처리 구분·실제 취소 수량·환불 금액을 확인했습니다").check();
  await page.getByRole("button", { name: "취소·환불 실행", exact: true }).click();
  await expect.poll(() => posts.length).toBe(1);
  expect(posts[0]).toMatchObject({
    action: "refund",
    disposition: "COMPENSATION",
    cancelAmount: 200,
    rows: [],
  });
});

test("loading another order clears prior quantities and physical/money confirmations", async ({
  page,
}) => {
  await setup(page, (body, current) => {
    if (body.action === "fulfillment") current.inventory.fulfillment = "SHIPPED";
    return {};
  });
  await page.getByLabel("실제 출고 여부를 확인했습니다").check();
  await page.getByRole("button", { name: "출고 완료 확인", exact: true }).click();
  await page.getByRole("spinbutton", { name: "Deck 8 이번 수량" }).fill("1");
  await page.getByRole("textbox", { name: "검수 접수번호" }).fill("RMA-old");
  await page
    .getByLabel("실물 입고·검수 완료 및 재판매 가능한 수량임을 확인했습니다")
    .check();
  await page
    .getByRole("textbox", { name: "환불 사유", exact: true })
    .fill("old reason");
  await page.getByLabel("처리 구분·실제 취소 수량·환불 금액을 확인했습니다").check();
  await page.route("**/admin/orders/pd_order_002/refunds", (route) =>
    route.fulfill({
      json: {
        order: {
          ...order(),
          orderId: "pd_order_002",
          inventory: { ...order().inventory, fulfillment: "SHIPPED" },
        },
      },
      headers: { "access-control-allow-origin": "*" },
    }),
  );
  await page
    .getByRole("textbox", { name: "주문번호", exact: true })
    .fill("pd_order_002");
  await page.getByRole("button", { name: "주문 조회", exact: true }).click();
  await expect(page.getByRole("heading", { name: /pd_order_002/ })).toBeVisible();
  await expect(page.getByRole("spinbutton", { name: "Deck 8 이번 수량" })).toHaveValue(
    "0",
  );
  await expect(page.getByRole("textbox", { name: "검수 접수번호" })).toHaveValue("");
  await expect(
    page.getByRole("textbox", { name: "환불 사유", exact: true }),
  ).toHaveValue("");
  await expect(
    page.getByLabel("처리 구분·실제 취소 수량·환불 금액을 확인했습니다"),
  ).not.toBeChecked();
  await expect(
    page.getByLabel("실물 입고·검수 완료 및 재판매 가능한 수량임을 확인했습니다"),
  ).not.toBeChecked();
});
test("legacy order permits monetary refund but never shipment or inspected restocking", async ({
  page,
}) => {
  await setup(page);
  let refund: Record<string, unknown> | undefined;
  await page.route("**/admin/orders/pd_order_001/refunds", async (route) => {
    if (route.request().method() === "POST") {
      refund = route.request().postDataJSON();
      await route.fulfill({
        json: {
          order: {
            ...order(),
            status: "REFUNDED",
            paymentStatus: "CANCELED",
            inventory: { ...order().inventory, state: "LEGACY", refundedAmount: 200 },
          },
        },
        headers: { "access-control-allow-origin": "*" },
      });
    } else
      await route.fulfill({
        json: { order: { ...order(), inventory: null } },
        headers: { "access-control-allow-origin": "*" },
      });
  });
  await page.getByRole("button", { name: "주문 조회", exact: true }).click();
  await expect(page.getByText(/구형 주문: 재고 차감 증빙 없음/)).toBeVisible();
  await expect(
    page.getByRole("button", { name: "출고 완료 확인", exact: true }),
  ).toBeDisabled();
  await expect(page.getByRole("button", { name: "검수 수량 재입고" })).toBeDisabled();
  await page
    .getByRole("textbox", { name: "환불 사유", exact: true })
    .fill("legacy refund");
  await page.getByRole("spinbutton", { name: "보상 환불 금액" }).fill("200");
  await page.getByLabel("처리 구분·실제 취소 수량·환불 금액을 확인했습니다").check();
  await page.getByRole("button", { name: "취소·환불 실행", exact: true }).click();
  await expect.poll(() => refund?.action).toBe("refund");
  expect(refund).toMatchObject({
    disposition: "COMPENSATION",
    cancelAmount: 200,
    rows: [],
  });
  await expect(
    page.getByText(/구형 주문 · 금액 환불만 가능 · 재입고 금지/),
  ).toBeVisible();
});
