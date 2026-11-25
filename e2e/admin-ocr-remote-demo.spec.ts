/** Real admin UI/client with test-only session and intercepted provider API. */
import { expect, test, type Page } from "@playwright/test";
import {
  API,
  OCR_ROUTE,
  REMOTE_DEMO_E2E,
  LOCAL_MODE_E2E,
  REMOTE_DEMO_API,
  REMOTE_DEMO_OCR_ROUTE,
  FIREBASE_ORIGIN,
  JWT,
  job,
  json,
  selectFile,
  selectAdminTab,
  recognize,
  adminOcrBeforeEach,
  adminOcrAfterEach,
} from "./admin-ocr-fixtures";
import {
  setupInventoryCatalogApi,
  expectedExistingIntake,
  setupInventoryReviewApi,
  inventoryApplicationPanel,
  saveInventoryReview,
  prepareInventoryApplication,
  confirmInventoryApplication,
} from "./admin-ocr-inventory-fixtures";

test.beforeEach(adminOcrBeforeEach);
test.afterEach(adminOcrAfterEach);

test("local OCR English safety keeps local-only memory and retry boundaries without contacting a relay", async ({
  page,
}) => {
  // Executed only by the approved temporary local-mode wrapper config. The
  // original OCR config remains pinned off; neither mode contacts port 8011.
  test.skip(
    !LOCAL_MODE_E2E,
    "Requires the temporary local-mode wrapper config; playwright.ocr.config.ts pins local OCR off.",
  );
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
    // The locale provider starts in English and restores the saved Korean choice after hydration.
    await expect(
      page.getByRole("button", { name: "한국어", exact: true }),
    ).toHaveAttribute("aria-pressed", "true");
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
    const englishHelp = page
      .getByRole("region", { name: "Source image", exact: true })
      .locator("details[open]");
    await expect(englishHelp).toContainText("does not store image files");
    await expect(englishHelp).toContainText(
      "shared secret stays only on the operator’s PC",
    );
    await expect(englishHelp).toContainText(
      "signed authentication token lacks the admin group",
    );
    await expect(englishHelp).toContainText("rejected (403)");
    await expect(englishHelp).toContainText("up to about 2 minutes");
    await expect(englishHelp).toContainText("times out or the connection fails");
    await expect(englishHelp).toContainText("before retrying");
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
