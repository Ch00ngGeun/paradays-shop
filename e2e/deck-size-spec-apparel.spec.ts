// 역할: 의류·휠 사이즈표의 저장·도면 전환·모바일 배치와 상점의 사이즈별 값·기본값 대체·범주별 차트 선택을 검증함.
import { expect, test } from "@playwright/test";
import {
  API,
  DECK,
  SPEC,
  respond,
  setup,
  editDeck,
  chipNames,
  chip,
  TOP,
  topProduct,
  fillTop,
  storefrontChart,
} from "./deck-size-spec-fixtures";

test("a top saves its default and option charts with their own bodies, renames an option and explains a reserved rename", async ({
  page,
}) => {
  const audit = await setup(page, "/admin?section=products", undefined, topProduct());
  const item = audit.store.find((entry) => entry.productId === DECK.id)!;
  await editDeck(page);
  await expect(page.getByText("반팔 · 미등록")).toBeVisible();
  // 의류 칩도 이제 데크 칩처럼 자기 차트를 엶.
  await expect(chip(page, "M")).toBeVisible();

  await page.getByRole("button", { name: "+ 상세사이즈 등록" }).click();
  const dialog = page.getByRole("dialog");
  await expect(dialog.getByRole("combobox", { name: "도면 종류" })).toHaveValue(
    "shortSleeve",
  );
  await expect(
    dialog.getByRole("button", { name: "저장", exact: true }),
  ).toBeDisabled();
  await fillTop(dialog, TOP);
  await expect(dialog).toContainText('(28.3")');
  await expect(dialog.locator("svg")).toContainText("72cm");
  await dialog.getByRole("button", { name: "저장", exact: true }).click();
  await expect(dialog).toBeHidden();
  expect(audit.patches).toEqual([
    { version: 3, sizeChart: { kind: "shortSleeve", values: TOP } },
  ]);
  await expect(page.getByText('반팔 · 총장 72cm (28.3")')).toBeVisible();

  let refusal: string | null = "CATALOG_PRODUCT_RESERVED";
  await page.route(`${API}admin/catalog/products/*`, (route) =>
    route.request().method() === "PATCH" && refusal
      ? respond(route, { code: refusal }, 409)
      : route.fallback(),
  );
  const option = { ...TOP, length: 74 };
  await chip(page, "M").click();
  await expect(dialog.getByRole("heading")).toContainText("· M");
  await expect(dialog.getByRole("combobox", { name: "도면 종류" })).toBeDisabled();
  await expect(dialog).toContainText("이 옵션은 지금 기본값을 표시합니다.");
  await fillTop(dialog, option);
  await dialog.getByRole("textbox", { name: "옵션 이름" }).fill("L");
  const save = dialog.getByRole("button", { name: "저장", exact: true });
  await save.click();
  await expect(dialog.getByRole("alert")).toContainText(
    "결제 대기 중인 주문이 있어 지금은 옵션 이름을 바꿀 수 없습니다.",
  );
  refusal = null;
  await save.click();
  await expect(dialog).toBeHidden();
  expect(audit.patches.at(-1)).toEqual({
    version: 4,
    size: "M",
    sizeName: "L",
    sizeChartValues: option,
  });
  expect(item.sizeChartsBySize).toEqual({ L: option });
  await expect(chipNames(page)).toHaveText(["S", "L"]);
  await expect(page.getByRole("list", { name: "추가된 옵션" })).toContainText("L상세");
  await expect(page.getByText(/기본 총장 72cm \(28\.3"\) · 옵션별 1개/)).toBeVisible();

  // 다음 상품 저장은 바꾼 칩 이름을 되돌리지 않고 그대로 보냄.
  page.once("dialog", (prompt) => void prompt.accept());
  await page.getByRole("button", { name: /수정 저장/ }).click();
  await expect(page.getByText("상품을 공개 상태로 저장했습니다")).toBeVisible();
  expect(audit.patches.at(-1)).toMatchObject({ version: 5, sizes: "S, L" });
  expect(audit.blocked).toEqual([]);
});

test("switching the drawing asks first, keeps focus through cancel, failure and success, and clears every value", async ({
  page,
}) => {
  const audit = await setup(
    page,
    "/admin?section=products",
    undefined,
    topProduct({
      sizeChart: { kind: "shortSleeve", values: TOP },
      sizeChartKind: "shortSleeve",
      sizeChartsBySize: { M: TOP },
    }),
  );
  const item = audit.store.find((entry) => entry.productId === DECK.id)!;
  await editDeck(page);
  await page.getByRole("button", { name: "상세사이즈 수정" }).click();
  const dialog = page.getByRole("dialog");
  const kind = dialog.getByRole("combobox", { name: "도면 종류" });
  // 무엇이든 전송 중인 동안 제출 버튼은 "저장 중…"으로 표시됨.
  const save = dialog.locator('button[type="submit"]');
  const remove = dialog.getByRole("button", { name: "삭제", exact: true });

  await kind.selectOption("raglanLongSleeve");
  await expect(dialog.getByRole("alert")).toContainText(
    "도면 종류를 '래글런 긴팔'(으)로 바꾸면 기본값과 옵션별로 입력한 상세사이즈가 모두 지워집니다.",
  );
  await expect(save).toBeDisabled();
  await expect(remove).toBeDisabled();
  await dialog.getByRole("button", { name: "그대로 두기" }).click();
  await expect(kind).toBeFocused();
  await expect(kind).toHaveValue("shortSleeve");
  await expect(dialog.getByRole("textbox", { name: "총장" })).toHaveValue("72");

  // 붙잡았다가 실패한 전환: Esc로 닫히지 않고 그동안 다른 것도 보낼 수 없음.
  let release = () => {};
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  let fail = true;
  await page.route(`${API}admin/catalog/products/*`, async (route) => {
    if (route.request().method() !== "PATCH" || !fail) return route.fallback();
    await gate;
    return respond(route, { code: "CATALOG_STORAGE_UNAVAILABLE" }, 503);
  });
  await kind.selectOption("raglanLongSleeve");
  const change = dialog.getByRole("button", { name: "바꾸고 지우기" });
  await change.click();
  await page.keyboard.press("Escape");
  await expect(dialog).toBeVisible();
  await expect(save).toBeDisabled();
  await expect(remove).toBeDisabled();
  await expect(kind).toBeDisabled();
  release();
  await expect(dialog.getByRole("alert").last()).toContainText("저장하지 못했습니다");
  await expect(change).toBeFocused();
  expect(item.sizeChart).toEqual({ kind: "shortSleeve", values: TOP });

  fail = false;
  await change.click();
  // 양식은 새 도면의 필드로 다시 시작하고 포커스는 도면 선택에 있음.
  await expect(dialog.getByRole("textbox", { name: "화장" })).toHaveValue("");
  await expect(kind).toHaveValue("raglanLongSleeve");
  await expect(kind).toBeFocused();
  await expect(dialog.getByRole("textbox", { name: "소매통" })).toHaveCount(0);
  await expect(dialog.getByRole("button", { name: "삭제", exact: true })).toHaveCount(
    0,
  );
  expect(audit.patches).toEqual([{ version: 3, sizeChartKind: "raglanLongSleeve" }]);
  expect(item.sizeChart).toBeUndefined();
  expect(item.sizeChartsBySize).toBeUndefined();

  // 모달을 연 때의 도면으로 되돌아가도 새 양식에 포커스가 감.
  await kind.selectOption("shortSleeve");
  await dialog.getByRole("button", { name: "바꾸고 지우기" }).click();
  await expect(dialog.getByRole("textbox", { name: "소매통" })).toHaveValue("");
  await expect(kind).toHaveValue("shortSleeve");
  await expect(kind).toBeFocused();
  // 한 번 더 다른 도면으로 바꿈.
  await kind.selectOption("raglanLongSleeve");
  await dialog.getByRole("button", { name: "바꾸고 지우기" }).click();
  await expect(dialog.getByRole("textbox", { name: "화장" })).toBeVisible();
  await expect(kind).toBeFocused();
  expect(audit.patches).toEqual([
    { version: 3, sizeChartKind: "raglanLongSleeve" },
    { version: 4, sizeChartKind: "shortSleeve" },
    { version: 5, sizeChartKind: "raglanLongSleeve" },
  ]);
  await page.keyboard.press("Escape");
  await expect(dialog).toBeHidden();
  await expect(page.getByText("래글런 긴팔 · 미등록")).toBeVisible();
  await expect(page.getByRole("list", { name: "추가된 옵션" })).not.toContainText(
    "상세",
  );
  expect(audit.blocked).toEqual([]);
});

test("a wheel has one drawing in mm, nested help closes first, unsaved chips ask for a save, and it fits 375px", async ({
  page,
}) => {
  await page.setViewportSize({ width: 375, height: 800 });
  const audit = await setup(page, "/admin?section=products", undefined, {
    category: "Wheels",
    sizes: ["54mm 99a"],
  });
  await editDeck(page);
  await page.getByRole("textbox", { name: "사이즈 / 옵션" }).fill("56mm 99a");
  await page.getByRole("button", { name: "옵션 추가", exact: true }).click();
  await chip(page, "56mm 99a").click();
  await expect(page.getByRole("dialog")).toHaveCount(0);
  await expect(
    page.getByRole("alert").filter({ hasText: "상품을 먼저 저장해 주세요." }),
  ).toBeVisible();

  const open = page.getByRole("button", { name: "+ 상세사이즈 등록" });
  await open.click();
  const dialog = page.getByRole("dialog", { name: /^상세사이즈 · / });
  const kind = dialog.getByRole("combobox", { name: "도면 종류" });
  await expect(kind).toBeDisabled();
  await expect(kind).toHaveAccessibleDescription(
    "이 카테고리는 도면 종류가 하나뿐입니다.",
  );
  for (const [label, value] of [
    ["지름", "54"],
    ["W 전체 폭", "33.5"],
    ["T 바닥 닿는 폭", "20"],
  ])
    await dialog.getByRole("textbox", { name: label }).fill(value);
  await expect(dialog.locator("svg")).toContainText("54mm");
  await expect(dialog).not.toContainText('"');
  // 모달은 옆 스크롤 없이 휴대폰 폭에 맞음.
  const box = (await dialog.boundingBox())!;
  expect(box.x).toBeGreaterThanOrEqual(0);
  expect(box.x + box.width).toBeLessThanOrEqual(375);
  expect(
    await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth),
  ).toBe(true);

  const help = dialog.getByRole("button", { name: "상세사이즈 입력 도움말" });
  await help.click();
  const helpDialog = page.getByRole("dialog", { name: "상세사이즈 입력 도움말" });
  await expect(helpDialog).toContainText("mm로 입력합니다.");
  await page.keyboard.press("Escape");
  await expect(helpDialog).toHaveCount(0);
  await expect(dialog).toBeVisible();
  await expect(help).toBeFocused();

  await dialog
    .getByRole("button", { name: "저장", exact: true })
    .scrollIntoViewIfNeeded();
  await dialog.getByRole("button", { name: "저장", exact: true }).click();
  await expect(dialog).toBeHidden();
  expect(audit.patches).toEqual([
    {
      version: 3,
      sizeChart: {
        kind: "wheel",
        values: { diameter: 54, width: 33.5, contactWidth: 20 },
      },
    },
  ]);
  await expect(page.getByText("휠 · 지름 54mm")).toBeVisible();
  expect(audit.blocked).toEqual([]);
});
test("a top's storefront chart uses the selected size's values, then the default", async ({
  page,
}, testInfo) => {
  const audit = await setup(page, `/products/${DECK.slug}`, undefined, {
    category: "Top",
    sizes: ["S", "M"],
    sizeChart: { kind: "shortSleeve", values: TOP },
    sizeChartKind: "shortSleeve",
    sizeChartsBySize: { S: { ...TOP, length: 74 } },
  });
  await expect(page.getByRole("heading", { name: "[TEST] Deck size A" })).toBeVisible();
  let svg = await storefrontChart(page);
  await expect(svg).toHaveAttribute("aria-label", /^반팔: 총장 74cm \(29\.1"\)/);
  for (const text of ["74cm", '(29.1")', "50.5cm", '(19.9")'])
    await expect(svg).toContainText(text);
  await page.screenshot({ path: testInfo.outputPath("size-chart-desktop-light.png") });
  // 넓은 화면은 도면 전체를 보여 주므로 추가 스크롤 정지점이 없음.
  await expect(page.getByRole("dialog").getByRole("region")).toHaveCount(0);
  await page.keyboard.press("Escape");

  // M에는 자기 값이 없으므로 기본값이 표시됨.
  await page.getByRole("button", { name: "M", exact: true }).click();
  svg = await storefrontChart(page);
  await expect(svg).toContainText("72cm");
  await expect(svg).not.toContainText("74cm");
  await page.keyboard.press("Escape");
  expect(audit.blocked).toEqual([]);
});

test("bottoms show only sizes with values when there is no default, and wheels stay in mm", async ({
  page,
}) => {
  const pants = { length: 100, waist: 40, hip: 52, thigh: 32, rise: 30, hem: 21.5 };
  const audit = await setup(page, `/products/${DECK.slug}`, undefined, {
    category: "Bottom",
    sizes: ["30", "32"],
    sizeChartKind: "longPants",
    sizeChartsBySize: { "32": pants },
  });
  await expect(page.getByRole("heading", { name: "[TEST] Deck size A" })).toBeVisible();
  await expect(page.getByRole("button", { name: "상세사이즈" })).toHaveCount(0);
  await page.getByRole("button", { name: "32", exact: true }).click();
  const svg = await storefrontChart(page);
  await expect(svg).toHaveAttribute("aria-label", /^긴바지: 총장 100cm/);
  await expect(svg).toContainText("21.5cm");
  await page.keyboard.press("Escape");
  expect(audit.blocked).toEqual([]);

  const wheels = await setup(page, `/products/${DECK.slug}`, undefined, {
    category: "Wheels",
    sizes: ["54mm 99a", "56mm 99a"],
    sizeChart: {
      kind: "wheel",
      values: { diameter: 54, width: 33.5, contactWidth: 20 },
    },
    sizeChartKind: "wheel",
  });
  for (const size of ["54mm 99a", "56mm 99a"]) {
    await page.getByRole("button", { name: size, exact: true }).click();
    const wheel = await storefrontChart(page);
    await expect(wheel).toContainText("33.5mm");
    await expect(wheel).not.toContainText('"');
    await page.keyboard.press("Escape");
  }
  expect(wheels.blocked).toEqual([]);
});

test("the product's category picks the chart when both a deck spec and a size chart remain", async ({
  page,
}) => {
  // 범주가 바뀌기 전에 저장된 데크 사이즈표는 새 차트와 함께 기록에 남음.
  const both = {
    sizes: ["S"],
    deckSpec: SPEC,
    sizeChart: { kind: "shortSleeve", values: TOP },
    sizeChartKind: "shortSleeve",
  };
  const audit = await setup(page, `/products/${DECK.slug}`, undefined, {
    ...both,
    category: "Top",
  });
  await expect(page.getByRole("heading", { name: "[TEST] Deck size A" })).toBeVisible();
  let svg = await storefrontChart(page);
  await expect(svg).toHaveAttribute("aria-label", /^반팔: 총장 72cm/);
  await expect(svg).not.toContainText('8.5"');
  await page.keyboard.press("Escape");
  expect(audit.blocked).toEqual([]);

  // 데크는 데크 도면을 유지함. 공개 파서가 이미 데크의 상의 차트를 버림.
  const deck = await setup(page, `/products/${DECK.slug}`, undefined, {
    ...both,
    category: "Deck",
  });
  svg = await storefrontChart(page);
  await expect(svg).toContainText('8.5"');
  await expect(svg).not.toContainText("72cm");
  await page.keyboard.press("Escape");
  expect(deck.blocked).toEqual([]);
});

test("a top without any size chart shows no size chart button", async ({ page }) => {
  const audit = await setup(page, `/products/${DECK.slug}`, undefined, {
    category: "Top",
    sizes: ["S", "M"],
  });
  await expect(page.getByRole("heading", { name: "[TEST] Deck size A" })).toBeVisible();
  for (const size of ["S", "M"]) {
    await page.getByRole("button", { name: size, exact: true }).click();
    await expect(page.getByRole("button", { name: "상세사이즈" })).toHaveCount(0);
  }
  expect(audit.blocked).toEqual([]);
});
