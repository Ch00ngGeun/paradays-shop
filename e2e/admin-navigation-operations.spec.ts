import { expect, test } from "@playwright/test";
import {
  operationRows,
  recentOperations,
} from "./admin-navigation-accessibility-fixtures";
import {
  audits,
  ORIGIN,
  respond,
  select,
  setup,
} from "./admin-navigation-base-fixtures";
import {
  couponField,
  couponWorkspace,
  fillCoupon,
  savedCoupon,
} from "./admin-navigation-coupon-fixtures";
import {
  completeOverview,
  expectNoHomePrivateReads,
  overviewMetric,
} from "./admin-navigation-home-fixtures";
import {
  inventoryProducts,
  inventoryWorkspace,
  selectInventory,
} from "./admin-navigation-inventory-fixtures";
import {
  campaignSave,
  fillCampaign,
  marketingWorkspace,
  savedCampaign,
} from "./admin-navigation-marketing-fixtures";
import { newProduct } from "./admin-navigation-product-fixtures";

test.afterEach(async ({ page }) => {
  expect(audits.get(page)?.blocked ?? []).toEqual([]);
});

test("accessible operations: colored metric icons and an honest empty session history render without private reads", async ({
  page,
}, testInfo) => {
  await page.setViewportSize({ width: 1440, height: 1000 });
  const audit = await setup(page, {
    handleOverview: (route) => respond(route, completeOverview),
  });
  for (const [label, tone] of [
    ["오늘 매출", "green"],
    ["오늘 주문(건)", "blue"],
    ["판매 상품 수량(개)", "purple"],
  ]) {
    await expect(
      overviewMetric(page, label!).locator("div[data-tone]"),
    ).toHaveAttribute("data-tone", tone!);
  }
  const cartPath = await overviewMetric(page, "오늘 주문(건)")
    .locator("svg path")
    .getAttribute("d");
  expect(cartPath).toContain("M2 3h3");
  expect(
    await page
      .getByRole("tab", { name: "홈(운영현황)", exact: true })
      .locator("svg path")
      .getAttribute("d"),
  ).toContain("M3 10 12 3");
  await expect(operationRows(page)).toHaveCount(0);
  // The scope note now sits behind the heading's '?' help.
  await recentOperations(page)
    .getByRole("button", { name: "최근 운영 기록 도움말", exact: true })
    .click();
  await expect(page.getByRole("dialog")).toContainText("작업별 최근 상태");
  await expect(page.getByRole("dialog")).toContainText(
    "서버 전체 운영 이력이 아닙니다",
  );
  await page.keyboard.press("Escape");
  await expect(page.getByRole("dialog")).toHaveCount(0);
  await page.screenshot({
    path: testInfo.outputPath("accessible-home-desktop-1440.png"),
    fullPage: true,
  });
  expect(audit.syntheticWrites).toEqual([]);
  expectNoHomePrivateReads(audit);
});

test("accessible operations: product edits survive menu return with one amber task and private contents never enter storage or history", async ({
  page,
}) => {
  const audit = await setup(page, { path: "/admin?section=products" });
  await newProduct(page);
  const editor = page.url();
  const privateName = "PRIVATE_DRAFT_NOT_AN_ACTIVITY_LABEL";
  await page.getByRole("textbox", { name: "상품명", exact: false }).fill(privateName);
  await select(page, "overview");
  const row = operationRows(page);
  await expect(row).toHaveCount(1);
  await expect(row).toHaveAttribute("data-status", "working");
  await expect(row).toContainText("작업 중");
  await expect(row.locator("time")).toContainText("23:00");
  await expect(row).not.toContainText(privateName);
  expect(
    await page.evaluate(() =>
      JSON.stringify({
        session: { ...sessionStorage },
        local: { ...localStorage },
        history: history.state,
      }),
    ),
  ).not.toContain(privateName);
  await row.getByRole("button", { name: "이어서 수정", exact: false }).click();
  await expect(page).toHaveURL(editor);
  await expect(page.getByRole("textbox", { name: "상품명", exact: false })).toHaveValue(
    privateName,
  );
  await page.getByRole("button", { name: "새 초안", exact: true }).click();
  await select(page, "overview");
  await expect(operationRows(page)).toHaveCount(0);
  await page.goBack();
  await page
    .getByRole("textbox", { name: "상품명", exact: false })
    .fill("SECOND_PRIVATE_DRAFT");
  await page.getByRole("button", { name: /목록으로/ }).click();
  await select(page, "overview");
  await expect(operationRows(page)).toHaveCount(0);
  await select(page, "products");
  await newProduct(page);
  await select(page, "overview");
  await expect(operationRows(page)).toHaveCount(1);
  await page.reload();
  await expect(operationRows(page)).toHaveCount(0);
  expect(audit.syntheticWrites).toEqual([]);
});

test("accessible operations: saved coupon and campaign remain unfinished amber drafts and an uncertain save is never green", async ({
  page,
}) => {
  let failCoupon = false;
  const audit = await setup(page, {
    path: "/admin?section=coupons",
    handleCouponMutation: (route) =>
      failCoupon
        ? respond(route, { code: "SYNTHETIC_UNCERTAIN" }, 503)
        : savedCoupon(route),
    handleCampaignMutation: savedCampaign,
  });
  await fillCoupon(page);
  await couponWorkspace(page)
    .getByRole("button", { name: "쿠폰 초안 저장", exact: true })
    .click();
  await expect(couponWorkspace(page).getByRole("status")).toContainText(
    "아직 고객에게 발급되지 않았습니다",
  );
  await select(page, "overview");
  await expect(operationRows(page)).toHaveCount(1);
  await expect(operationRows(page)).toHaveAttribute("data-status", "draft");
  await expect(operationRows(page)).toContainText("임시저장");
  await expect(operationRows(page)).toContainText("고객 미발급");
  await select(page, "coupons");
  await couponField(page, "쿠폰명 (필수)").fill("PRIVATE_UPDATED_COUPON");
  await select(page, "overview");
  await expect(operationRows(page)).toHaveAttribute("data-status", "working");
  failCoupon = true;
  await select(page, "coupons");
  await couponWorkspace(page)
    .getByRole("button", { name: "쿠폰 초안 저장", exact: true })
    .click();
  await expect(couponWorkspace(page).getByRole("alert")).toBeVisible();
  await select(page, "overview");
  await expect(operationRows(page)).toHaveAttribute("data-status", "attention");
  await expect(operationRows(page)).toContainText("확인 필요");
  await select(page, "marketing");
  await fillCampaign(page, "PRIVATE_CAMPAIGN_TITLE", "PRIVATE_CAMPAIGN_BODY");
  await campaignSave(page).click();
  await expect(marketingWorkspace(page).getByRole("status")).toContainText(
    "고객에게 발송하지 않았습니다",
  );
  await select(page, "overview");
  await expect(operationRows(page).first()).toHaveAttribute("data-status", "draft");
  await expect(operationRows(page).first()).toContainText("고객 미발송");
  await expect(recentOperations(page)).not.toContainText("PRIVATE_");
  await expect(
    recentOperations(page).locator('li[data-status="complete"]'),
  ).toHaveCount(0);
  expect(audit.syntheticWrites).toHaveLength(3);
});

test("accessible operations: server-confirmed stock saves alone become complete and unchanged stock never creates a record", async ({
  page,
}) => {
  let product = { ...inventoryProducts[0] };
  const audit = await setup(page, {
    path: "/admin?section=inventory",
    handleCatalog: (route) => respond(route, { products: [product] }),
    handleProductMutation: (route) => {
      product = {
        ...product,
        version: product.version + 1,
        inventoryQuantity: Number(route.request().postDataJSON().stock),
      };
      return respond(route, { product });
    },
  });
  const input = await selectInventory(page);
  await expect(
    page.getByRole("button", { name: "재고 변경 내용 확인", exact: true }),
  ).toBeDisabled();
  await select(page, "overview");
  await expect(operationRows(page)).toHaveCount(0);
  await select(page, "inventory");
  await selectInventory(page);
  await input.fill("12");
  page.once("dialog", (dialog) => void dialog.accept());
  await page.getByRole("button", { name: "재고 변경 내용 확인", exact: true }).click();
  await expect(
    inventoryWorkspace(page)
      .getByRole("status")
      .filter({ hasText: /^저장 완료$/ }),
  ).toBeVisible();
  await select(page, "overview");
  await expect(operationRows(page)).toHaveCount(1);
  await expect(operationRows(page)).toHaveAttribute("data-status", "complete");
  await expect(operationRows(page)).toContainText(
    "서버가 재고 수량 변경을 확인했습니다",
  );
  expect(audit.syntheticWrites).toHaveLength(1);
});

test("accessible operations: history is bounded and one unsaved task update stays at the top without manufacturing extra events", async ({
  page,
}) => {
  const audit = await setup(page, { path: "/admin?section=products" });
  for (let index = 0; index < 14; index++) {
    await newProduct(page);
    await page
      .getByRole("textbox", { name: "상품명", exact: false })
      .fill(`PRIVATE_${index}`);
    await select(page, "overview");
    if (index < 13) await select(page, "products");
  }
  await expect(operationRows(page)).toHaveCount(5);
  await recentOperations(page)
    .getByRole("button", { name: "전체보기", exact: true })
    .click();
  await expect(operationRows(page)).toHaveCount(12);
  await expect(recentOperations(page)).not.toContainText("PRIVATE_");
  expect(audit.syntheticWrites).toEqual([]);
});

test("accessible operations: an evicted editor has no dead resume link and opens only the product menu", async ({
  page,
}) => {
  const audit = await setup(page, { path: "/admin?section=products" });
  let oldestEditor = "";
  for (let index = 0; index < 20; index++) {
    await newProduct(page);
    if (index === 0) oldestEditor = page.url();
    await select(page, "products");
  }
  await page.evaluate((url) => {
    history.pushState(null, "", url);
    dispatchEvent(new PopStateEvent("popstate"));
  }, oldestEditor);
  await page
    .getByRole("textbox", { name: "상품명", exact: false })
    .fill("PRIVATE_OLD_EDITOR_MOVED_TO_RECENT");
  await select(page, "products");
  await newProduct(page);
  await select(page, "overview");
  const stale = operationRows(page).filter({
    hasText: "편집 초안은 더 이상 열려 있지 않습니다",
  });
  await expect(stale).toHaveCount(1);
  await expect(
    stale.getByRole("button", { name: "이어서 수정", exact: false }),
  ).toHaveCount(0);
  await stale.getByRole("button", { name: "메뉴 보기", exact: false }).click();
  await expect(page).toHaveURL(`${ORIGIN}/admin?section=products`);
  await expect(
    page.getByRole("button", { name: "새 상품 등록", exact: true }),
  ).toBeVisible();
  expect(audit.syntheticWrites).toEqual([]);
});
