import { expect, type Page } from "@playwright/test";
import { active, type Audit, DAY } from "./admin-navigation-base-fixtures";
import { productPreview } from "./admin-navigation-product-fixtures";

const completeOverview = {
  asOf: `${DAY}T14:00:00.000Z`,
  timezone: "Asia/Seoul",
  todayOrderCount: 3,
  todayPaidRevenue: 139_000,
  todaySoldItemCount: 5,
  todayNewMemberCount: 2,
  lowStockCount: 4,
  lowStockThreshold: 3,
  activeCouponCount: 7,
  marketingConsentCount: 11,
};

function overviewMetric(page: Page, label: string) {
  return page
    .locator("#admin-panel-overview article")
    .filter({ has: page.getByText(label, { exact: true }) });
}

function expectNoHomePrivateReads(audit: Audit) {
  expect(
    audit.reads.filter((path) =>
      /^\/prod\/(?:admin\/(?:members|sales|orders)(?:\/|$)|orders(?:\/|$))/u.test(path),
    ),
  ).toEqual([]);
}

async function checkHomePrivateCreateHistory(page: Page, audit: Audit) {
  const home = page.url();
  const initialLength = await page.evaluate(() => history.length);
  const create = page.getByRole("button", { name: "새 상품", exact: true });
  await create.focus();
  await create.press("Enter");
  await active(page, "products");
  await expect(
    page.getByRole("heading", { name: "새 상품", exact: true }),
  ).toBeVisible();
  await expect(
    page.getByRole("checkbox", { name: "저장 후 스토어에 공개", exact: true }),
  ).not.toBeChecked();
  await expect(
    page.getByRole("button", { name: "비공개로 저장", exact: true }),
  ).toBeVisible();
  // The preview note now sits behind the preview's '?' help.
  await productPreview(page)
    .getByRole("button", { name: "고객 화면 미리보기 도움말", exact: true })
    .click();
  await expect(page.getByRole("dialog")).toContainText("아직 고객에게 보이지 않습니다");
  await page.keyboard.press("Escape");
  await expect(page.getByRole("dialog")).toHaveCount(0);
  const editorUrl = page.url();
  expect(new URL(editorUrl).searchParams.get("editor")).toMatch(
    /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i,
  );
  // A prior shortcut may leave a Forward entry that this new editor replaces.
  // Back must still return directly to Home, not to a second editor entry.
  expect(await page.evaluate(() => history.length)).toBeLessThanOrEqual(
    initialLength + 1,
  );
  expect(await page.evaluate(() => history.length)).toBeGreaterThanOrEqual(
    initialLength,
  );
  const name = "HOME_CTA_UNSAVED_PRIVATE_DRAFT";
  await page.getByRole("textbox", { name: "상품명", exact: false }).fill(name);
  const persisted = await page.evaluate(() =>
    JSON.stringify({
      href: location.href,
      history: history.state,
      session: { ...sessionStorage },
      local: { ...localStorage },
    }),
  );
  expect(persisted).not.toContain(name);
  await page.goBack();
  await active(page, "overview");
  await expect(page).toHaveURL(home);
  await page.goForward();
  await active(page, "products");
  await expect(page).toHaveURL(editorUrl);
  await expect(page.getByRole("textbox", { name: "상품명", exact: false })).toHaveValue(
    name,
  );
  await expect(
    page.getByRole("checkbox", { name: "저장 후 스토어에 공개", exact: true }),
  ).not.toBeChecked();
  await page.goBack();
  await active(page, "overview");
  expect(audit.syntheticWrites).toEqual([]);
  expectNoHomePrivateReads(audit);
}

export {
  checkHomePrivateCreateHistory,
  completeOverview,
  expectNoHomePrivateReads,
  overviewMetric,
};
