// 역할: 관리자 메뉴별 작업 단계 표시가 조회 결과·입력·선택 상태를 따르는지 검증함.
import { expect, test } from "@playwright/test";
import { flowStates } from "./admin-navigation-accessibility-fixtures";
import { audits, respond, select, setup } from "./admin-navigation-base-fixtures";
import { brandNameInput } from "./admin-navigation-brand-fixtures";
import { fillCoupon } from "./admin-navigation-coupon-fixtures";
import { completeOverview } from "./admin-navigation-home-fixtures";
import {
  inventoryProducts,
  selectInventory,
} from "./admin-navigation-inventory-fixtures";
import { campaignChannel, fillCampaign } from "./admin-navigation-marketing-fixtures";
import {
  loadMembers,
  memberChoice,
  memberDetail,
  prepareMemberGroup,
  setupMembers,
} from "./admin-navigation-member-fixtures";

test.afterEach(async ({ page }) => {
  expect(audits.get(page)?.blocked ?? []).toEqual([]);
});

test("work flow: home steps follow the loaded overview and never claim the day close", async ({
  page,
}) => {
  await setup(page, { handleOverview: (route) => respond(route, completeOverview) });
  await expect
    .poll(() => flowStates(page, "홈 작업 흐름"))
    .toEqual(["complete", "current", "upcoming"]);
  const flow = page.getByRole("list", { name: "홈 작업 흐름", exact: true });
  await expect(flow.locator('[aria-current="step"]')).toContainText("재고 확인");
  await flow.screenshot({ path: test.info().outputPath("home-work-flow.png") });
  console.log(`Work flow screenshot: ${test.info().outputPath()}`);
});

test("work flow: home with no low stock moves to sales; a failed overview stays on the first step", async ({
  page,
}) => {
  await setup(page);
  await expect
    .poll(() => flowStates(page, "홈 작업 흐름"))
    .toEqual(["complete", "complete", "current"]);
  await page.unrouteAll({ behavior: "ignoreErrors" });
  await setup(page, {
    handleOverview: (route) =>
      route.fulfill({
        status: 503,
        json: { code: "SYNTHETIC_UNAVAILABLE" },
        headers: { "access-control-allow-origin": "*" },
      }),
  });
  await page.reload();
  await expect
    .poll(() => flowStates(page, "홈 작업 흐름"))
    .toEqual(["current", "upcoming", "upcoming"]);
});

test("work flow: product and inventory steps follow the open editor and the selected product", async ({
  page,
}) => {
  const audit = await setup(page, {
    path: "/admin?section=products",
    catalogProducts: inventoryProducts,
  });
  await expect
    .poll(() => flowStates(page, "상품 작업 흐름"))
    .toEqual(["current", "upcoming", "upcoming"]);
  await page.getByRole("button", { name: "새 상품 등록", exact: true }).click();
  await expect
    .poll(() => flowStates(page, "상품 작업 흐름"))
    .toEqual(["complete", "current", "upcoming"]);
  await expect(
    page.getByRole("list", { name: "상품 작업 흐름", exact: true }),
  ).toContainText("서버 저장·공개");
  await select(page, "inventory");
  await expect
    .poll(() => flowStates(page, "재고 작업 흐름"))
    .toEqual(["current", "upcoming", "upcoming"]);
  await selectInventory(page);
  await expect
    .poll(() => flowStates(page, "재고 작업 흐름"))
    .toEqual(["complete", "current", "upcoming"]);
  expect(audit.syntheticWrites).toEqual([]);
});

test("work flow: coupon and campaign steps follow validity and never complete issuing or sending", async ({
  page,
}) => {
  const audit = await setup(page, { path: "/admin?section=coupons" });
  await expect
    .poll(() => flowStates(page, "쿠폰 작업 흐름"))
    .toEqual(["current", "upcoming", "upcoming", "unavailable"]);
  await fillCoupon(page);
  await expect
    .poll(() => flowStates(page, "쿠폰 작업 흐름"))
    .toEqual(["complete", "complete", "current", "unavailable"]);
  await expect(
    page.getByRole("list", { name: "쿠폰 작업 흐름", exact: true }),
  ).toContainText("고객 발급 · 연결 필요");
  await select(page, "marketing");
  // 이메일은 기본으로 선택돼 있음.
  await expect
    .poll(() => flowStates(page, "캠페인 작업 흐름"))
    .toEqual(["complete", "current", "upcoming", "unavailable"]);
  await campaignChannel(page, "이메일").uncheck();
  await expect
    .poll(() => flowStates(page, "캠페인 작업 흐름"))
    .toEqual(["current", "upcoming", "upcoming", "unavailable"]);
  await campaignChannel(page, "이메일").check();
  await expect
    .poll(() => flowStates(page, "캠페인 작업 흐름"))
    .toEqual(["complete", "current", "upcoming", "unavailable"]);
  await fillCampaign(page);
  await expect
    .poll(() => flowStates(page, "캠페인 작업 흐름"))
    .toEqual(["complete", "complete", "current", "unavailable"]);
  expect(audit.syntheticWrites).toEqual([]);
});

test("work flow: brand and member steps follow the loaded list, input and selection", async ({
  page,
}) => {
  await setup(page, { path: "/admin?section=brands" });
  await expect
    .poll(() => flowStates(page, "브랜드 작업 흐름"))
    .toEqual(["complete", "current", "upcoming"]);
  await brandNameInput(page).fill("[TEST] Flow brand");
  await expect
    .poll(() => flowStates(page, "브랜드 작업 흐름"))
    .toEqual(["complete", "complete", "current"]);
  await page.unrouteAll({ behavior: "ignoreErrors" });
  await setupMembers(page);
  await expect
    .poll(() => flowStates(page, "회원 작업 흐름"))
    .toEqual(["current", "upcoming", "upcoming"]);
  await loadMembers(page);
  await expect
    .poll(() => flowStates(page, "회원 작업 흐름"))
    .toEqual(["complete", "current", "upcoming"]);
  await memberChoice(page).click();
  await expect
    .poll(() => flowStates(page, "회원 작업 흐름"))
    .toEqual(["complete", "complete", "current"]);
  await prepareMemberGroup(page, "support", true);
  page.once("dialog", (dialog) => void dialog.accept());
  await memberDetail(page)
    .getByRole("button", { name: "권한 변경 내용 확인", exact: true })
    .click();
  await expect
    .poll(() => flowStates(page, "회원 작업 흐름"))
    .toEqual(["complete", "complete", "complete"]);
});
