import { expect, test } from "@playwright/test";
import { audits, respond, setup } from "./admin-navigation-base-fixtures";
import {
  campaignBody,
  campaignChannel,
  campaignPreview,
  campaignSave,
  campaignTitle,
  fillCampaign,
  marketingWorkspace,
  savedCampaign,
} from "./admin-navigation-marketing-fixtures";

test.afterEach(async ({ page }) => {
  expect(audits.get(page)?.blocked ?? []).toEqual([]);
});

test("marketing redesign: in-flight draft save locks content and channels and coalesces duplicate submission", async ({
  page,
}) => {
  let release!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const commands: unknown[] = [];
  const audit = await setup(page, {
    path: "/admin?section=marketing",
    handleCampaignMutation: async (route) => {
      commands.push(route.request().postDataJSON());
      await gate;
      await savedCampaign(route);
    },
  });
  await fillCampaign(page);
  const panel = marketingWorkspace(page);
  try {
    await panel
      .getByRole("form", { name: "캠페인 초안 작성", exact: true })
      .evaluate((form: HTMLFormElement) => {
        form.requestSubmit();
        form.requestSubmit();
      });
    await expect.poll(() => commands.length).toBe(1);
    await expect(campaignTitle(page)).toBeDisabled();
    await expect(campaignBody(page)).toBeDisabled();
    for (const label of ["이메일", "SMS", "푸시"])
      await expect(campaignChannel(page, label)).toBeDisabled();
    await expect(
      panel.getByRole("button", { name: "저장 중…", exact: true }),
    ).toBeDisabled();
  } finally {
    release();
  }
  await expect(panel.getByRole("status")).toContainText(
    "캠페인 초안을 서버에 저장했습니다",
  );
  expect(commands).toHaveLength(1);
  expect(audit.syntheticWrites).toEqual([
    "POST https://api.sales.test/prod/admin/campaigns",
  ]);
});

test("marketing redesign: uncertain save preserves title body and channels without a sent or local-save claim", async ({
  page,
}) => {
  const audit = await setup(page, {
    path: "/admin?section=marketing",
    handleCampaignMutation: (route) =>
      respond(route, { code: "SYNTHETIC_CAMPAIGN_UNAVAILABLE" }, 503),
  });
  await fillCampaign(page);
  await campaignChannel(page, "SMS").check();
  const panel = marketingWorkspace(page);
  await campaignSave(page).click();
  await expect(panel.getByRole("alert")).toContainText(
    "캠페인 초안 저장 결과를 확인하지 못했습니다. 입력은 유지했습니다",
  );
  await expect(panel.getByRole("alert")).toContainText("서버 처리 결과");
  await expect(campaignTitle(page)).toHaveValue("[TEST] New arrivals");
  await expect(campaignBody(page)).toHaveValue(
    "Synthetic new arrivals message. No actual send.",
  );
  await expect(campaignChannel(page, "이메일")).toBeChecked();
  await expect(campaignChannel(page, "SMS")).toBeChecked();
  await expect(panel.getByRole("status")).toHaveCount(0);
  await expect(panel.getByText("초안 저장 · 발송 없음", { exact: true })).toHaveCount(
    0,
  );
  await expect(
    panel.getByRole("button", { name: "이 화면에 초안 준비", exact: true }),
  ).toHaveCount(0);
  expect(audit.syntheticWrites).toEqual([
    "POST https://api.sales.test/prod/admin/campaigns",
  ]);
});

test("marketing redesign: mobile channels form and preview fit 375 and 320 with 44-pixel targets", async ({
  page,
}, testInfo) => {
  await page.setViewportSize({ width: 375, height: 900 });
  const audit = await setup(page, { path: "/admin?section=marketing" });
  await fillCampaign(
    page,
    `SYNTHETIC_${"LONG_TITLE_".repeat(8)}`,
    `SYNTHETIC_${"LONG_MESSAGE_".repeat(20)}`,
  );
  for (const label of ["이메일", "SMS", "푸시"])
    await campaignChannel(page, label).check();
  for (const width of [375, 320]) {
    await page.setViewportSize({ width, height: 900 });
    expect(
      await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth),
    ).toBe(true);
    for (const label of ["이메일", "SMS", "푸시"]) {
      expect(
        (
          await campaignChannel(page, label)
            .locator("xpath=ancestor::label[1]")
            .boundingBox()
        )?.height,
      ).toBeGreaterThanOrEqual(44);
      expect(
        (
          await campaignPreview(page)
            .getByRole("button", { name: `${label} 미리보기`, exact: true })
            .boundingBox()
        )?.height,
      ).toBeGreaterThanOrEqual(44);
    }
    expect((await campaignTitle(page).boundingBox())?.height).toBeGreaterThanOrEqual(
      44,
    );
    expect((await campaignSave(page).boundingBox())?.height).toBeGreaterThanOrEqual(44);
    await page.screenshot({
      path: testInfo.outputPath(`marketing-redesign-mobile-${width}.png`),
      fullPage: true,
    });
    await campaignPreview(page).screenshot({
      path: testInfo.outputPath(`marketing-redesign-mobile-preview-${width}.png`),
    });
  }
  expect(audit.syntheticWrites).toEqual([]);
});

test("marketing redesign: draft save remains readable on hover and keyboard focus in both themes", async ({
  page,
}) => {
  const audit = await setup(page, { path: "/admin?section=marketing" });
  await fillCampaign(page);
  const action = campaignSave(page);
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
      console.log(`Campaign save contrast ${theme}/${state}: ${contrast}`);
      expect(contrast).toBeGreaterThanOrEqual(4.5);
    }
  }
  expect(audit.syntheticWrites).toEqual([]);
});
