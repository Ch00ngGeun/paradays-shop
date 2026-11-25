// 역할: OCR 영역 드래그 매핑의 미리보기·적용·템플릿·확대/스크롤·터치·키보드 선택과 오래된 응답 차단을 실제 관리자 화면과 가로챈 API로 검증함.
import { expect, test } from "@playwright/test";
import { parseRecognitionResponse } from "../infra/lambda/paddle-ocr.js";
import { parseOcrTableRows } from "../infra/lambda/ocr-table-parser.js";
import baselineProvider from "../tests/fixtures/ocr-baseline-provider.json" with { type: "json" };
import type { OcrRegionMapping } from "../infra/lambda/ocr-table-parser.js";
import {
  TEMPLATE_KEY,
  mapping,
  OCR_ROUTE,
  syntheticPng,
  job,
  json,
  heldResponse,
  flushResponse,
  selectAdminTab,
  openRowDetails,
  openAdvancedMapping,
  recognize,
  regionTokens,
  setupRegionApi,
  imagePoint,
  dragRegion,
  setTableEnd,
  configureRegions,
  adminOcrBeforeEach,
  adminOcrAfterEach,
} from "./admin-ocr-fixtures";

test.beforeEach(adminOcrBeforeEach);
test.afterEach(adminOcrAfterEach);

test("actual approved baseline tokens map six products and 29 units through drag selection", async ({
  page,
}) => {
  const recognized = parseRecognitionResponse(baselineProvider);
  await setupRegionApi(page, "ocr_baseline", [...recognized.sourceRows!]);
  await recognize(page);
  await dragRegion(page, "productName", false, [60, 255, 620, 325]);
  await dragRegion(page, "brand", false, [680, 255, 860, 325]);
  await dragRegion(page, "option", false, [940, 255, 1260, 325]);
  await dragRegion(page, "quantity", false, [1410, 255, 1510, 325]);
  await setTableEnd(page, 730);
  await page
    .getByRole("checkbox", {
      name: "선택한 수량 영역은 금액이 아닌 실제 수량입니다",
      exact: true,
    })
    .check();
  await page.getByRole("button", { name: "영역 미리보기", exact: true }).click();
  await expect(
    page.getByText("상품 6개 · 수량 합계 29개 · 수량 미확인 0행", { exact: true }),
  ).toBeVisible();
  await expect(
    page.getByRole("region", { name: "영역 지정 미리보기 표", exact: true }),
  ).toContainText("메이플 데크");
});

test("region preview conflict loads latest canonical job and disables obsolete apply", async ({
  page,
}) => {
  const latest = job("ocr_region", "Latest canonical", 5);
  await setupRegionApi(page);
  await recognize(page);
  await configureRegions(page);
  await page.route(OCR_ROUTE, async (route) => {
    if (route.request().method() === "PATCH")
      return json(route, { code: "OCR_JOB_VERSION_CONFLICT" }, 409);
    if (route.request().method() === "GET") return json(route, { job: latest });
    return route.fallback();
  });
  await page.getByRole("button", { name: "영역 미리보기", exact: true }).click();
  await expect(page.getByRole("textbox", { name: "상품명", exact: true })).toHaveCount(
    1,
  );
  await expect(page.getByRole("textbox", { name: "상품명", exact: true })).toHaveValue(
    "Latest canonical",
  );
  await expect(
    page.getByRole("button", { name: "영역 지정 적용", exact: true }),
  ).toBeDisabled();
  await expect(page.getByRole("tabpanel").getByRole("alert")).toContainText(
    "열 지정을 다시 미리보기",
  );
});

test("saved regions refuse a mismatched image ratio without changing new selections", async ({
  page,
}) => {
  await setupRegionApi(page);
  await recognize(page);
  await configureRegions(page);
  await page.getByRole("button", { name: "현재 영역 양식 저장", exact: true }).click();
  await page.locator('input[accept="image/png,image/jpeg,image/webp"]').setInputFiles({
    name: "square.png",
    mimeType: "image/png",
    buffer: syntheticPng(800, 800),
  });
  await page.getByRole("button", { name: "OCR로 텍스트 추출", exact: true }).click();
  await expect(
    page.getByRole("textbox", { name: "상품명", exact: true }).first(),
  ).toBeVisible();
  await openAdvancedMapping(page);
  await expect(
    page.getByRole("img", { name: "입고표 영역 지정 이미지", exact: true }),
  ).toHaveJSProperty("naturalWidth", 800);
  await page.getByRole("button", { name: "영역 양식 불러오기", exact: true }).click();
  await page
    .getByRole("combobox", { name: "저장 영역 양식", exact: true })
    .selectOption({ label: "양식 1" });
  await page.getByRole("button", { name: "영역 양식 재사용", exact: true }).click();
  await expect(
    page.getByText(
      "이미지 비율이 저장된 영역 양식과 맞지 않아 재사용할 수 없습니다. 현재 영역 지정은 유지됩니다.",
      { exact: true },
    ),
  ).toBeVisible();
  await expect(
    page.getByRole("button", { name: "상품명 영역", exact: true }),
  ).toContainText("선택 필요");
  await expect(
    page.getByRole("button", { name: "영역 지정 적용", exact: true }),
  ).toBeDisabled();
});

test("four reversed/forward drag boxes preview canonical originals, apply then review save", async ({
  page,
}, testInfo) => {
  const api = await setupRegionApi(page);
  await recognize(page);
  await configureRegions(page);
  await page.getByRole("button", { name: "영역 미리보기", exact: true }).click();
  await expect(
    page.getByRole("region", { name: "영역 지정 미리보기 표", exact: true }),
  ).toContainText("Synthetic deck");
  await expect(
    page.getByText("상품 2개 · 수량 합계 5개 · 수량 미확인 0행", { exact: true }),
  ).toBeVisible();
  await expect(
    page.getByRole("textbox", { name: "상품명", exact: true }).first(),
  ).toHaveValue("");
  expect(api.current().version).toBe(1);
  const mapped = api.calls[0].mapping as OcrRegionMapping;
  expect(mapped.schemaVersion).toBe(2);
  expect(mapped.image).toEqual({ width: 1600, height: 820 });
  expect(mapped.firstRow.productName.left).toBeCloseTo(90 / 1600, 3);
  expect(mapped.firstRow.productName.right).toBeCloseTo(450 / 1600, 3);
  expect(mapped.tableBottom).toBeCloseTo(370 / 820, 3);
  expect(Object.keys(api.calls[0]).sort()).toEqual(["mapping", "preview", "version"]);
  await page
    .getByRole("region", { name: "이미지에서 영역 지정", exact: true })
    .screenshot({ path: testInfo.outputPath("drag-desktop.png") });
  page.once("dialog", (dialog) => dialog.accept());
  await page.getByRole("button", { name: "영역 지정 적용", exact: true }).click();
  await expect(
    page.getByRole("textbox", { name: "상품명", exact: true }).first(),
  ).toHaveValue("Synthetic deck");
  await expect(
    page.getByRole("textbox", { name: "수량", exact: true }).nth(1),
  ).toHaveValue("3");
  await openRowDetails(page);
  await expect(page.locator("dd").filter({ hasText: /^94%$/u })).toHaveCount(2);
  await page.getByRole("button", { name: "검토본 저장", exact: true }).click();
  await expect(
    page.getByText("서버 버전 3을 적용했습니다.", { exact: false }),
  ).toBeVisible();
  expect(api.calls[1].version).toBe(1);
  expect(api.calls[2].version).toBe(2);
});

test("missing brand and option stay blank; changing a region clears the ready preview", async ({
  page,
}) => {
  await setupRegionApi(page);
  await recognize(page);
  await configureRegions(page, true);
  await page.getByRole("button", { name: "영역 미리보기", exact: true }).click();
  await expect(
    page.getByRole("region", { name: "영역 지정 미리보기 표", exact: true }),
  ).toContainText("Synthetic wheels");
  const previewRows = page
    .getByRole("region", { name: "영역 지정 미리보기 표", exact: true })
    .locator("tbody tr");
  await expect(previewRows.first().locator("td").nth(1)).toHaveText("—");
  await expect(previewRows.first().locator("td").nth(2)).toHaveText("—");
  await dragRegion(page, "productName");
  await expect(
    page.getByRole("button", { name: "영역 지정 적용", exact: true }),
  ).toBeDisabled();
  await expect(
    page.getByRole("region", { name: "영역 지정 미리보기 표", exact: true }),
  ).toHaveCount(0);
});

test("area mapping help opens on demand; keyboard steps stay the image's description and warnings stay", async ({
  page,
}) => {
  await setupRegionApi(page);
  await recognize(page);
  const dialog = page.getByRole("dialog");
  const check = async (target: string, text: string) => {
    const help = page.getByRole("button", { name: `${target} 도움말`, exact: true });
    await help.click();
    await expect(dialog).toContainText(text);
    await page.keyboard.press("Escape");
    await expect(dialog).toHaveCount(0);
    await expect(help).toBeFocused();
  };
  // 키보드 조작 단계는 화면에서 숨겨지지만 이미지 영역의 설명으로 남음.
  await expect(
    page.getByRole("group", { name: "이미지 영역 선택", exact: true }),
  ).toHaveAccessibleDescription(
    /방향키로 이동하고 Space로 시작, Enter로 끝을 지정합니다/,
  );
  await expect(
    page.getByText("작은 글자는 확대해서 선택하세요", { exact: false }),
  ).toHaveCount(0);
  await check("이미지 영역 선택", "Space로 시작, Enter로 끝을 지정합니다");
  // 저장 템플릿 공유·개인정보 안내는 계속 보임.
  await expect(
    page.getByText("이 브라우저를 쓰는 계정들이 공유하는 설정입니다.", {
      exact: false,
    }),
  ).toBeVisible();

  await dragRegion(page, "productName");
  for (const name of ["브랜드 없음", "옵션 없음", "수량 없음"])
    await page.getByRole("button", { name, exact: true }).click();
  await expect(page.getByText("반복 간격을 알려 주세요", { exact: false })).toHaveCount(
    0,
  );
  await check("반복 간격", "두 번째 상품 위치를 지정해 반복 간격을 알려 주세요");
});

test("headerless rows without quantity require a valid aligned second-product hint", async ({
  page,
}) => {
  await setupRegionApi(page);
  await recognize(page);
  await dragRegion(page, "productName");
  for (const name of ["브랜드 없음", "옵션 없음", "수량 없음"])
    await page.getByRole("button", { name, exact: true }).click();
  await setTableEnd(page);
  await page.getByRole("button", { name: "영역 미리보기", exact: true }).click();
  await expect(page.getByRole("tabpanel").getByRole("alert")).toContainText(
    "두 번째 상품 위치",
  );
  await page.getByRole("button", { name: /^두 번째 상품 위치$/u }).click();
  const wrong = await imagePoint(page, 0.9, 335 / 820);
  await page.mouse.click(wrong.x, wrong.y);
  await expect(
    page.getByText(
      "두 번째 상품명을 첫 상품명과 같은 열에서, 첫 상품 아래와 표 끝 사이에 지정해 주세요.",
      { exact: true },
    ),
  ).toBeVisible();
  const correct = await imagePoint(page, 0.16, 335 / 820);
  await page.mouse.click(correct.x, correct.y);
  await page.getByRole("button", { name: "영역 미리보기", exact: true }).click();
  await expect(
    page.getByText("상품 2개 · 수량 합계 0개 · 수량 미확인 2행", { exact: true }),
  ).toBeVisible();
});

test("region templates persist settings only, retain old storage, reuse then delete/reset", async ({
  page,
}) => {
  await page.evaluate(
    ({ key, mapping }) =>
      localStorage.setItem(
        key,
        JSON.stringify({
          schemaVersion: 1,
          templates: [
            {
              id: "old-column",
              name: "양식 1",
              mapping,
              layout: { roles: ["productName", "brand", "option", "quantity"] },
            },
          ],
        }),
      ),
    { key: TEMPLATE_KEY, mapping },
  );
  await setupRegionApi(page);
  await recognize(page);
  await configureRegions(page);
  await page.getByRole("button", { name: "현재 영역 양식 저장", exact: true }).click();
  const stored = await page.evaluate((key) => localStorage.getItem(key), TEMPLATE_KEY);
  expect(stored).not.toMatch(
    /sourceText|rawText|imageBase64|blob:|fileName|ocr_region|Synthetic|token|confidence/u,
  );
  const saved = JSON.parse(stored!);
  expect(saved.templates).toHaveLength(2);
  expect(saved.templates[0].mapping.schemaVersion).toBe(1);
  expect(saved.templates[1]).toMatchObject({
    name: "양식 2",
    mapping: { schemaVersion: 2, image: { width: 1600, height: 820 } },
  });
  await page.reload();
  await selectAdminTab(page, "입고 OCR");
  await recognize(page, "second.png");
  await page.getByRole("button", { name: "영역 양식 불러오기", exact: true }).click();
  const templates = page.getByRole("combobox", { name: "저장 영역 양식", exact: true });
  await expect(templates.locator("option")).toHaveText(["양식 선택", "양식 2"]);
  await templates.selectOption({ label: "양식 2" });
  await page.getByRole("button", { name: "영역 양식 재사용", exact: true }).click();
  await expect(
    page.getByRole("checkbox", {
      name: "선택한 수량 영역은 금액이 아닌 실제 수량입니다",
      exact: true,
    }),
  ).not.toBeChecked();
  await expect(
    page.getByRole("button", { name: "영역 미리보기", exact: true }),
  ).toBeDisabled();
  await page
    .getByRole("checkbox", {
      name: "선택한 수량 영역은 금액이 아닌 실제 수량입니다",
      exact: true,
    })
    .check();
  await page.getByRole("button", { name: "영역 미리보기", exact: true }).click();
  await expect(
    page.getByText("상품 2개 · 수량 합계 5개 · 수량 미확인 0행", { exact: true }),
  ).toBeVisible();
  await page.getByRole("button", { name: "선택 영역 양식 삭제", exact: true }).click();
  expect(
    JSON.parse((await page.evaluate((key) => localStorage.getItem(key), TEMPLATE_KEY))!)
      .templates,
  ).toHaveLength(1);
  page.once("dialog", (dialog) => dialog.accept());
  await page.getByRole("button", { name: "전체 양식 삭제", exact: true }).click();
  expect(
    await page.evaluate((key) => localStorage.getItem(key), TEMPLATE_KEY),
  ).toBeNull();
});

test("zoom and scroll preserve normalized rectangles and mobile width", async ({
  page,
}, testInfo) => {
  await page.setViewportSize({ width: 390, height: 900 });
  await setupRegionApi(page);
  await recognize(page);
  await page
    .getByRole("combobox", { name: "이미지 확대 배율", exact: true })
    .selectOption("2");
  await page.getByRole("button", { name: "이미지 이동", exact: true }).click();
  await expect(
    page.getByRole("group", { name: "이미지 영역 선택", exact: true }),
  ).toHaveCSS("touch-action", "auto");
  await configureRegions(page);
  await expect(
    page.getByRole("button", { name: "이미지 이동", exact: true }),
  ).toHaveAttribute("aria-pressed", "false");
  await page.getByRole("button", { name: "영역 미리보기", exact: true }).click();
  await expect(
    page.getByText("상품 2개 · 수량 합계 5개 · 수량 미확인 0행", { exact: true }),
  ).toBeVisible();
  const panel = page.getByRole("region", { name: "이미지에서 영역 지정", exact: true });
  const bounds = await panel.evaluate((node) => ({
    right: node.getBoundingClientRect().right,
    width: window.innerWidth,
  }));
  expect(bounds.right).toBeLessThanOrEqual(bounds.width);
  await panel.screenshot({ path: testInfo.outputPath("drag-mobile.png") });
});

test("touch cancel and a second finger cannot commit an unintended selection", async ({
  page,
}) => {
  await page.setViewportSize({ width: 390, height: 900 });
  await setupRegionApi(page);
  await recognize(page);
  const cdp = await page.context().newCDPSession(page);
  const point = await imagePoint(page, 0.1, 0.26);
  await cdp.send("Input.dispatchTouchEvent", {
    type: "touchStart",
    touchPoints: [{ x: point.x, y: point.y, id: 1 }],
  });
  await cdp.send("Input.dispatchTouchEvent", {
    type: "touchMove",
    touchPoints: [{ x: point.x + 40, y: point.y + 10, id: 1 }],
  });
  await cdp.send("Input.dispatchTouchEvent", { type: "touchCancel", touchPoints: [] });
  await expect(
    page.getByRole("button", { name: "상품명 영역", exact: true }),
  ).toContainText("선택 필요");
  await cdp.send("Input.dispatchTouchEvent", {
    type: "touchStart",
    touchPoints: [{ x: point.x, y: point.y, id: 1 }],
  });
  await cdp.send("Input.dispatchTouchEvent", {
    type: "touchStart",
    touchPoints: [
      { x: point.x, y: point.y, id: 1 },
      { x: point.x + 40, y: point.y + 10, id: 2 },
    ],
  });
  await cdp.send("Input.dispatchTouchEvent", { type: "touchEnd", touchPoints: [] });
  await expect(
    page.getByRole("button", { name: "상품명 영역", exact: true }),
  ).toContainText("선택 필요");
  await cdp.detach();
});

test("tiny or overlapping boxes are rejected and keyboard selection works", async ({
  page,
}) => {
  await setupRegionApi(page);
  await recognize(page);
  const point = await imagePoint(page, 0.1, 0.26);
  await page.mouse.click(point.x, point.y);
  await expect(
    page.getByText("글자를 포함하도록 영역을 조금 더 크게 드래그해 주세요.", {
      exact: true,
    }),
  ).toBeVisible();
  await dragRegion(page, "productName");
  await page.getByRole("button", { name: "브랜드 영역", exact: true }).click();
  const center = await imagePoint(page, 0.15, 0.26);
  await page.mouse.move(center.x, center.y);
  await page.mouse.down();
  await page.mouse.move(center.x + 30, center.y + 8);
  await page.mouse.up();
  await expect(
    page.getByText(
      "선택 영역이 다른 항목과 겹칩니다. 각각의 글자를 나누어 지정해 주세요.",
      { exact: true },
    ),
  ).toBeVisible();
  await page.getByRole("button", { name: "전체 영역 지우기", exact: true }).click();
  const surface = page.getByRole("group", { name: "이미지 영역 선택", exact: true });
  await surface.focus();
  await surface.press("Space");
  await surface.press("ArrowRight");
  await surface.press("ArrowDown");
  await surface.press("Enter");
  await expect(
    page.getByRole("button", { name: "상품명 영역", exact: true }),
  ).toContainText("지정됨");
});

test("old preview responses cannot populate a replacement file and object URLs are revoked", async ({
  page,
}) => {
  await page.evaluate(() => {
    const create = URL.createObjectURL.bind(URL),
      revoke = URL.revokeObjectURL.bind(URL);
    const tracker = { active: [] as string[], revoked: [] as string[] };
    Object.assign(window, { ocrUrls: tracker });
    URL.createObjectURL = (blob) => {
      const url = create(blob);
      tracker.active.push(url);
      return url;
    };
    URL.revokeObjectURL = (url) => {
      tracker.active = tracker.active.filter((value) => value !== url);
      tracker.revoked.push(url);
      revoke(url);
    };
  });
  await setupRegionApi(page);
  await recognize(page);
  await configureRegions(page);
  const pending = heldResponse();
  let previewPayload: unknown;
  await page.route(OCR_ROUTE, async (route) => {
    if (route.request().method() !== "PATCH") return route.fallback();
    const body = route.request().postDataJSON();
    const { rows, ...analysis } = parseOcrTableRows(regionTokens(), body.mapping);
    previewPayload = { preview: { jobId: "ocr_region", version: 1, rows, analysis } };
    return pending.handle(route);
  });
  await page.getByRole("button", { name: "영역 미리보기", exact: true }).click();
  await pending.started;
  await recognize(page, "newfile.png");
  const response = page.waitForResponse(
    (value) => value.request().method() === "PATCH",
  );
  pending.respond(previewPayload);
  await flushResponse(page, response);
  await expect(
    page.getByRole("region", { name: "영역 지정 미리보기 표", exact: true }),
  ).toHaveCount(0);
  await expect(
    page.getByRole("button", { name: "상품명 영역", exact: true }),
  ).toContainText("선택 필요");
  await selectAdminTab(page, /^홈/u);
  const tracking = await page.evaluate(
    () => Reflect.get(window, "ocrUrls") as { active: string[]; revoked: string[] },
  );
  expect(tracking.active).toHaveLength(0);
  expect(tracking.revoked.length).toBeGreaterThan(0);
});
