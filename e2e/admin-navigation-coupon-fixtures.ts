// 역할: 쿠폰 초안 검사용 입력 선택·양식 채우기·저장 응답 도우미를 제공함.
import { type Page, type Route } from "@playwright/test";
import { DAY, respond } from "./admin-navigation-base-fixtures";

const couponWorkspace = (page: Page) => page.locator("#admin-panel-coupons");

// 양식 입력 요소만 고름: "<label> 도움말" 이름의 '?' 도움말 버튼도 같은 라벨 글자를 포함함.
const couponField = (page: Page, label: string) =>
  couponWorkspace(page)
    .getByLabel(label, { exact: false })
    .and(page.locator("input, select, textarea"));

async function fillCoupon(
  page: Page,
  options: {
    name?: string;
    code?: string;
    type?: "percent" | "amount";
    value?: string;
    date?: string;
  } = {},
) {
  await couponField(page, "쿠폰명 (필수)").fill(
    options.name ?? "[TEST] Welcome coupon",
  );
  await couponField(page, "쿠폰 코드 (필수)").fill(options.code ?? "test_welcome10");
  await couponField(page, "혜택 유형").selectOption(options.type ?? "percent");
  await couponField(
    page,
    options.type === "amount" ? "할인 금액 (원) (필수)" : "할인율 (%) (필수)",
  ).fill(options.value ?? "10");
  if (options.date !== undefined)
    await couponField(page, "만료 시각 (한국 시간·선택)").fill(options.date);
}

async function savedCoupon(route: Route) {
  const draft = route.request().postDataJSON();
  await respond(
    route,
    {
      record: {
        couponId: "coupon_synthetic_draft",
        ...draft,
        status: "DRAFT",
        minimumOrderAmount: 0,
        version: 1,
        createdAt: `${DAY}T14:00:00.000Z`,
        updatedAt: `${DAY}T14:00:00.000Z`,
      },
    },
    201,
  );
}

export { couponField, couponWorkspace, fillCoupon, savedCoupon };
