// 역할: 사이즈표 도면이 휴대폰·데스크톱·테마별로 옆 스크롤 없이 읽히는지와 크기 변경 시 모달 포커스·Esc·스크롤 잠금 유지를 검증함.
import { expect, test, type Page } from "@playwright/test";
import {
  DECK,
  SPEC,
  type Stored,
  setup,
  TOP,
  storefrontChart,
} from "./deck-size-spec-fixtures";

/** 실제 화면 글자 크기는 SVG 변환과 높이 기준 축소까지 포함함. */
async function renderedLabelSizes(svg: ReturnType<Page["locator"]>) {
  return svg.evaluate((element) => {
    const drawing = element as SVGSVGElement;
    const size = (selector: string) => {
      const nodes = [...drawing.querySelectorAll<SVGGraphicsElement>(selector)];
      return nodes.length
        ? Math.min(
            ...nodes.map((node) => {
              const matrix = node.getScreenCTM()!;
              return (
                parseFloat(getComputedStyle(node).fontSize) *
                Math.hypot(matrix.a, matrix.b)
              );
            }),
          )
        : null;
    };
    return { value: size("text")!, inch: size("tspan") };
  });
}

/** 차트는 라벨을 자르거나 스크롤하지 않고 SVG 크기를 조정해 맞춤. */
async function expectChartFits(
  page: Page,
  svg: ReturnType<Page["locator"]>,
  width: number,
) {
  const dialog = page.getByRole("dialog");
  const sizes = await renderedLabelSizes(svg);
  expect(sizes.value, `${width}px primary value`).toBeGreaterThanOrEqual(16);
  if (sizes.inch !== null)
    expect(sizes.inch, `${width}px conversion`).toBeGreaterThanOrEqual(12);
  const layout = await svg.evaluate((element) => {
    const drawing = element as SVGSVGElement;
    const box = drawing.getBoundingClientRect();
    const image = drawing.closest('[role="dialog"]')!.querySelector("img")!;
    const imageBox = image.getBoundingClientRect();
    const parent = drawing.parentElement!;
    const clipped = [...drawing.querySelectorAll("text")].filter((text) => {
      const label = text.getBoundingClientRect();
      return (
        label.left < box.left - 1 ||
        label.top < box.top - 1 ||
        label.right > box.right + 1 ||
        label.bottom > box.bottom + 1
      );
    });
    return {
      clipped: clipped.map((text) => text.textContent),
      svgWidth: box.width,
      svgTop: box.top,
      svgLeft: box.left,
      imageBottom: imageBox.bottom,
      imageRight: imageBox.right,
      imageHeight: imageBox.height,
      parentFits: parent.scrollWidth <= parent.clientWidth + 1,
    };
  });
  expect(layout.clipped).toEqual([]);
  expect(layout.parentFits).toBe(true);
  expect(
    await dialog.evaluate((element) => element.scrollWidth <= element.clientWidth + 1),
  ).toBe(true);
  expect(
    await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth),
  ).toBe(true);
  await expect(dialog.getByRole("region")).toHaveCount(0);
  if (width < 768) {
    expect(layout.svgTop).toBeGreaterThanOrEqual(layout.imageBottom);
    expect(layout.svgTop - layout.imageBottom).toBeLessThanOrEqual(16);
    expect(layout.svgWidth).toBeGreaterThanOrEqual(width * 0.94);
    expect(layout.imageHeight).toBeLessThanOrEqual(288);
  } else {
    expect(layout.svgLeft).toBeGreaterThanOrEqual(layout.imageRight);
  }
}

const responsiveCharts: {
  kind: string;
  product: Partial<Stored>;
  spec?: typeof SPEC;
}[] = [
  { kind: "deck", product: {}, spec: SPEC },
  {
    kind: "shortSleeve",
    product: {
      category: "Top",
      sizes: ["S"],
      sizeChart: { kind: "shortSleeve", values: TOP },
      sizeChartKind: "shortSleeve",
    },
  },
  {
    kind: "raglanLongSleeve",
    product: {
      category: "Outerwear",
      sizes: ["S"],
      sizeChart: {
        kind: "raglanLongSleeve",
        values: {
          length: 70,
          chest: 58,
          cuff: 10,
          neckToCuff: 80.5,
          hem: 50,
          armhole: 30,
        },
      },
      sizeChartKind: "raglanLongSleeve",
    },
  },
  {
    kind: "longPants",
    product: {
      category: "Bottom",
      sizes: ["32"],
      sizeChart: {
        kind: "longPants",
        values: { length: 100, waist: 40, hip: 52, thigh: 32, rise: 30, hem: 21.5 },
      },
      sizeChartKind: "longPants",
    },
  },
  {
    kind: "shorts",
    product: {
      category: "Bottom",
      sizes: ["32"],
      sizeChart: {
        kind: "shorts",
        values: { length: 50, waist: 40, hip: 52, thigh: 32, rise: 28, hem: 26 },
      },
      sizeChartKind: "shorts",
    },
  },
  {
    kind: "wheel",
    product: {
      category: "Wheels",
      sizes: ["54mm"],
      sizeChart: {
        kind: "wheel",
        values: { diameter: 54, width: 33.5, contactWidth: 20 },
      },
      sizeChartKind: "wheel",
    },
  },
];

for (const fixture of responsiveCharts)
  test(`${fixture.kind} fits the detail overlay without sideways scrolling on phones and desktops`, async ({
    page,
  }, testInfo) => {
    const audit = await setup(
      page,
      `/products/${DECK.slug}`,
      fixture.spec,
      fixture.product,
    );
    for (const width of [320, 375, 390, 430, 768, 1024, 1440]) {
      await page.setViewportSize({ width, height: 900 });
      const svg = await storefrontChart(page);
      await expectChartFits(page, svg, width);
      if (width === 375) {
        await svg.scrollIntoViewIfNeeded();
        await page.screenshot({ path: testInfo.outputPath(`${fixture.kind}-375.png`) });
      }
      await page.keyboard.press("Escape");
    }
    // 최대 길이 값과 빈 저장값도 맞게 표시됨. 실제 카탈로그 쓰기는 없음.
    const item = audit.store[0];
    if (fixture.spec)
      item.deckSpec = {
        nose: null,
        tail: 99.9999,
        width: 99.9999,
        length: 100,
        wheelbase: null,
      } as unknown as typeof SPEC;
    else {
      const chart = item.sizeChart!;
      chart.values = Object.fromEntries(
        Object.keys(chart.values).map((key, index) => [
          key,
          index % 2 ? null : fixture.kind === "wheel" ? 99.9 : 299.9,
        ]),
      );
    }
    await page.setViewportSize({ width: 320, height: 900 });
    await page.reload();
    const svg = await storefrontChart(page);
    await expect(svg).toContainText("null");
    await expectChartFits(page, svg, 320);
    await svg.scrollIntoViewIfNeeded();
    await page.screenshot({
      path: testInfo.outputPath(`${fixture.kind}-320-boundary.png`),
    });
    await page.keyboard.press("Escape");
    expect(audit.patches).toEqual([]);
    expect(audit.blocked).toEqual([]);
  });

test("resizing a chart preserves modal focus, Escape, close target and background scroll lock", async ({
  page,
}) => {
  await page.setViewportSize({ width: 375, height: 800 });
  const audit = await setup(page, `/products/${DECK.slug}`, undefined, {
    category: "Top",
    sizes: ["S"],
    sizeChart: { kind: "shortSleeve", values: TOP },
    sizeChartKind: "shortSleeve",
  });
  const trigger = page.getByRole("button", { name: "상세사이즈" });
  await storefrontChart(page);
  const dialog = page.getByRole("dialog");
  const close = dialog.getByRole("button", { name: "닫기", exact: true });
  const closeBox = (await close.boundingBox())!;
  expect(closeBox.width).toBeGreaterThanOrEqual(44);
  expect(closeBox.height).toBeGreaterThanOrEqual(44);
  await expect(close).toBeFocused();
  expect(await page.evaluate(() => document.body.style.overflow)).toBe("hidden");
  await page.setViewportSize({ width: 1440, height: 900 });
  await expect(close).toBeFocused();
  await page.keyboard.press("Tab");
  await expect(close).toBeFocused();
  await page.keyboard.press("Shift+Tab");
  await expect(close).toBeFocused();
  await page.keyboard.press("Escape");
  await expect(dialog).toHaveCount(0);
  await expect(trigger).toBeFocused();
  expect(await page.evaluate(() => document.body.style.overflow)).not.toBe("hidden");
  await trigger.click();
  await close.click();
  await expect(dialog).toHaveCount(0);
  expect(audit.patches).toEqual([]);
  expect(audit.blocked).toEqual([]);
});

for (const theme of ["light", "dark"] as const)
  test(`all six size charts stay readable without sideways scrolling in the ${theme} theme`, async ({
    page,
  }, testInfo) => {
    await page.setViewportSize({ width: 375, height: 800 });
    await page.addInitScript(
      (value) => localStorage.setItem("paradays-theme", value),
      theme,
    );
    for (const fixture of responsiveCharts) {
      const audit = await setup(
        page,
        `/products/${DECK.slug}`,
        fixture.spec,
        fixture.product,
      );
      await expect(page.locator("html")).toHaveAttribute("data-theme", theme);
      const svg = await storefrontChart(page);
      await expectChartFits(page, svg, 375);
      await svg.scrollIntoViewIfNeeded();
      await page.screenshot({
        path: testInfo.outputPath(`${fixture.kind}-375-${theme}.png`),
      });
      await page.keyboard.press("Escape");
      expect(audit.patches).toEqual([]);
      expect(audit.blocked).toEqual([]);
    }
  });
