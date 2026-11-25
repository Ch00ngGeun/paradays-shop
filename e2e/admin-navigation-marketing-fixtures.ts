// 역할: 캠페인 초안 검사용 입력·채널·미리보기·저장 버튼 선택과 양식 채우기·저장 응답 도우미를 제공함.
import { type Page, type Route } from "@playwright/test";
import { DAY, respond } from "./admin-navigation-base-fixtures";

const marketingWorkspace = (page: Page) => page.locator("#admin-panel-marketing");

const campaignTitle = (page: Page) =>
  marketingWorkspace(page).getByLabel("캠페인 제목", { exact: false });

const campaignBody = (page: Page) =>
  marketingWorkspace(page).getByLabel("메시지", { exact: false });

async function fillCampaign(
  page: Page,
  title = "[TEST] New arrivals",
  body = "Synthetic new arrivals message. No actual send.",
) {
  await campaignTitle(page).fill(title);
  await campaignBody(page).fill(body);
}

async function savedCampaign(route: Route) {
  await respond(
    route,
    {
      record: {
        campaignId: "campaign_synthetic_draft",
        ...route.request().postDataJSON(),
        status: "DRAFT",
        audience: "MARKETING_CONSENTED",
        version: 1,
        createdAt: `${DAY}T14:00:00.000Z`,
        updatedAt: `${DAY}T14:00:00.000Z`,
      },
    },
    201,
  );
}

const campaignSave = (page: Page) =>
  marketingWorkspace(page).getByRole("button", {
    name: "캠페인 초안 저장",
    exact: true,
  });

const campaignChannel = (page: Page, label: string) =>
  marketingWorkspace(page).getByRole("checkbox", {
    name: `${label} 초안 선택`,
    exact: true,
  });

const campaignPreview = (page: Page) =>
  marketingWorkspace(page).getByRole("complementary", {
    name: "선택 채널 문구 미리보기",
    exact: true,
  });

export {
  campaignBody,
  campaignChannel,
  campaignPreview,
  campaignSave,
  campaignTitle,
  fillCampaign,
  marketingWorkspace,
  savedCampaign,
};
