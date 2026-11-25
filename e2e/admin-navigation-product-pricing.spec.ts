// 역할: 상품 비교 가격·관리 코드 보존, 비교 가격 삭제 확인, 삭제 버튼의 테마별 가독성을 검증함.
import { expect, test } from "@playwright/test";
import { audits, products, respond, setup } from "./admin-navigation-base-fixtures";
import {
  fillProduct,
  newProduct,
  productPreview,
} from "./admin-navigation-product-fixtures";

test.afterEach(async ({ page }) => {
  expect(audits.get(page)?.blocked ?? []).toEqual([]);
});

test("product form refinement: an existing compare-at price and management code survive reset and an ordinary edit", async ({
  page,
}) => {
  const commands: Record<string, unknown>[] = [];
  const audit = await setup(page, {
    path: "/admin?section=products",
    catalogProducts: [
      { ...products[0], sku: "LEGACY-SKU-825", compareAtPrice: 20000, version: 7 },
    ],
    handleProductMutation: async (route) => {
      commands.push(route.request().postDataJSON() as Record<string, unknown>);
      await respond(route, {});
    },
  });
  await page
    .getByRole("listitem")
    .filter({ hasText: products[0]!.name })
    .getByRole("button", { name: "수정", exact: true })
    .click();
  const code = page.getByRole("textbox", { name: "SKU / 관리 코드", exact: true });
  const sales = page.getByRole("group", { name: "판매 정보", exact: true });
  const legacyPrice = sales.getByText(/^기존 정가\s*₩?20,000/);
  await expect(code).toHaveValue("LEGACY-SKU-825");
  await expect(legacyPrice).toBeVisible();
  await expect(page.getByRole("textbox", { name: /정가/ })).toHaveCount(0);
  await expect(page.getByRole("spinbutton", { name: /정가/ })).toHaveCount(0);
  await page.getByRole("button", { name: "입력 초기화", exact: true }).click();
  await expect(code).toHaveValue("LEGACY-SKU-825");
  await expect(legacyPrice).toBeVisible();
  await page
    .getByRole("textbox", { name: "상품명", exact: false })
    .fill("TEST_LEGACY_COMPARE_AT");
  await page.getByRole("textbox", { name: "브랜드", exact: false }).fill("TEST");
  await page.getByRole("spinbutton", { name: "판매가", exact: false }).fill("15000");
  await page.getByRole("button", { name: "비공개 수정 저장", exact: true }).click();
  await expect.poll(() => commands.length).toBe(1);
  expect(commands[0]).toMatchObject({
    sku: "LEGACY-SKU-825",
    compareAtPrice: "20000",
    price: "15000",
    version: 7,
  });
  expect(audit.syntheticWrites).toEqual([
    "PATCH https://api.sales.test/prod/admin/catalog/products/prd_synthetic_A",
  ]);
});

test("product form refinement: compare-at removal requires confirmation and resetting an edit restores the original value", async ({
  page,
}) => {
  const commands: Record<string, unknown>[] = [];
  const audit = await setup(page, {
    path: "/admin?section=products",
    catalogProducts: [
      { ...products[0], sku: "LEGACY-SKU", compareAtPrice: 20000, version: 7 },
    ],
    handleProductMutation: async (route) => {
      commands.push(route.request().postDataJSON() as Record<string, unknown>);
      await respond(route, {});
    },
  });
  await page
    .getByRole("listitem")
    .filter({ hasText: products[0]!.name })
    .getByRole("button", { name: "수정", exact: true })
    .click();
  await page.getByRole("spinbutton", { name: "판매가", exact: false }).fill("25000");
  await page.getByRole("button", { name: "비공개 수정 저장", exact: true }).click();
  await expect(page.locator("#admin-panel-products").getByRole("alert")).toContainText(
    "정가",
  );
  expect(commands).toEqual([]);
  const remove = page.getByRole("button", { name: "기존 정가 제거", exact: true });
  const legacyPrice = page
    .getByRole("group", { name: "판매 정보", exact: true })
    .getByText(/^기존 정가\s*₩?20,000/);
  page.once("dialog", (dialog) => void dialog.dismiss());
  await remove.click();
  await expect(legacyPrice).toBeVisible();
  expect(commands).toEqual([]);
  page.once("dialog", (dialog) => void dialog.accept());
  await remove.click();
  await expect(remove).toHaveCount(0);
  await expect(
    page.getByRole("status").filter({ hasText: "기존 정가 제거 예정" }),
  ).toBeVisible();
  await page.getByRole("button", { name: "입력 초기화", exact: true }).click();
  await expect(legacyPrice).toBeVisible();
  await expect(remove).toBeVisible();
  expect(commands).toEqual([]);
  page.once("dialog", (dialog) => void dialog.accept());
  await remove.click();
  await expect(remove).toHaveCount(0);
  await page
    .getByRole("textbox", { name: "상품명", exact: false })
    .fill("TEST_EXPLICIT_COMPARE_AT_REMOVAL");
  await page.getByRole("textbox", { name: "브랜드", exact: false }).fill("TEST");
  await page.getByRole("spinbutton", { name: "판매가", exact: false }).fill("25000");
  await page.getByRole("button", { name: "비공개 수정 저장", exact: true }).click();
  await expect.poll(() => commands.length).toBe(1);
  expect(Object.prototype.hasOwnProperty.call(commands[0], "compareAtPrice")).toBe(
    true,
  );
  expect(commands[0]).toMatchObject({
    compareAtPrice: "",
    price: "25000",
    sku: "LEGACY-SKU",
    version: 7,
  });
  expect(audit.syntheticWrites).toEqual([
    "PATCH https://api.sales.test/prod/admin/catalog/products/prd_synthetic_A",
  ]);
});

for (const width of [1440, 375]) {
  test(`product form refinement: ${width}px compact cards preserve image-description-publication order and accessible controls`, async ({
    page,
  }, testInfo) => {
    await page.setViewportSize({ width, height: width === 1440 ? 1000 : 844 });
    const audit = await setup(page, {
      path: "/admin?section=products",
      products: true,
    });
    await newProduct(page);
    await fillProduct(page, "TEST_COMPACT_LAYOUT_DECK");
    const panel = page.locator("#admin-panel-products");
    const image = panel.getByRole("group", { name: "대표 이미지", exact: true });
    const description = panel.getByRole("group", { name: "상품 설명", exact: true });
    const publication = panel.getByRole("group", { name: "공개 설정", exact: true });
    await expect(image).toBeVisible();
    await expect(description).toBeVisible();
    await expect(publication).toBeVisible();
    // 세 요소를 한 프레임에서 잼. boundingBox를 따로 부르면 부드러운 스크롤 중간에 걸칠 수 있음.
    const [imageBox, descriptionBox, publicationBox] = await page.evaluate(
      (elements) =>
        elements.map((element) => {
          const { y, height } = element!.getBoundingClientRect();
          return { y, height };
        }),
      [
        await image.elementHandle(),
        await description.elementHandle(),
        await publication.elementHandle(),
      ],
    );
    expect(descriptionBox.y).toBeGreaterThanOrEqual(imageBox.y + imageBox.height);
    expect(publicationBox.y).toBeGreaterThanOrEqual(
      descriptionBox.y + descriptionBox.height,
    );
    const descriptionInput = panel.getByRole("textbox", {
      name: "상품 설명",
      exact: false,
    });
    await descriptionInput.fill("TEST_FIRST_DESCRIPTION\nTEST_SECOND_DESCRIPTION");
    await expect(productPreview(page)).toContainText("TEST_FIRST_DESCRIPTION");
    await expect(
      publication.getByRole("checkbox", { name: "저장 후 스토어에 공개", exact: true }),
    ).not.toBeChecked();
    const badge = publication.getByRole("checkbox", {
      name: "신상품 배지 표시",
      exact: true,
    });
    await badge.check();
    await expect(badge).toBeChecked();
    await expect(productPreview(page)).toContainText("NEW");
    await expect(panel.getByRole("spinbutton", { name: /정가/ })).toHaveCount(0);
    await page.evaluate(() => scrollTo(0, 0));
    const brandInput = panel.getByRole("textbox", { name: "브랜드", exact: false });
    const brandSelect = panel.getByRole("combobox", {
      name: "브랜드 선택",
      exact: true,
    });
    const brandInputBox = (await brandInput.boundingBox())!;
    const brandSelectBox = (await brandSelect.boundingBox())!;
    expect(brandSelectBox.x).toBeGreaterThanOrEqual(
      brandInputBox.x + brandInputBox.width,
    );
    await panel
      .getByRole("combobox", { name: "데크 규격 선택", exact: true })
      .selectOption("8.25");
    for (const control of [
      brandInput,
      brandSelect,
      panel.getByRole("combobox", { name: "카테고리", exact: true }),
      panel.getByRole("combobox", { name: "데크 규격 선택", exact: true }),
      panel.getByRole("button", { name: "옵션 추가", exact: true }),
      panel.getByRole("button", { name: "비공개로 저장", exact: true }),
    ]) {
      await expect(control).toBeEnabled();
      const box = (await control.boundingBox())!;
      expect(box.height).toBeGreaterThanOrEqual(44);
      expect(box.x).toBeGreaterThanOrEqual(0);
      expect(box.x + box.width).toBeLessThanOrEqual(width + 1);
    }
    await brandInput.focus();
    await page.keyboard.press("Tab");
    await expect(brandSelect).toBeFocused();
    if (width === 1440) {
      const nameBox = (await panel
        .getByRole("textbox", { name: "상품명", exact: false })
        .boundingBox())!;
      const categoryBox = (await panel
        .getByRole("combobox", { name: "카테고리", exact: true })
        .boundingBox())!;
      expect(Math.abs(nameBox.y - brandInputBox.y)).toBeLessThanOrEqual(2);
      expect(Math.abs(nameBox.y - categoryBox.y)).toBeLessThanOrEqual(2);
      expect(brandInputBox.x).toBeGreaterThan(nameBox.x);
      expect(categoryBox.x).toBeGreaterThan(brandSelectBox.x);
      const priceBox = (await panel
        .getByRole("spinbutton", { name: "판매가", exact: false })
        .boundingBox())!;
      const stockBox = (await panel
        .getByRole("spinbutton", { name: /재고/ })
        .boundingBox())!;
      const optionBox = (await panel
        .getByRole("textbox", { name: "사이즈 / 옵션", exact: false })
        .boundingBox())!;
      expect(Math.abs(priceBox.y - stockBox.y)).toBeLessThanOrEqual(2);
      expect(Math.abs(priceBox.y - optionBox.y)).toBeLessThanOrEqual(2);
      expect(stockBox.x).toBeGreaterThan(priceBox.x);
      expect(optionBox.x).toBeGreaterThan(stockBox.x);
      const previewBox = (await productPreview(page).boundingBox())!;
      const basicBox = (await panel
        .getByRole("group", { name: "기본 정보", exact: true })
        .boundingBox())!;
      expect(previewBox.x).toBeGreaterThanOrEqual(basicBox.x + basicBox.width);
    }
    expect(
      await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth),
    ).toBe(true);
    await page.evaluate(() => scrollTo(0, 0));
    const screenshot = testInfo.outputPath(`product-form-refinement-${width}.png`);
    await page.screenshot({ path: screenshot, fullPage: true });
    console.log(`Product form refinement screenshot: ${screenshot}`);
    if (width === 375) {
      await page.setViewportSize({ width: 320, height: 844 });
      expect(
        await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth),
      ).toBe(true);
      await expect(brandInput).toBeEditable();
      await expect(brandSelect).toBeEnabled();
    }
    expect(audit.syntheticWrites).toEqual([]);
  });
}

test("product redesign: delete actions retain readable hover and keyboard-focus contrast in both themes", async ({
  page,
}) => {
  const audit = await setup(page, { path: "/admin?section=products", products: true });
  const panel = page.locator("#admin-panel-products");
  await panel
    .getByRole("button", { name: `${products[0]!.name} 선택`, exact: true })
    .click();
  const actions = [
    panel
      .getByRole("listitem")
      .filter({ hasText: products[0]!.name })
      .getByRole("button", { name: "삭제", exact: true }),
    panel.getByRole("button", { name: "선택 삭제 (1)", exact: true }),
  ];
  for (const theme of ["light", "dark"]) {
    await page.evaluate((value) => {
      document.documentElement.dataset.theme = value;
    }, theme);
    for (const [index, action] of actions.entries()) {
      for (const state of ["hover", "focus"]) {
        await page.mouse.move(0, 0);
        if (state === "hover") await action.hover();
        else {
          await action.focus();
          await page.keyboard.press("Tab");
          await page.keyboard.press("Shift+Tab");
          await expect(action).toBeFocused();
          await expect
            .poll(() => action.evaluate((element) => element.matches(":focus-visible")))
            .toBe(true);
        }
        const contrast = await action.evaluate((element) => {
          const canvas = document.createElement("canvas");
          canvas.width = canvas.height = 1;
          const context = canvas.getContext("2d")!;
          const rgba = (value: string) => {
            context.clearRect(0, 0, 1, 1);
            context.fillStyle = value;
            context.fillRect(0, 0, 1, 1);
            return [...context.getImageData(0, 0, 1, 1).data];
          };
          const ancestors: Element[] = [];
          for (let node: Element | null = element; node; node = node.parentElement)
            ancestors.unshift(node);
          let background = [255, 255, 255];
          for (const ancestor of ancestors) {
            const [red, green, blue, alpha] = rgba(
              getComputedStyle(ancestor).backgroundColor,
            );
            background = [red, green, blue].map(
              (channel, index) =>
                channel * (alpha / 255) + background[index] * (1 - alpha / 255),
            );
          }
          const style = getComputedStyle(element);
          const foreground = rgba(style.color).slice(0, 3);
          const luminance = (rgb: readonly number[]) => {
            const [red, green, blue] = rgb.map((value) => {
              const channel = value / 255;
              return channel <= 0.04045
                ? channel / 12.92
                : ((channel + 0.055) / 1.055) ** 2.4;
            });
            return 0.2126 * red + 0.7152 * green + 0.0722 * blue;
          };
          const foregroundLuminance = luminance(foreground);
          const backgroundLuminance = luminance(background);
          return {
            color: style.color,
            foreground,
            background,
            ratio:
              (Math.max(foregroundLuminance, backgroundLuminance) + 0.05) /
              (Math.min(foregroundLuminance, backgroundLuminance) + 0.05),
          };
        });
        console.log(
          `Product delete contrast ${theme}/${index}/${state}: ${JSON.stringify(contrast)}`,
        );
        expect(contrast.ratio).toBeGreaterThanOrEqual(4.5);
      }
    }
  }
  expect(audit.syntheticWrites).toEqual([]);
});
