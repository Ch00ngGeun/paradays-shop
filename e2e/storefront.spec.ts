// 역할: 검색 표시, 장바구니 라우팅, 반응형 내비게이션의 핵심 브라우저 동작을 검증합니다.
import { expect, test } from "@playwright/test";

/** 검색 모달이 URL 변경 없이 열리고 Escape로 닫히는지 확인 */
test("search opens in place and closes with Escape", async ({ page }) => {
  await page.goto("/");
  await page.getByRole("button", { name: "Search" }).click();

  await expect(page.getByRole("dialog", { name: "Search PARADAYS" })).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(page.getByRole("dialog", { name: "Search PARADAYS" })).toBeHidden();
  await expect(page).toHaveURL(/\/$/);
});

/** Cart 링크가 `/cart`로 이동하는지 확인 */
test("cart link navigates to the dedicated cart route", async ({ page }) => {
  await page.goto("/");
  await page.getByRole("link", { name: /Cart/ }).click();

  await expect(page).toHaveURL(/\/cart$/);
  await expect(page.getByRole("heading", { name: "Your Cart" })).toBeVisible();
});

/** 상품 카드가 해당 slug 상세로만 이동하는지 확인 */
test("product card opens the only product-detail route", async ({ page }) => {
  await page.goto("/");
  await page
    .getByRole("link", { name: "O'Dwyer 'Sync 1' [8.375”] 상품상세 보기" })
    .click();

  await expect(page).toHaveURL(/\/products\/odwyer-sync-1-8-375$/);
  await expect(
    page.getByRole("heading", { name: "O'Dwyer 'Sync 1' [8.375”]" }),
  ).toBeVisible();
});

/** 모바일 Menu는 PC와 같은 드롭다운을 클릭으로 열고, 필터 선택 후에도 메뉴가 유지되는지 확인 */
test("mobile menu opens the shared dropdown on click", async ({ page }) => {
  await page.setViewportSize({ width: 375, height: 812 });
  await page.goto("/");
  await page.getByRole("button", { name: "Menu" }).click();

  const dropdown = page.locator("#store-menu-dropdown");
  await expect(dropdown).toBeVisible();
  await expect(dropdown.getByRole("button", { name: "All" }).first()).toBeVisible();
  await expect(dropdown.getByText("Clothes")).toBeVisible();
  await expect(dropdown.getByText("Brand")).toBeVisible();
  await expect(dropdown.getByRole("button", { name: "April" })).toBeVisible();
  await dropdown.getByRole("button", { name: "Deck" }).click();
  await expect(page).toHaveURL(/\/$/);
  await expect(dropdown.getByRole("button", { name: "Deck" })).toHaveAttribute(
    "aria-pressed",
    "true",
  );
  await expect(dropdown).toBeVisible();
});
