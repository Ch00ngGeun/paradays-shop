/** Real admin UI/client with test-only session and intercepted provider API. */
import { expect, test, type Page } from "@playwright/test";
import {
  OCR_ROUTE,
  job,
  json,
  heldResponse,
  recognize,
  setupRegionApi,
  adminOcrBeforeEach,
  adminOcrAfterEach,
} from "./admin-ocr-fixtures";
import {
  setupInventoryCatalogApi,
  setupInventoryReviewApi,
  inventoryApplicationPanel,
} from "./admin-ocr-inventory-fixtures";

test.beforeEach(adminOcrBeforeEach);
test.afterEach(adminOcrAfterEach);

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
      "1이미지 선택 (현재 단계)",
      "2OCR 인식 (예정)",
      "3내용 검토 (예정)",
      "4검토본 저장 (예정)",
      "5입고 반영 (예정)",
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
    // Saved review completes step 4; stock application is the separate current step.
    await expect(stages.locator('[aria-current="step"]')).toContainText("입고 반영");
    await expect(stages.locator('[data-state="complete"]')).toHaveCount(4);
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

  test("screen guide skips stages not on screen yet and reaches stock application after a saved review", async ({
    page,
  }) => {
    await setupInventoryCatalogApi(page);
    await setupInventoryReviewApi(page);
    const open = page.getByRole("button", { name: "화면 도움말", exact: true });
    // The status badge and the sending notice stay beside the guide button, not behind it.
    await expect(page.locator("header").getByRole("status")).toBeVisible();
    await expect(page.getByText(/이미지는 관리자 API로 전송합니다/)).toBeVisible();
    await open.click();
    const bubble = page.getByRole("dialog");
    // No rows and no saved review yet: only the photo, read and save steps are on screen.
    await expect(bubble).toContainText("1/3단계");
    for (const title of ["사진 고르기", "글자 읽기", "확인한 내용 저장"]) {
      await expect(bubble.getByRole("heading")).toHaveText(title);
      await page.keyboard.press("ArrowRight");
    }
    await expect(bubble).toHaveCount(0);
    await expect(open).toBeFocused();

    await recognize(page, "Design rows.png", false);
    await page.getByRole("button", { name: "검토본 저장", exact: true }).click();
    await expect(
      page.getByRole("region", { name: "검토본 입고 반영", exact: true }),
    ).toBeVisible();
    await open.click();
    await expect(bubble).toContainText("1/5단계");
    for (const title of [
      "사진 고르기",
      "글자 읽기",
      "내용 고치기",
      "확인한 내용 저장",
    ]) {
      await expect(bubble.getByRole("heading")).toHaveText(title);
      await page.keyboard.press("ArrowRight");
    }
    await expect(bubble.getByRole("heading")).toHaveText("재고에 넣기");
    await expect(bubble).toContainText("5/5단계");
    await page.keyboard.press("Escape");
    await expect(bubble).toHaveCount(0);
    await expect(page.getByText(/이미지는 관리자 API로 전송합니다/)).toBeVisible();
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
