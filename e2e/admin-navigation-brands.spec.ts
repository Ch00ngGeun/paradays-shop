// 역할: 브랜드 화면의 검색·필터, 명시적 등록과 중복 제출·실패 처리, 빈/실패 카탈로그, 모바일·테마별 표시를 검증함.
import { expect, test } from "@playwright/test";
import { audits, respond, setup } from "./admin-navigation-base-fixtures";
import {
  brandNameInput,
  brandProducts,
  brandRow,
  brandTable,
  brandWorkspace,
  savedBrand,
} from "./admin-navigation-brand-fixtures";

test.afterEach(async ({ page }) => {
  expect(audits.get(page)?.blocked ?? []).toEqual([]);
});

test("brand redesign: only observed catalog brands are grouped searched and filtered with keyboard controls", async ({
  page,
}, testInfo) => {
  await page.setViewportSize({ width: 1440, height: 1000 });
  const audit = await setup(page, {
    path: "/admin?section=brands",
    catalogProducts: brandProducts,
  });
  const panel = brandWorkspace(page);
  await expect(
    panel.getByRole("heading", { name: "브랜드 관리", exact: true }),
  ).toBeVisible();
  await expect(brandTable(page).getByRole("row")).toHaveCount(3);
  await expect(brandRow(page, "TEST").getByRole("cell").first()).toContainText("2개");
  await expect(brandRow(page, "RIVER").getByRole("cell").first()).toContainText("1개");
  await expect(brandRow(page, "TEST")).toContainText("상품에서 확인");
  await expect(
    panel.getByRole("button", { name: "전체 2", exact: true }),
  ).toHaveAttribute("aria-pressed", "true");
  await expect(
    panel.getByRole("button", { name: "상품 연결 2", exact: true }),
  ).toBeVisible();
  const search = panel.getByRole("searchbox", { name: "브랜드명 검색", exact: true });
  await search.fill("  rIv  ");
  await expect(brandTable(page).getByRole("row")).toHaveCount(2);
  await expect(brandRow(page, "RIVER")).toBeVisible();
  await search.fill("");
  const unlinked = panel.getByRole("button", { name: "연결 없음 0", exact: true });
  await unlinked.focus();
  await page.keyboard.press("Space");
  await expect(unlinked).toHaveAttribute("aria-pressed", "true");
  await expect(
    panel.getByText("조건에 맞는 브랜드가 없습니다", { exact: true }),
  ).toBeVisible();
  await panel.getByRole("button", { name: "전체 2", exact: true }).focus();
  await page.keyboard.press("Enter");
  await expect(brandRow(page, "TEST")).toBeVisible();
  // 목록의 제한 설명은 목록 제목의 '?' 도움말에 있음.
  await panel.getByRole("button", { name: "브랜드 목록 도움말", exact: true }).click();
  const listHelp = page.getByRole("dialog", {
    name: "브랜드 목록 도움말",
    exact: true,
  });
  await expect(
    listHelp.getByText(/연결이 없어도 비활성 브랜드를 뜻하지 않습니다/),
  ).toBeVisible();
  await expect(
    listHelp.getByText(
      /전체 브랜드 목록이나 서버의 활성 상태를 조회하는 화면은 아닙니다/,
    ),
  ).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(listHelp).toHaveCount(0);
  await expect(panel.locator("summary", { hasText: /^도움말$/ })).toHaveCount(0);
  const catalogBox = await panel
    .getByRole("region", { name: "이 화면에서 확인한 브랜드", exact: true })
    .boundingBox();
  const formBox = await brandNameInput(page)
    .locator("xpath=ancestor::form[1]")
    .boundingBox();
  expect(catalogBox).not.toBeNull();
  expect(formBox).not.toBeNull();
  expect(formBox!.x).toBeGreaterThan(catalogBox!.x + catalogBox!.width - 1);
  expect(
    await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth),
  ).toBe(true);
  await page.screenshot({
    path: testInfo.outputPath("brand-redesign-desktop-1440.png"),
    fullPage: true,
  });
  expect(audit.syntheticWrites).toEqual([]);
  expect(audit.reads.filter((path) => path.includes("/admin/brands"))).toEqual([]);
});

test("brand redesign: explicit registration sends only the trimmed supported fields and does not invent inactive or draft status", async ({
  page,
}) => {
  const commands: unknown[] = [];
  const audit = await setup(page, {
    path: "/admin?section=brands",
    catalogProducts: brandProducts,
    handleBrandMutation: async (route) => {
      const command = route.request().postDataJSON();
      commands.push(command);
      expect(route.request().headers().authorization).toMatch(/^Bearer /);
      await savedBrand(route, command.name);
    },
  });
  const panel = brandWorkspace(page);
  const memo = panel.getByRole("textbox", { name: "운영 메모 (선택)", exact: true });
  await brandNameInput(page).fill("  NOVA  ");
  await memo.fill("  Synthetic supplier note  ");
  await expect(
    panel.getByRole("region", { name: "브랜드명 표시 예시", exact: true }),
  ).toContainText("NOVA");
  expect(commands).toEqual([]);
  await panel.getByRole("button", { name: "브랜드 등록", exact: true }).click();
  await expect.poll(() => commands.length).toBe(1);
  expect(commands[0]).toEqual({ name: "NOVA", memo: "Synthetic supplier note" });
  await expect(panel.getByRole("status")).toContainText("브랜드를 서버에 등록했습니다");
  await expect(brandNameInput(page)).toHaveValue("");
  await expect(memo).toHaveValue("");
  await expect(brandRow(page, "NOVA")).toContainText("0개");
  await expect(brandRow(page, "NOVA")).toContainText("연결 없음");
  await expect(brandRow(page, "NOVA")).toContainText("이 화면에서 추가");
  await expect(brandRow(page, "NOVA")).not.toContainText(/비활성|초안|저장 대기/);
  await panel.getByRole("button", { name: "연결 없음 1", exact: true }).click();
  await expect(brandTable(page).getByRole("row")).toHaveCount(2);
  await brandNameInput(page).fill("EMPTY MEMO");
  await panel.getByRole("button", { name: "브랜드 등록", exact: true }).click();
  await expect.poll(() => commands.length).toBe(2);
  expect(commands[1]).toEqual({ name: "EMPTY MEMO" });
  await brandNameInput(page).fill(" nova ");
  await panel.getByRole("button", { name: "브랜드 등록", exact: true }).click();
  await expect(panel.getByRole("alert")).toContainText(
    "이미 이 화면의 목록에 있는 브랜드명입니다",
  );
  await brandNameInput(page).fill(" test ");
  await panel.getByRole("button", { name: "브랜드 등록", exact: true }).click();
  await expect(panel.getByRole("alert")).toContainText(
    "이미 이 화면의 목록에 있는 브랜드명입니다",
  );
  expect(commands).toHaveLength(2);
  expect(audit.syntheticWrites).toEqual(
    Array(2).fill("POST https://api.sales.test/prod/admin/brands"),
  );
});

test("brand redesign: pending registration locks fields and coalesces repeated submits into one request", async ({
  page,
}) => {
  let release!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const commands: unknown[] = [];
  const audit = await setup(page, {
    path: "/admin?section=brands",
    handleBrandMutation: async (route) => {
      commands.push(route.request().postDataJSON());
      await gate;
      await savedBrand(route, "NOVA");
    },
  });
  const panel = brandWorkspace(page);
  await brandNameInput(page).fill("NOVA");
  try {
    await brandNameInput(page)
      .locator("xpath=ancestor::form[1]")
      .evaluate((form: HTMLFormElement) => {
        form.requestSubmit();
        form.requestSubmit();
      });
    await expect.poll(() => commands.length).toBe(1);
    await expect(brandNameInput(page)).toBeDisabled();
    await expect(
      panel.getByRole("textbox", { name: "운영 메모 (선택)", exact: true }),
    ).toBeDisabled();
    await expect(
      panel.getByRole("button", { name: "등록 중…", exact: true }),
    ).toBeDisabled();
    await expect(
      panel.getByRole("button", { name: "입력 지우기", exact: true }),
    ).toBeDisabled();
  } finally {
    release();
  }
  await expect(brandRow(page, "NOVA")).toBeVisible();
  await expect(brandNameInput(page)).toBeEnabled();
  expect(commands).toEqual([{ name: "NOVA" }]);
  expect(audit.syntheticWrites).toEqual([
    "POST https://api.sales.test/prod/admin/brands",
  ]);
});

test("brand redesign: failed registration preserves the inputs and never falls back to a claimed server save", async ({
  page,
}) => {
  const audit = await setup(page, {
    path: "/admin?section=brands",
    handleBrandMutation: (route) =>
      respond(route, { code: "SYNTHETIC_BRAND_UNAVAILABLE" }, 503),
  });
  const panel = brandWorkspace(page);
  await brandNameInput(page).fill("NOVA");
  await panel
    .getByRole("textbox", { name: "운영 메모 (선택)", exact: true })
    .fill("Retain this synthetic note");
  await panel.getByRole("button", { name: "브랜드 등록", exact: true }).click();
  await expect(panel.getByRole("alert")).toContainText(
    "브랜드 등록 결과를 확인하지 못했습니다",
  );
  await expect(panel.getByRole("alert")).toContainText("서버의 처리 결과를 확인");
  await expect(brandNameInput(page)).toHaveValue("NOVA");
  await expect(
    panel.getByRole("textbox", { name: "운영 메모 (선택)", exact: true }),
  ).toHaveValue("Retain this synthetic note");
  await expect(brandNameInput(page)).toBeEnabled();
  await expect(brandTable(page)).toHaveCount(0);
  await expect(panel.getByRole("status")).toHaveCount(0);
  await expect(
    panel.getByRole("button", { name: "이 화면에 임시 추가", exact: true }),
  ).toHaveCount(0);
  await expect(
    panel.getByRole("button", { name: "브랜드 등록", exact: true }),
  ).toBeEnabled();
  expect(audit.syntheticWrites).toEqual([
    "POST https://api.sales.test/prod/admin/brands",
  ]);
});

test("brand redesign: empty catalog shows no invented brands and blank submission does not write", async ({
  page,
}) => {
  const audit = await setup(page, { path: "/admin?section=brands" });
  const panel = brandWorkspace(page);
  await expect(
    panel.getByText("현재 이 화면에 표시할 브랜드가 없습니다", { exact: true }),
  ).toBeVisible();
  await expect(
    panel.getByRole("button", { name: "전체 0", exact: true }),
  ).toBeVisible();
  await brandNameInput(page).fill("  ");
  await panel.getByRole("button", { name: "브랜드 등록", exact: true }).click();
  await expect(panel.getByRole("alert")).toContainText("브랜드명을 입력해 주세요");
  await expect(brandNameInput(page)).toHaveAttribute("maxlength", "100");
  await expect(
    panel.getByRole("textbox", { name: "운영 메모 (선택)", exact: true }),
  ).toHaveAttribute("maxlength", "1000");
  expect(audit.syntheticWrites).toEqual([]);
});

test("brand redesign: failed catalog states that connected counts are incomplete instead of asserting a full brand directory", async ({
  page,
}) => {
  const audit = await setup(page, {
    path: "/admin?section=brands",
    handleCatalog: (route) =>
      respond(route, { code: "SYNTHETIC_CATALOG_UNAVAILABLE" }, 503),
  });
  const panel = brandWorkspace(page);
  await expect(panel.getByRole("alert")).toContainText("전체 수량이 아닙니다");
  await expect(brandTable(page)).toHaveCount(0);
  await expect(
    panel.getByRole("button", { name: "전체 —", exact: true }),
  ).toBeVisible();
  await expect(
    panel.getByText("브랜드 목록을 확인하지 못했습니다", { exact: true }),
  ).toBeVisible();
  await expect(
    panel.getByText(/조회 실패는 브랜드가 없다는 뜻이 아닙니다/),
  ).toBeVisible();
  await expect(panel.getByRole("button", { name: "전체 0", exact: true })).toHaveCount(
    0,
  );
  expect(audit.syntheticWrites).toEqual([]);
});

test("brand redesign: an in-flight catalog does not present missing counts as confirmed zero", async ({
  page,
}) => {
  let release!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const audit = await setup(page, {
    path: "/admin?section=brands",
    waitForIdle: false,
    handleCatalog: async (route) => {
      await gate;
      await respond(route, { products: brandProducts });
    },
  });
  const panel = brandWorkspace(page);
  try {
    await expect(
      panel.getByText("상품의 브랜드를 불러오고 있습니다", { exact: true }),
    ).toBeVisible();
    for (const prefix of ["전체", "상품 연결", "연결 없음"])
      await expect(
        panel.getByRole("button", { name: `${prefix} —`, exact: true }),
      ).toBeVisible();
    await expect(
      panel.getByRole("button", { name: "전체 0", exact: true }),
    ).toHaveCount(0);
    await expect(brandTable(page)).toHaveCount(0);
  } finally {
    release();
  }
  await expect(brandRow(page, "TEST")).toBeVisible();
  await expect(
    panel.getByRole("button", { name: "전체 2", exact: true }),
  ).toBeVisible();
  expect(audit.syntheticWrites).toEqual([]);
});

test("brand redesign: mobile search filters and add form fit 375 and 320 pixels with 44-pixel controls", async ({
  page,
}, testInfo) => {
  await page.setViewportSize({ width: 375, height: 900 });
  const audit = await setup(page, {
    path: "/admin?section=brands",
    catalogProducts: brandProducts,
  });
  const panel = brandWorkspace(page);
  await brandNameInput(page).fill(`SYNTHETIC_${"LONG_BRAND_".repeat(6)}`);
  await panel
    .getByRole("textbox", { name: "운영 메모 (선택)", exact: true })
    .fill("Synthetic note: no actual registration");
  for (const width of [375, 320]) {
    await page.setViewportSize({ width, height: 900 });
    expect(
      await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth),
    ).toBe(true);
    for (const name of [
      "전체 2",
      "상품 연결 2",
      "연결 없음 0",
      "브랜드 등록",
      "입력 지우기",
    ])
      expect(
        (await panel.getByRole("button", { name, exact: true }).boundingBox())?.height,
      ).toBeGreaterThanOrEqual(44);
    for (const control of [
      panel.getByRole("searchbox", { name: "브랜드명 검색", exact: true }),
      brandNameInput(page),
    ])
      expect((await control.boundingBox())?.height).toBeGreaterThanOrEqual(44);
    await page.screenshot({
      path: testInfo.outputPath(`brand-redesign-mobile-${width}.png`),
      fullPage: true,
    });
  }
  await panel.getByRole("button", { name: "입력 지우기", exact: true }).click();
  await expect(brandNameInput(page)).toHaveValue("");
  await expect(
    panel.getByRole("textbox", { name: "운영 메모 (선택)", exact: true }),
  ).toHaveValue("");
  expect(audit.syntheticWrites).toEqual([]);
});

test("brand redesign: registration hover and keyboard focus remain readable in light and dark themes", async ({
  page,
}) => {
  const audit = await setup(page, { path: "/admin?section=brands" });
  const action = brandWorkspace(page).getByRole("button", {
    name: "브랜드 등록",
    exact: true,
  });
  for (const theme of ["light", "dark"]) {
    await page.evaluate((value) => {
      document.documentElement.dataset.theme = value;
    }, theme);
    for (const state of ["hover", "focus"]) {
      await page.mouse.move(0, 0);
      if (state === "hover") await action.hover();
      else {
        await action.focus();
        await page.keyboard.press("Tab");
        await page.keyboard.press("Shift+Tab");
        await expect(action).toBeFocused();
        await expect
          .poll(() => action.evaluate((node) => node.matches(":focus-visible")))
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
        const luminance = (rgb: readonly number[]) => {
          const [red, green, blue] = rgb.map((value) => {
            const channel = value / 255;
            return channel <= 0.04045
              ? channel / 12.92
              : ((channel + 0.055) / 1.055) ** 2.4;
          });
          return 0.2126 * red + 0.7152 * green + 0.0722 * blue;
        };
        const style = getComputedStyle(element);
        const foreground = luminance(rgba(style.color).slice(0, 3));
        const behind = luminance(background);
        return (
          (Math.max(foreground, behind) + 0.05) / (Math.min(foreground, behind) + 0.05)
        );
      });
      console.log(`Brand registration contrast ${theme}/${state}: ${contrast}`);
      expect(contrast).toBeGreaterThanOrEqual(4.5);
    }
  }
  expect(audit.syntheticWrites).toEqual([]);
});
