// 역할: 상품 목록·편집기의 비공개 초안·파일이 방문 기록으로 복원되고 저장 뒤 이전 항목이 무효화되는지 검증함.
import { expect, test } from "@playwright/test";
import {
  active,
  audits,
  products,
  respond,
  select,
  setup,
} from "./admin-navigation-base-fixtures";

test.afterEach(async ({ page }) => {
  expect(audits.get(page)?.blocked ?? []).toEqual([]);
});

test("product list/create history restores the same private draft and file without persisting them in URL, history or storage", async ({
  page,
}) => {
  await setup(page, { products: true });
  await select(page, "products");
  await page.getByRole("button", { name: "새 상품 등록", exact: true }).click();
  const draftName = "UNSAVED_PRIVATE_HISTORY_DRAFT";
  await page.getByRole("textbox", { name: "상품명", exact: false }).fill(draftName);
  await page
    .locator('input[type="file"]')
    .and(page.getByLabel("대표 이미지", { exact: false }))
    .setInputFiles({
      name: "synthetic-private-upload.png",
      mimeType: "image/png",
      buffer: Buffer.from(
        "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aRfsAAAAASUVORK5CYII=",
        "base64",
      ),
    });
  const editorUrl = page.url();
  const editor = new URL(editorUrl).searchParams.get("editor");
  expect(editor).toMatch(
    /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i,
  );
  const privateSurface = await page.evaluate(() =>
    JSON.stringify({
      href: location.href,
      history: history.state,
      session: { ...sessionStorage },
      local: { ...localStorage },
    }),
  );
  expect(privateSurface).not.toContain(draftName);
  expect(privateSurface).not.toContain("synthetic-private-upload.png");
  expect(privateSurface).not.toContain("blob:");
  await page.goBack();
  await expect(
    page.getByRole("button", { name: "새 상품 등록", exact: true }),
  ).toBeVisible();
  await page.goForward();
  await expect(page).toHaveURL(editorUrl);
  await expect(page.getByRole("textbox", { name: "상품명", exact: false })).toHaveValue(
    draftName,
  );
  await expect(
    page.getByAltText(`${draftName} 상품 이미지 미리보기`, { exact: true }),
  ).toHaveAttribute("src", /^blob:/);
  await page.getByRole("button", { name: "← 목록으로", exact: true }).click();
  await expect(
    page.getByRole("button", { name: "새 상품 등록", exact: true }),
  ).toBeVisible();
  await page.evaluate((url) => {
    history.pushState(null, "", url);
    dispatchEvent(new PopStateEvent("popstate"));
  }, editorUrl);
  await expect(
    page.getByRole("button", { name: "새 상품 등록", exact: true }),
  ).toBeVisible();
  await expect(page.getByRole("textbox", { name: "상품명", exact: false })).toHaveCount(
    0,
  );
});

test("separate product editors restore A and B independently across Back and Forward", async ({
  page,
}) => {
  await setup(page, { products: true });
  await select(page, "products");
  await page
    .getByRole("listitem")
    .filter({ hasText: products[0]!.name })
    .getByRole("button", { name: "수정", exact: true })
    .click();
  await page
    .getByRole("textbox", { name: "상품명", exact: false })
    .fill("PRIVATE_EDIT_A");
  const editorA = page.url();
  await select(page, "brands");
  await select(page, "products");
  await page
    .getByRole("listitem")
    .filter({ hasText: products[1]!.name })
    .getByRole("button", { name: "수정", exact: true })
    .click();
  await page
    .getByRole("textbox", { name: "상품명", exact: false })
    .fill("PRIVATE_EDIT_B");
  const editorB = page.url();
  expect(editorB).not.toBe(editorA);
  await page.goBack();
  await expect(
    page.getByRole("button", { name: "새 상품 등록", exact: true }),
  ).toBeVisible();
  await page.goBack();
  await active(page, "brands");
  await page.goBack();
  await expect(page).toHaveURL(editorA);
  await expect(page.getByRole("textbox", { name: "상품명", exact: false })).toHaveValue(
    "PRIVATE_EDIT_A",
  );
  await page.goForward();
  await active(page, "brands");
  await page.goForward();
  await expect(
    page.getByRole("button", { name: "새 상품 등록", exact: true }),
  ).toBeVisible();
  await page.goForward();
  await expect(page).toHaveURL(editorB);
  await expect(page.getByRole("textbox", { name: "상품명", exact: false })).toHaveValue(
    "PRIVATE_EDIT_B",
  );
});

test("reload and direct or invalid editor identities fall back to product list without selecting a different product", async ({
  page,
}) => {
  await setup(page, { products: true });
  await select(page, "products");
  await page
    .getByRole("listitem")
    .filter({ hasText: products[0]!.name })
    .getByRole("button", { name: "수정", exact: true })
    .click();
  const editorUrl = page.url();
  await page.reload();
  await active(page, "products");
  await expect(
    page.getByRole("button", { name: "새 상품 등록", exact: true }),
  ).toBeVisible();
  for (const url of [
    editorUrl,
    "/admin?section=products&editor=invalid",
    "/admin?section=products&editor=11111111-1111-4111-8111-111111111111",
  ]) {
    await page.goto(url);
    await active(page, "products");
    await expect(
      page.getByRole("button", { name: "새 상품 등록", exact: true }),
    ).toBeVisible();
    await expect(
      page.getByRole("textbox", { name: "상품명", exact: false }),
    ).toHaveCount(0);
  }
});

test("a synthetic product save completed after moving away leaves the current menu unchanged and invalidates the old editor", async ({
  page,
}) => {
  let release!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const audit = await setup(page, {
    products: true,
    handleProductMutation: async (route) => {
      await gate;
      await respond(route, {});
    },
  });
  await select(page, "products");
  await page
    .getByRole("listitem")
    .filter({ hasText: products[0]!.name })
    .getByRole("button", { name: "수정", exact: true })
    .click();
  await page.getByRole("button", { name: /^(?:수정 저장|비공개 수정 저장)$/ }).click();
  await expect.poll(() => audit.syntheticWrites.length).toBe(1);
  await select(page, "brands");
  const brandsUrl = page.url();
  release();
  await expect
    .poll(
      () => audit.reads.filter((url) => url === "/prod/admin/catalog/products").length,
    )
    .toBe(2);
  await expect(page).toHaveURL(brandsUrl);
  await active(page, "brands");
  await page.goBack();
  await active(page, "products");
  await expect(
    page.getByRole("button", { name: "새 상품 등록", exact: true }),
  ).toBeVisible();
  expect(audit.syntheticWrites).toEqual([
    "PATCH https://api.sales.test/prod/admin/catalog/products/prd_synthetic_A",
  ]);
});
