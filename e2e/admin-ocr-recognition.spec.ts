// 역할: OCR 인식 결과의 검토 행 채우기·원문 보존과 역순 응답·저장 충돌 등 오래된 비동기 응답 차단을 실제 관리자 화면과 가로챈 API로 검증함.
import { expect, test } from "@playwright/test";
import {
  OCR_ROUTE,
  JWT,
  job,
  json,
  heldResponse,
  flushResponse,
  selectFile,
  openRowDetails,
  recognize,
  adminOcrBeforeEach,
  adminOcrAfterEach,
} from "./admin-ocr-fixtures";

test.beforeEach(adminOcrBeforeEach);
test.afterEach(adminOcrAfterEach);

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
