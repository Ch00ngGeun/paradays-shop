import { expect, test, type Page, type Locator } from "@playwright/test";
const API = "https://api.ocr.test/prod/";
const audits = new WeakMap<Page, { forbidden: string[]; unexpected: string[] }>();
async function setup(
  page: Page,
  groups: readonly string[] = ["admin"],
  anonymous = false,
) {
  const audit = { forbidden: [] as string[], unexpected: [] as string[] };
  audits.set(page, audit);
  await page.route("**/*", async (route) => {
    const url = new URL(route.request().url());
    if (
      url.origin === "http://127.0.0.1:3137" &&
      ["GET", "HEAD"].includes(route.request().method())
    )
      return route.continue();
    if (url.origin === "https://auth.ocr.test" && url.pathname === "/logout")
      return route.fulfill({
        status: 302,
        headers: { location: "http://127.0.0.1:3137/" },
      });
    if (!route.request().url().startsWith(API)) {
      audit.unexpected.push(String(url));
      return route.abort();
    }
    if (/\/(admin\/orders|checkout|payments)(\/|$)/.test(url.pathname)) {
      audit.forbidden.push(`${route.request().method()} ${url.pathname}`);
      return route.abort();
    }
    if (route.request().method() !== "GET" && route.request().method() !== "OPTIONS") {
      audit.forbidden.push(`${route.request().method()} ${url.pathname}`);
      return route.abort();
    }
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
    if (
      url.pathname.endsWith("/admin/catalog/products") ||
      url.pathname.endsWith("/catalog/products")
    )
      return json({ products: [] });
    return json({}, 404);
  });
  const token = [
    Buffer.from(JSON.stringify({ alg: "none", typ: "JWT" })).toString("base64url"),
    Buffer.from(
      JSON.stringify({
        sub: "simulation-test-user",
        exp: 4102444800,
        "cognito:groups": groups,
      }),
    ).toString("base64url"),
    "test-only-signature",
  ].join(".");
  await page.addInitScript(
    ({ session, anonymous }) => {
      if (!sessionStorage.getItem("synthetic_test_bootstrapped")) {
        if (!anonymous)
          sessionStorage.setItem("paradays.auth.session", JSON.stringify(session));
        sessionStorage.setItem("synthetic_test_bootstrapped", "yes");
      }
      localStorage.setItem("paradays-locale", "ko");
    },
    {
      session: {
        accessToken: token,
        expiresAt: 4102444800000,
        user: { sub: "simulation-test-user", username: "synthetic-user", groups },
      },
      anonymous,
    },
  );
  await page.goto("/admin");
  if (groups.includes("admin") && !anonymous) await openSimulation(page);
  return page.getByRole("region", { name: "모의 주문·재고 테스트", exact: true });
}
/** The home shows only a launcher; the test itself lives in a modal. */
async function openSimulation(page: Page) {
  await page
    .getByRole("button", { name: "모의 주문·재고 테스트", exact: true })
    .click();
  await expect(page.getByRole("dialog")).toBeVisible();
}
async function start(panel: Locator) {
  await expect(
    panel.getByRole("button", { name: "모의 테스트 시작", exact: true }),
  ).toBeDisabled();
  await panel
    .getByLabel("실제 주문·재고를 바꾸지 않는 모의 테스트임을 이해했습니다")
    .check();
  await panel.getByRole("button", { name: "모의 테스트 시작", exact: true }).click();
  await expect(panel.getByLabel("모의 주문번호", { exact: true })).toHaveText(/^TEST_/);
}
async function approve(panel: Locator) {
  await panel
    .getByRole("button", { name: "모의 승인 · 2개 차감", exact: true })
    .click();
  await expect(panel.getByLabel("테스트 재고", { exact: true })).toHaveText("8");
}
test.afterEach(async ({ page }) => {
  const audit = audits.get(page);
  if (audit) {
    expect(audit.forbidden).toEqual([]);
    expect(audit.unexpected).toEqual([]);
  }
});
test("explicit local mode: approval10→8/cancel1→9, double click/retry unchanged, deliberate second partial≤2", async ({
  page,
}) => {
  const panel = await setup(page);
  await expect(panel.getByRole("note")).toContainText(
    "실제 결제나 재고 검증 결과가 아닙니다.",
  );
  await start(panel);
  await approve(panel);
  await panel.getByRole("button", { name: "모의 미출고 확인", exact: true }).click();
  await panel
    .getByRole("button", { name: "모의 미출고 부분 취소", exact: true })
    .evaluate((button) => {
      (button as HTMLButtonElement).click();
      (button as HTMLButtonElement).click();
    });
  await expect(panel.getByLabel("테스트 재고", { exact: true })).toHaveText("9");
  await panel.getByRole("button", { name: "마지막 모의 요청 재시도" }).click();
  await expect(panel.getByLabel("테스트 재고", { exact: true })).toHaveText("9");
  await panel.getByRole("button", { name: "새 모의 부분 처리 준비" }).click();
  await panel
    .getByRole("button", { name: "모의 미출고 부분 취소", exact: true })
    .click();
  await expect(panel.getByLabel("테스트 재고", { exact: true })).toHaveText("10");
  await panel.getByRole("button", { name: "새 모의 부분 처리 준비" }).click();
  await panel
    .getByRole("button", { name: "모의 미출고 부분 취소", exact: true })
    .click();
  await expect(panel.getByRole("alert")).toContainText("아직 취소·환불하지 않은");
  await expect(panel.getByLabel("테스트 재고", { exact: true })).toHaveText("10");
});
test("shipped refund leaves8; inspection1→9; receipt replay/newoperation cannot duplicate stock", async ({
  page,
}) => {
  const panel = await setup(page);
  await start(panel);
  await approve(panel);
  await panel.getByRole("button", { name: "모의 출고 완료 확인", exact: true }).click();
  await expect(
    panel.getByRole("button", { name: "모의 미출고 확인", exact: true }),
  ).toBeDisabled();
  await panel
    .getByRole("button", { name: "모의 출고 상품 환불 · 재입고 없음", exact: true })
    .click();
  await expect(panel.getByLabel("테스트 재고", { exact: true })).toHaveText("8");
  await expect(panel.getByLabel("가상 환불 누계", { exact: true })).toHaveText("10000");
  await expect(
    panel.getByRole("button", { name: "모의 검수 수량 재입고", exact: true }),
  ).toBeDisabled();
  await panel
    .getByLabel("모의 입고·검수 완료와 재판매 가능 수량을 확인했습니다")
    .check();
  await panel
    .getByRole("button", { name: "모의 검수 수량 재입고", exact: true })
    .click();
  await expect(panel.getByLabel("테스트 재고", { exact: true })).toHaveText("9");
  await panel.getByRole("button", { name: "새 모의 부분 처리 준비" }).click();
  await panel
    .getByLabel("모의 입고·검수 완료와 재판매 가능 수량을 확인했습니다")
    .check();
  await panel
    .getByRole("button", { name: "모의 검수 수량 재입고", exact: true })
    .click();
  await expect(panel.getByRole("status", { name: "모의 처리 결과" })).toContainText(
    "같은 모의 검수 접수번호",
  );
  await expect(panel.getByLabel("테스트 재고", { exact: true })).toHaveText("9");
  await panel.getByLabel("모의 처리 수량", { exact: true }).fill("2");
  await panel
    .getByRole("textbox", { name: "모의 검수 접수번호", exact: true })
    .fill("TEST-RMA-002");
  await panel
    .getByRole("button", { name: "모의 검수 수량 재입고", exact: true })
    .click();
  await expect(panel.getByRole("alert")).toContainText("출고 수량");
  await expect(panel.getByLabel("테스트 재고", { exact: true })).toHaveText("9");
});
test("compensation changes virtual balance only and blocks excessive subsequent refunds", async ({
  page,
}) => {
  const panel = await setup(page);
  await start(panel);
  await approve(panel);
  await panel.getByRole("button", { name: "모의 미출고 확인", exact: true }).click();
  await panel
    .getByRole("spinbutton", { name: "모의 보상 환불 가상금액", exact: true })
    .fill("15000");
  await panel
    .getByRole("button", { name: "모의 보상 환불 · 재입고 없음", exact: true })
    .click();
  await expect(panel.getByLabel("테스트 재고", { exact: true })).toHaveText("8");
  await expect(panel.getByLabel("가상 환불 가능 잔액", { exact: true })).toHaveText(
    "5000",
  );
  await panel
    .getByRole("button", { name: "모의 미출고 부분 취소", exact: true })
    .click();
  await expect(panel.getByRole("alert")).toContainText("남은 환불 가능 금액을 초과");
  await expect(panel.getByLabel("테스트 재고", { exact: true })).toHaveText("8");
});
test("reset/end/refresh discard memory; no URL or storage persistence; TEST real lookup blocked", async ({
  page,
}) => {
  const panel = await setup(page);
  await start(panel);
  await approve(panel);
  const old = await panel.getByLabel("모의 주문번호", { exact: true }).textContent();
  expect(
    await page.evaluate(
      (id) =>
        [...Object.values(localStorage), ...Object.values(sessionStorage)].some(
          (value) => value.includes(id!),
        ),
      old,
    ),
  ).toBe(false);
  expect(page.url()).not.toContain(old!);
  // Closing the modal ends the test; the real order panel behind it is usable again.
  await page.keyboard.press("Escape");
  await expect(page.getByRole("dialog")).toHaveCount(0);
  const real = page.getByRole("region", {
    name: "주문 취소·반품 재고 관리",
    exact: true,
  });
  await real.getByRole("textbox", { name: "주문번호", exact: true }).fill(old!);
  await real.getByRole("button", { name: "주문 조회", exact: true }).click();
  await expect(real.getByRole("status")).toContainText("서버가 요청을 거절했습니다");
  await openSimulation(page);
  await expect(
    panel.getByRole("button", { name: "모의 테스트 시작", exact: true }),
  ).toBeDisabled();
  await expect(panel.getByLabel("모의 주문번호", { exact: true })).toHaveCount(0);
  await start(panel);
  await approve(panel);
  const again = await panel.getByLabel("모의 주문번호", { exact: true }).textContent();
  await panel.getByRole("button", { name: "모의 테스트 초기화", exact: true }).click();
  await expect(panel.getByLabel("테스트 재고", { exact: true })).toHaveText("10");
  await expect(panel.getByLabel("모의 주문번호", { exact: true })).not.toHaveText(
    again!,
  );
  await expect(
    panel.getByRole("button", { name: "마지막 모의 요청 재시도" }),
  ).toBeDisabled();
  await panel.getByRole("button", { name: "모의 테스트 종료", exact: true }).click();
  await expect(
    panel.getByRole("button", { name: "모의 테스트 시작", exact: true }),
  ).toBeDisabled();
  await start(panel);
  await approve(panel);
  await page.reload();
  await openSimulation(page);
  await expect(
    panel.getByRole("button", { name: "모의 테스트 시작", exact: true }),
  ).toBeDisabled();
  await expect(panel.getByLabel("모의 주문번호", { exact: true })).toHaveCount(0);
});
test("the mock test opens in a modal with its warnings, closes with Esc or the button and returns focus", async ({
  page,
}) => {
  await setup(page);
  const launcher = page.getByRole("button", {
    name: "모의 주문·재고 테스트",
    exact: true,
  });
  const dialog = page.getByRole("dialog");
  await expect(dialog).toContainText("모의 테스트 전용 · 실서비스 미연결");
  await expect(dialog.getByRole("note")).toContainText("서버·PG·실제 상품");
  await expect(dialog).toContainText("브라우저 메모리에서만 동작합니다.");
  await expect(
    dialog.getByLabel("실제 주문·재고를 바꾸지 않는 모의 테스트임을 이해했습니다"),
  ).not.toBeChecked();

  await page.keyboard.press("Escape");
  await expect(dialog).toHaveCount(0);
  await expect(launcher).toBeFocused();
  // Closed, nothing of the test stays on the home screen and the background works again.
  await expect(
    page.getByRole("heading", { name: "모의 주문·재고 테스트", exact: true }),
  ).toHaveCount(0);
  await expect(
    page.getByRole("textbox", { name: "주문번호", exact: true }),
  ).toBeEditable();

  await launcher.click();
  await dialog.getByRole("button", { name: "모의 테스트 닫기", exact: true }).click();
  await expect(dialog).toHaveCount(0);
  await expect(launcher).toBeFocused();
});
test("member/anonymous cannot enable local simulation through URL or stored flags", async ({
  page,
}) => {
  await setup(page, []);
  await page.evaluate(() => localStorage.setItem("simulationEnabled", "true"));
  await page.goto(
    "/admin?simulation=true&mode=test&apiUrl=https%3A%2F%2Finvalid.example",
  );
  await expect(
    page.getByRole("heading", { name: "모의 주문·재고 테스트", exact: true }),
  ).toHaveCount(0);
  await expect(
    page.getByRole("heading", { name: "관리자 권한이 없습니다", exact: true }),
  ).toBeVisible();
  await expect(
    page.getByRole("button", { name: "모의 주문·재고 테스트", exact: true }),
  ).toHaveCount(0);
  await page.evaluate(() => sessionStorage.removeItem("paradays.auth.session"));
  await page.reload();
  await expect(
    page.getByRole("heading", { name: "모의 주문·재고 테스트", exact: true }),
  ).toHaveCount(0);
});
test("logout removes the mock auth session and hides all simulation controls", async ({
  page,
}) => {
  const panel = await setup(page);
  await start(panel);
  await approve(panel);
  await page.goto("/account");
  await page.getByRole("button", { name: "로그아웃", exact: true }).click();
  await page.waitForURL("http://127.0.0.1:3137/");
  await page.goto("/admin");
  await expect(
    page.getByRole("heading", { name: "모의 주문·재고 테스트", exact: true }),
  ).toHaveCount(0);
  await expect(
    page.getByRole("button", { name: "모의 주문·재고 테스트", exact: true }),
  ).toHaveCount(0);
  expect(
    await page.evaluate(() => sessionStorage.getItem("paradays.auth.session")),
  ).toBe(null);
});
test("mobile has a distinct warning and usable non-overflowing test controls", async ({
  page,
}, info) => {
  await page.setViewportSize({ width: 390, height: 844 });
  const panel = await setup(page);
  await start(panel);
  await approve(panel);
  await expect(panel.getByRole("note")).toBeVisible();
  expect((await panel.boundingBox())!.width).toBeLessThanOrEqual(390);
  await panel.screenshot({ path: info.outputPath("simulation-mobile.png") });
});
