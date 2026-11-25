// 역할: 영어 화면에서 의류·휠 사이즈표와 빈 측정값(null) 표시가 편집기·대화상자·상점 모두 한글 없이 나오는지 검증함.
import { expect, test } from "@playwright/test";
import { catalog } from "./admin-english-data-fixtures";
import {
  audits,
  setup,
  scan,
  scanHelp,
  expectClean,
  openSection,
} from "./admin-english-fixtures";

test.afterEach(async ({ page }) => {
  expect(audits.get(page)?.blocked ?? []).toEqual([]);
  expect(
    (audits.get(page)?.dialogs ?? []).filter((message) =>
      /\p{Script=Hangul}/u.test(message),
    ),
  ).toEqual([]);
});

const TOP_VALUES = {
  length: 72,
  shoulder: 50.5,
  chest: 56,
  sleeveLength: 22,
  hem: 55,
  sleeveWidth: 20.5,
  armhole: 24,
};

const STORE_SLUGS: Record<string, string> = {
  top: "plaid-overshirt-charcoal",
  bottom: "triangle-knit-sweater",
  wheel: "imagine-thinking-hat-black",
};

const sizeChartProduct = (
  id: string,
  name: string,
  category: string,
  sizes: string[],
  charts: Record<string, unknown>,
) => ({
  ...catalog[0],
  productId: `prd_english_${id}`,
  // 정적 내보내기는 알려진 상품 경로만 만들므로 상점 검사는 기존 slug를 재사용함.
  slug: STORE_SLUGS[id],
  name,
  category,
  sizes,
  sku: `TEST-EN-${id.toUpperCase()}`,
  ...charts,
});

const sizeChartProducts = [
  sizeChartProduct("top", "[TEST] English top", "Top", ["S", "M"], {
    sizeChart: { kind: "shortSleeve", values: TOP_VALUES },
    sizeChartKind: "shortSleeve",
    sizeChartsBySize: { M: { ...TOP_VALUES, length: 74 } },
  }),
  sizeChartProduct("bottom", "[TEST] English pants", "Bottom", ["30", "32"], {
    sizeChartKind: "longPants",
    sizeChartsBySize: {
      "32": { length: 100, waist: 40, hip: 52, thigh: 32, rise: 30, hem: 21.5 },
    },
  }),
  sizeChartProduct("wheel", "[TEST] English wheel", "Wheels", ["54mm 99a"], {
    sizeChart: {
      kind: "wheel",
      values: { diameter: 54, width: 33.5, contactWidth: 20 },
    },
    sizeChartKind: "wheel",
  }),
];

test("clothing and wheel size charts show no Korean in English in the editor, dialogs and the store", async ({
  page,
}) => {
  await setup(page, "/admin?section=products", sizeChartProducts);
  const found = new Map<string, string[]>();
  const edit = async (name: string) => {
    await openSection(page, "Product registration");
    await page
      .getByRole("listitem")
      .filter({ hasText: name })
      .getByRole("button", { name: "Edit", exact: true })
      .click();
  };
  const dialog = page.getByRole("dialog");
  const drawing = dialog.getByRole("combobox", { name: "Drawing" });

  await edit("[TEST] English top");
  await expect(
    page.getByText('Short sleeve · Default Length 72cm (28.3") · 1 per option', {
      exact: true,
    }),
  ).toBeVisible();
  await scan(page, "top editor", found);
  await scanHelp(page, "Size chart", found);
  await page.getByRole("button", { name: "Edit size chart" }).click();
  await expect(drawing).toHaveValue("shortSleeve");
  await expect(dialog.locator("svg")).toHaveAttribute(
    "aria-label",
    /^Short sleeve: Length 72cm/,
  );
  await scan(page, "top default dialog", found);
  await scanHelp(page, "Size chart input", found);
  await drawing.selectOption("raglanLongSleeve");
  await expect(dialog.getByRole("alert")).toContainText(
    "Switching the drawing to 'Raglan long sleeve' deletes the default",
  );
  await scan(page, "drawing switch confirmation", found);
  await dialog.getByRole("button", { name: "Keep it", exact: true }).click();
  await page.keyboard.press("Escape");
  await expect(dialog).toHaveCount(0);
  await page
    .getByRole("list", { name: "Added options", exact: true })
    .getByRole("button", { name: "M", exact: true })
    .click();
  await expect(drawing).toHaveAccessibleDescription(
    "Options follow the product's drawing. Change it from the default screen.",
  );
  await expect(dialog.locator('input[name="length"]')).toHaveValue("74");
  await scan(page, "top option dialog", found);
  await page.keyboard.press("Escape");

  await edit("[TEST] English pants");
  await expect(
    page.getByText("Long pants · Default not set · 1 per option", { exact: true }),
  ).toBeVisible();
  await scan(page, "pants editor", found);
  await page.getByRole("button", { name: "Edit size chart" }).click();
  await expect(dialog).toContainText(
    "Enter at least one value to see the diagram preview.",
  );
  await scan(page, "pants default dialog", found);
  await page.keyboard.press("Escape");

  await edit("[TEST] English wheel");
  await expect(page.getByText("Wheel · Diameter 54mm", { exact: true })).toBeVisible();
  await page.getByRole("button", { name: "Edit size chart" }).click();
  await expect(drawing).toHaveAccessibleDescription(
    "This category has only one drawing.",
  );
  await scan(page, "wheel default dialog", found);
  await scanHelp(page, "Size chart input", found);
  await page.keyboard.press("Escape");

  // 상점 사이즈표 도면도 모든 측정 항목 이름을 영어로 표시해야 함.
  for (const [slug, size, label] of [
    [STORE_SLUGS.top, "M", /^Short sleeve: Length 74cm/],
    [STORE_SLUGS.bottom, "32", /^Long pants: Length 100cm/],
    [STORE_SLUGS.wheel, "54mm 99a", /^Wheel: Diameter 54mm/],
  ] as const) {
    await page.goto(`/products/${slug}`);
    await page.waitForLoadState("networkidle");
    await page.getByRole("button", { name: size, exact: true }).click();
    await page.getByRole("button", { name: "Size chart" }).click();
    await expect(dialog.locator("svg")).toHaveAttribute("aria-label", label);
    // 이 검사는 사이즈표 대화상자만 대상으로 함. 뒤쪽 페이지에는 이미 알려진 한국어
    // 수량 라벨(product-detail.tsx)이 있으며 이는 별도로 보고됨.
    const korean = await dialog.evaluate((root) => {
      const re = /\p{Script=Hangul}/u;
      const out: string[] = [];
      const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
      while (walker.nextNode())
        if (re.test(walker.currentNode.textContent ?? ""))
          out.push(walker.currentNode.textContent!.trim());
      for (const element of [root, ...root.querySelectorAll("*")])
        for (const name of ["aria-label", "title", "alt"]) {
          const value = element.getAttribute(name);
          if (value && re.test(value)) out.push(`@${name}=${value}`);
        }
      return out;
    });
    if (korean.length) found.set(`store size chart ${slug}`, korean);
    await page.keyboard.press("Escape");
  }
  expectClean(found);
});

test("blank size fields show null without Korean in English in the editor, dialogs and the store", async ({
  page,
}) => {
  const blankTop = Object.fromEntries(
    Object.keys(TOP_VALUES).map((key) => [key, null]),
  );
  const products = [
    {
      ...catalog[0],
      productId: "prd_english_partial_deck",
      slug: "dekeyzer-deck-8-25",
      name: "[TEST] English partial deck",
      sku: "TEST-EN-PARTIAL-DECK",
      deckSpec: { nose: null, tail: null, width: 8.5, length: 31.75, wheelbase: null },
    },
    sizeChartProduct("top", "[TEST] English partial top", "Top", ["S"], {
      sizeChart: { kind: "shortSleeve", values: { ...blankTop, chest: 56 } },
      sizeChartKind: "shortSleeve",
    }),
    sizeChartProduct("wheel", "[TEST] English partial wheel", "Wheels", ["54mm 99a"], {
      sizeChart: {
        kind: "wheel",
        values: { diameter: 54, width: null, contactWidth: null },
      },
      sizeChartKind: "wheel",
    }),
    sizeChartProduct("bottom", "[TEST] English empty pants", "Bottom", ["32"], {}),
  ];
  await setup(page, "/admin?section=products", products);
  const found = new Map<string, string[]>();
  const dialog = page.getByRole("dialog");
  const edit = async (name: string) => {
    await openSection(page, "Product registration");
    await page
      .getByRole("listitem")
      .filter({ hasText: name })
      .getByRole("button", { name: "Edit", exact: true })
      .click();
  };

  // 각 요약은 첫 측정값이 비어 있어도 그 항목 이름을 표시함.
  for (const [name, summary, label] of [
    [
      "[TEST] English partial deck",
      '8.5" × 31.75" · WB null',
      /^nose null, tail null, width 8\.5"/,
    ],
    [
      "[TEST] English partial top",
      "Short sleeve · Length null",
      /^Short sleeve: Length null, Shoulder width null, Chest width 56cm/,
    ],
    [
      "[TEST] English partial wheel",
      "Wheel · Diameter 54mm",
      /^Wheel: Diameter 54mm, W overall width null, T contact width null$/,
    ],
  ] as const) {
    await edit(name);
    await expect(page.getByText(summary, { exact: true })).toBeVisible();
    await scan(page, `${name} editor`, found);
    await page.getByRole("button", { name: "Edit size chart" }).click();
    // 미리보기는 빈 필드를 null로 그리고 입력란은 비워 둠.
    await expect(dialog.locator("svg")).toHaveAttribute("aria-label", label);
    await expect(dialog.locator('input[value="null"]')).toHaveCount(0);
    await scan(page, `${name} dialog`, found);
    await page.keyboard.press("Escape");
  }

  // 아직 사이즈표가 없는 상품은 새 미리보기 안내를 표시함.
  await edit("[TEST] English empty pants");
  await page.getByRole("button", { name: "+ Add size chart" }).click();
  await expect(dialog).toContainText(
    "Enter at least one value to see the diagram preview.",
  );
  await expect(
    dialog.getByRole("button", { name: "Save", exact: true }),
  ).toBeDisabled();
  await scan(page, "empty size chart dialog", found);
  await page.keyboard.press("Escape");

  for (const [slug, size, label] of [
    ["dekeyzer-deck-8-25", "8.5", /^nose null, tail null, width 8\.5"/],
    [STORE_SLUGS.top, "S", /^Short sleeve: Length null/],
    [STORE_SLUGS.wheel, "54mm 99a", /^Wheel: Diameter 54mm, W overall width null/],
  ] as const) {
    await page.goto(`/products/${slug}`);
    await page.waitForLoadState("networkidle");
    await page.getByRole("button", { name: size, exact: true }).click();
    await page.getByRole("button", { name: "Size chart" }).click();
    await expect(dialog.locator("svg")).toHaveAttribute("aria-label", label);
    await expect(dialog.locator("svg")).toContainText("null");
    // 이 검사도 사이즈표 대화상자만 대상으로 함(위 의류 검사 참고).
    const korean = await dialog.evaluate((root) => {
      const re = /\p{Script=Hangul}/u;
      const out: string[] = [];
      const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
      while (walker.nextNode())
        if (re.test(walker.currentNode.textContent ?? ""))
          out.push(walker.currentNode.textContent!.trim());
      for (const element of [root, ...root.querySelectorAll("*")])
        for (const name of ["aria-label", "title", "alt"]) {
          const value = element.getAttribute(name);
          if (value && re.test(value)) out.push(`@${name}=${value}`);
        }
      return out;
    });
    if (korean.length) found.set(`store size chart ${slug}`, korean);
    await page.keyboard.press("Escape");
  }
  expectClean(found);
});
