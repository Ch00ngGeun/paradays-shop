/** Real admin UI/client with test-only session and intercepted provider API. */
import { expect, test, type Page, type Route } from "@playwright/test";

const API = "https://api.ocr.test/prod/";
const OCR_ROUTE = `${API}admin/ocr/jobs**`;
const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
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

async function recognize(page: Page, name = "A.png") {
  await selectFile(page, name);
  await page.getByRole("button", { name: "OCR로 텍스트 추출", exact: true }).click();
  await expect(
    page.getByRole("textbox", { name: "OCR 원문 텍스트", exact: true }),
  ).not.toHaveValue("");
}

test.beforeEach(async ({ page }) => {
  // All remote requests are intercepted or blocked. Fake JWT/session restore is
  // confined to the test; the production AuthProvider and connector run intact.
  await page.route("**/*", async (route) => {
    const url = new URL(route.request().url());
    if (url.hostname === "127.0.0.1") return route.continue();
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
  await page.getByRole("button", { name: "운영 메뉴 열기" }).click();
  await page.getByRole("tab", { name: "입고 OCR", exact: true }).click();
  await expect(
    page.getByRole("heading", { name: "입고 목록 OCR", exact: true }),
  ).toBeVisible();
});

test("canonical save transmits edited rawText/rows and displays immutable confidence/box", async ({
  page,
}) => {
  let saved: Record<string, unknown> | undefined;
  await page.route(OCR_ROUTE, async (route) => {
    if (route.request().method() === "OPTIONS") return json(route, {});
    expect(route.request().headers().authorization).toBe(`Bearer ${JWT}`);
    if (route.request().method() === "POST") return json(route, { job: job() }, 201);
    saved = route.request().postDataJSON();
    return json(route, {
      job: { ...job("ocr_job_A", String(saved?.rawText), 2), rows: saved?.rows },
    });
  });
  await recognize(page);
  await expect(page.getByRole("cell", { name: "94%", exact: true })).toBeVisible();
  await expect(
    page.getByRole("cell", { name: "10, 20 → 30, 20 → 30, 40 → 10, 40", exact: true }),
  ).toBeVisible();
  await page
    .getByRole("textbox", { name: "OCR 원문 텍스트", exact: true })
    .fill("  Edited raw text\nSecond line  ");
  await page
    .getByRole("textbox", { name: "상품명", exact: true })
    .fill("Reviewed product");
  await page.getByRole("button", { name: "검토 초안 저장", exact: true }).click();
  await expect(page.getByText(/서버 버전 2을 적용/)).toBeVisible();
  expect(saved?.rawText).toBe("  Edited raw text\nSecond line  ");
  expect(saved?.version).toBe(1);
  expect((saved?.rows as Record<string, unknown>[])[0]).toMatchObject({
    sourceText: "Original A",
    productName: "Reviewed product",
  });
  expect((saved?.rows as Record<string, unknown>[])[0]).not.toHaveProperty(
    "confidence",
  );
  expect((saved?.rows as Record<string, unknown>[])[0]).not.toHaveProperty("box");
  await expect(
    page.getByRole("textbox", { name: "OCR 원문 텍스트", exact: true }),
  ).toHaveValue("  Edited raw text\nSecond line  ");
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
    page.getByRole("textbox", { name: "OCR 원문 텍스트", exact: true }),
  ).toHaveValue("Newest B");
  const response = page.waitForResponse(
    (r) =>
      r.request().method() === "POST" &&
      r.request().postDataJSON().fileName === "A.png",
  );
  first.respond({ job: job("ocr_job_A", "Obsolete A") }, 201);
  await flushResponse(page, response);
  await expect(
    page.getByRole("textbox", { name: "OCR 원문 텍스트", exact: true }),
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
    page.getByRole("textbox", { name: "OCR 원문 텍스트", exact: true }),
  ).toHaveValue("Newest B");
  await expect(
    page.getByRole("button", { name: "검토 초안 저장", exact: true }),
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
  await page.getByRole("button", { name: "검토 초안 저장", exact: true }).click();
  await saveA.started;
  await recognize(page, "B.png");
  await page.getByRole("button", { name: "검토 초안 저장", exact: true }).click();
  await saveB.started;
  const response = page.waitForResponse(
    (r) => r.request().method() === "PATCH" && r.url().endsWith("ocr_job_A"),
  );
  saveA.respond({ job: job("ocr_job_A", "Obsolete save A", 2) });
  await flushResponse(page, response);
  await expect(
    page.getByRole("textbox", { name: "OCR 원문 텍스트", exact: true }),
  ).toHaveValue("Newest B");
  await expect(
    page.getByRole("button", { name: "저장 중…", exact: true }),
  ).toBeDisabled();
  saveB.respond({ job: job("ocr_job_B", "Newest B", 2) });
  await expect(
    page.getByRole("button", { name: "검토 초안 저장", exact: true }),
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
  await page.getByRole("button", { name: "검토 초안 저장", exact: true }).click();
  await save.started;
  await page
    .getByRole("textbox", { name: "OCR 원문 텍스트", exact: true })
    .fill("New unsaved draft");
  await page
    .getByRole("textbox", { name: "상품명", exact: true })
    .fill("New unsaved product");
  const response = page.waitForResponse((r) => r.request().method() === "PATCH");
  save.respond({ job: job("ocr_job_A", "Old saved content", 2) });
  await flushResponse(page, response);
  await expect(
    page.getByRole("textbox", { name: "OCR 원문 텍스트", exact: true }),
  ).toHaveValue("New unsaved draft");
  await expect(page.getByRole("textbox", { name: "상품명", exact: true })).toHaveValue(
    "New unsaved product",
  );
  await expect(
    page.getByRole("button", { name: "검토 초안 저장", exact: true }),
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
  await page.getByRole("button", { name: "검토 초안 저장", exact: true }).click();
  await latest.started;
  await page
    .getByRole("textbox", { name: "OCR 원문 텍스트", exact: true })
    .fill("Newest local draft");
  const response = page.waitForResponse(
    (r) => r.request().method() === "GET" && r.url().includes("/ocr/jobs/"),
  );
  latest.respond({ job: job("ocr_job_A", "Obsolete conflict snapshot", 5) });
  await flushResponse(page, response);
  await expect(
    page.getByRole("textbox", { name: "OCR 원문 텍스트", exact: true }),
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
  await page.getByRole("button", { name: "검토 초안 저장", exact: true }).click();
  await expect(page.getByText(/다른 관리자의 수정이 먼저 저장/)).toBeVisible();
  await expect(
    page.getByRole("textbox", { name: "OCR 원문 텍스트", exact: true }),
  ).toHaveValue("Latest server text");
  await page.getByRole("button", { name: "검토 초안 저장", exact: true }).click();
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
  await page.getByRole("button", { name: "검토 초안 저장", exact: true }).click();
  await first.started;
  await page
    .getByRole("textbox", { name: "OCR 원문 텍스트", exact: true })
    .fill("New draft to save");
  await expect(
    page.getByRole("button", { name: "검토 초안 저장", exact: true }),
  ).toBeEnabled();
  await page.getByRole("button", { name: "검토 초안 저장", exact: true }).click();
  await second.started;
  const response = page.waitForResponse(
    (r) =>
      r.request().method() === "PATCH" &&
      r.request().postDataJSON().rawText === "Original A",
  );
  first.respond({ job: job("ocr_job_A", "Old response", 2) });
  await flushResponse(page, response);
  await expect(
    page.getByRole("textbox", { name: "OCR 원문 텍스트", exact: true }),
  ).toHaveValue("New draft to save");
  await expect(
    page.getByRole("button", { name: "저장 중…", exact: true }),
  ).toBeDisabled();
  second.respond({ job: job("ocr_job_A", "New draft to save", 2) });
  await expect(
    page.getByRole("button", { name: "검토 초안 저장", exact: true }),
  ).toBeEnabled();
  await expect(page.getByText(/서버 버전 2을 적용/)).toBeVisible();
});

test("editing/converting a draft during recognition invalidates response and releases recognize state", async ({
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
  await page
    .getByRole("textbox", { name: "OCR 원문 텍스트", exact: true })
    .fill("Local manual draft");
  await page.getByRole("button", { name: "편집 행으로 변환", exact: true }).click();
  await expect(
    page.getByRole("button", { name: "OCR로 텍스트 추출", exact: true }),
  ).toBeEnabled();
  const response = page.waitForResponse(
    (r) => r.request().method() === "POST" && r.url().includes("/ocr/jobs"),
  );
  pending.respond({ job: job("ocr_job_A", "Obsolete recognition") }, 201);
  await flushResponse(page, response);
  await expect(
    page.getByRole("textbox", { name: "OCR 원문 텍스트", exact: true }),
  ).toHaveValue("Local manual draft");
  await expect(page.getByRole("textbox", { name: "상품명", exact: true })).toHaveValue(
    "Local manual draft",
  );
  await expect(
    page.getByRole("button", { name: "검토 초안 저장", exact: true }),
  ).toBeDisabled();
});
