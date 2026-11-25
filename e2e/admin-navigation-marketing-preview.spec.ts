import { expect, test } from "@playwright/test";
import { boxOf, guideLines } from "./admin-navigation-accessibility-fixtures";
import { audits, setup } from "./admin-navigation-base-fixtures";
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

test("marketing logo: email preview always starts with the inline PARADAYS logo while SMS and push state that images are unsupported", async ({
  page,
}, testInfo) => {
  await page.setViewportSize({ width: 1440, height: 1000 });
  const audit = await setup(page, { path: "/admin?section=marketing" });
  const panel = marketingWorkspace(page);
  await fillCampaign(page);
  for (const label of ["이메일", "SMS", "푸시"])
    await campaignChannel(page, label).check();
  await expect(
    panel.getByText("로고 본문 삽입 · 발송 미연결", { exact: true }),
  ).toBeVisible();
  await expect(
    panel.getByText("이미지 불가 · 발송 미연결", { exact: true }),
  ).toBeVisible();
  await expect(
    panel.getByText("이미지 미연결 · 발송 미연결", { exact: true }),
  ).toBeVisible();
  const preview = campaignPreview(page);
  await preview.getByRole("button", { name: "이메일 미리보기", exact: true }).click();
  const logo = preview.getByRole("img", { name: "PARADAYS", exact: true });
  await expect(logo).toBeVisible();
  expect(decodeURIComponent((await logo.getAttribute("src")) ?? "")).toContain(
    "/brand/paradays-logo.jpg",
  );
  expect(
    await logo.evaluate((img: HTMLImageElement) => img.complete && img.naturalWidth),
  ).toBe(996);
  const logoBox = (await logo.boundingBox())!;
  const titleBox = (await preview
    .getByText("[TEST] New arrivals", { exact: true })
    .boundingBox())!;
  expect(logoBox.y + logoBox.height).toBeLessThanOrEqual(titleBox.y);
  await expect(preview).toContainText("본문 삽입(인라인 이미지) · 항상 맨 위");
  await preview.screenshot({ path: testInfo.outputPath("marketing-logo-email.png") });
  console.log(`Marketing logo screenshots: ${testInfo.outputPath()}`);
  for (const label of ["SMS", "푸시"]) {
    await preview
      .getByRole("button", { name: `${label} 미리보기`, exact: true })
      .click();
    await expect(preview.getByRole("img")).toHaveCount(0);
    await expect(preview).toContainText("로고 이미지 미포함");
  }
  await expect(preview).toContainText(
    "푸시 알림 이미지는 기기·발송 서비스 연결이 필요합니다",
  );
  await preview.getByRole("button", { name: "SMS 미리보기", exact: true }).click();
  await expect(preview).toContainText("일반 SMS는 본문에 이미지를 넣을 수 없습니다");
  await expect(panel.getByText(/^(?:발송 가능|발송 완료|연결 완료)$/)).toHaveCount(0);
  expect(audit.syntheticWrites).toEqual([]);
});

test("screen guide walks the campaign channels, title, message, preview and save button", async ({
  page,
}) => {
  await setup(page, { path: "/admin?section=marketing" });
  const open = marketingWorkspace(page).getByRole("button", {
    name: "화면 도움말",
    exact: true,
  });
  await open.click();
  const bubble = page.getByRole("dialog");
  await expect(bubble).toContainText("1/5단계");
  await expect(bubble.getByRole("heading")).toHaveText("보낼 곳 고르기");
  await page.keyboard.press("ArrowRight");
  await expect(bubble.getByRole("heading")).toHaveText("제목 쓰기");
  await page.keyboard.press("ArrowRight");
  await expect(bubble.getByRole("heading")).toHaveText("내용 쓰기");
  // The message box is underlined right below it.
  await expect
    .poll(async () => {
      const target = await boxOf(campaignBody(page));
      const line = await boxOf(guideLines(page).first());
      return Math.abs(line.y - (target.y + target.height)) <= 6;
    })
    .toBe(true);
  await page.keyboard.press("ArrowRight");
  await expect(bubble.getByRole("heading")).toHaveText("모습 확인");
  await page.keyboard.press("ArrowRight");
  await expect(bubble.getByRole("heading")).toHaveText("저장하기");
  await page.keyboard.press("Escape");
  await expect(bubble).toHaveCount(0);
  await expect(open).toBeFocused();
});

test("marketing redesign: channel choices and live previews do not send messages or invent recipient or connection status", async ({
  page,
}, testInfo) => {
  await page.setViewportSize({ width: 1440, height: 1000 });
  const audit = await setup(page, { path: "/admin?section=marketing" });
  const panel = marketingWorkspace(page);
  await fillCampaign(page);
  for (const label of ["이메일", "SMS", "푸시"])
    await campaignChannel(page, label).check();
  const preview = campaignPreview(page);
  for (const label of ["이메일", "SMS", "푸시"]) {
    await preview
      .getByRole("button", { name: `${label} 미리보기`, exact: true })
      .click();
    await expect(
      preview.getByRole("heading", { name: `${label} 미리보기`, exact: true }),
    ).toBeVisible();
    await expect(preview).toContainText("[TEST] New arrivals");
    await expect(preview).toContainText(
      "Synthetic new arrivals message. No actual send.",
    );
    await expect(
      preview.getByRole("button", { name: `${label} 미리보기`, exact: true }),
    ).toHaveAttribute("aria-pressed", "true");
  }
  await expect(
    panel.getByText("수신 대상 미조회 · 발송 없음", { exact: true }),
  ).toBeVisible();
  await expect(
    panel.getByText(
      /^(?:수신 대상 0명|대상자 0명|연결 완료|발송 가능|예약 완료|발송 완료)$/,
    ),
  ).toHaveCount(0);
  await expect(
    panel.getByRole("button", { name: /지금 발송|예약하기|이미지 첨부|대상자 조회/ }),
  ).toHaveCount(0);
  // The safety notice stays on screen without opening any help.
  await expect(
    panel.getByText(/수신자 조회·예약·발송·이미지 첨부는 지원하지 않습니다/),
  ).toBeVisible();
  await expect(panel.locator("summary", { hasText: /^도움말$/ })).toHaveCount(0);
  // What the old header help said now sits in the channel '?'.
  await panel.getByRole("button", { name: "채널 선택 도움말", exact: true }).click();
  const channelHelp = page.getByRole("dialog", {
    name: "채널 선택 도움말",
    exact: true,
  });
  await expect(
    channelHelp.getByText(
      /실제 채널 연결 상태나 발송 가능 여부를 확인하는 표시가 아닙니다/,
    ),
  ).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(channelHelp).toHaveCount(0);
  const formBox = await panel
    .getByRole("form", { name: "캠페인 초안 작성", exact: true })
    .boundingBox();
  const previewBox = await preview.boundingBox();
  expect(formBox).not.toBeNull();
  expect(previewBox).not.toBeNull();
  expect(previewBox!.x).toBeGreaterThan(formBox!.x + formBox!.width - 1);
  expect(
    await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth),
  ).toBe(true);
  await page.screenshot({
    path: testInfo.outputPath("marketing-redesign-desktop-1440.png"),
    fullPage: true,
  });
  expect(audit.syntheticWrites).toEqual([]);
  expect(
    audit.reads.filter((path) => /campaigns|members|consent|audience/.test(path)),
  ).toEqual([]);
});

test("marketing redesign: a deliberate multichannel draft saves only supported fields and editing clears the previous saved indication", async ({
  page,
}) => {
  const commands: unknown[] = [];
  const audit = await setup(page, {
    path: "/admin?section=marketing",
    handleCampaignMutation: async (route) => {
      commands.push(route.request().postDataJSON());
      expect(route.request().headers().authorization).toMatch(/^Bearer /);
      await savedCampaign(route);
    },
  });
  const panel = marketingWorkspace(page);
  await fillCampaign(
    page,
    "  [TEST] Three-channel draft  ",
    "  Synthetic body\nNew paragraph.  ",
  );
  for (const label of ["이메일", "SMS", "푸시"])
    await campaignChannel(page, label).check();
  await campaignSave(page).click();
  await expect.poll(() => commands.length).toBe(1);
  expect(commands[0]).toEqual({
    title: "[TEST] Three-channel draft",
    body: "Synthetic body\nNew paragraph.",
    channels: ["EMAIL", "SMS", "PUSH"],
  });
  await expect(panel.getByRole("status")).toContainText("고객에게 발송하지 않았습니다");
  await expect(panel.getByText("초안 저장 · 발송 없음", { exact: true })).toBeVisible();
  await campaignTitle(page).fill("[TEST] Edited push draft");
  await expect(panel.getByRole("status")).toHaveCount(0);
  await expect(panel.getByText("미리보기 · 발송 없음", { exact: true })).toBeVisible();
  await campaignChannel(page, "이메일").uncheck();
  await campaignChannel(page, "SMS").uncheck();
  await campaignSave(page).click();
  await expect.poll(() => commands.length).toBe(2);
  expect(commands[1]).toEqual({
    title: "[TEST] Edited push draft",
    body: "Synthetic body\nNew paragraph.",
    channels: ["PUSH"],
  });
  expect(audit.syntheticWrites).toEqual(
    Array(2).fill("POST https://api.sales.test/prod/admin/campaigns"),
  );
});

test("marketing redesign: blank content and choosing no channel cannot submit or show an active channel preview", async ({
  page,
}) => {
  const audit = await setup(page, { path: "/admin?section=marketing" });
  const panel = marketingWorkspace(page);
  await expect(campaignSave(page)).toBeDisabled();
  await fillCampaign(page);
  for (const label of ["이메일", "SMS", "푸시"])
    await campaignChannel(page, label).uncheck();
  await expect(campaignSave(page)).toBeDisabled();
  await expect(
    campaignPreview(page).getByText("초안에 포함할 채널을 하나 이상 선택해 주세요.", {
      exact: true,
    }),
  ).toBeVisible();
  await expect(campaignPreview(page).getByRole("button")).toHaveCount(0);
  const form = panel.getByRole("form", { name: "캠페인 초안 작성", exact: true });
  await form.evaluate((element: HTMLFormElement) => element.requestSubmit());
  await expect(panel.getByRole("alert")).toBeVisible();
  await campaignChannel(page, "이메일").check();
  await campaignTitle(page).fill("   ");
  await expect(campaignSave(page)).toBeDisabled();
  await form.evaluate((element: HTMLFormElement) => element.requestSubmit());
  await campaignTitle(page).fill("[TEST] Valid title");
  await campaignBody(page).fill("\n  ");
  await expect(campaignSave(page)).toBeDisabled();
  await form.evaluate((element: HTMLFormElement) => element.requestSubmit());
  expect(audit.syntheticWrites).toEqual([]);
});

test("marketing redesign: title and body limits match the draft API without claiming SMS delivery sizing", async ({
  page,
}) => {
  const commands: Array<Record<string, unknown>> = [];
  const audit = await setup(page, {
    path: "/admin?section=marketing",
    handleCampaignMutation: async (route) => {
      commands.push(route.request().postDataJSON());
      await savedCampaign(route);
    },
  });
  await expect(campaignTitle(page)).toHaveAttribute("maxlength", "160");
  await expect(campaignBody(page)).toHaveAttribute("maxlength", "8000");
  await fillCampaign(page, "T".repeat(160), "B".repeat(8000));
  await campaignChannel(page, "SMS").check();
  await campaignChannel(page, "이메일").uncheck();
  await campaignPreview(page)
    .getByRole("button", { name: "SMS 미리보기", exact: true })
    .click();
  await expect(campaignPreview(page)).toContainText(
    "문자 분할·발송 비용·인코딩은 계산하지 않습니다",
  );
  await campaignSave(page).click();
  await expect.poll(() => commands.length).toBe(1);
  expect(commands[0]).toEqual({
    title: "T".repeat(160),
    body: "B".repeat(8000),
    channels: ["SMS"],
  });
  expect(audit.syntheticWrites).toEqual([
    "POST https://api.sales.test/prod/admin/campaigns",
  ]);
});
