import { expect, test, type Page } from "@playwright/test";
import { PNG } from "./admin-english-data-fixtures";
import {
  audits,
  setup,
  scan,
  scanHelp,
  scanGuide,
  expectClean,
} from "./admin-english-fixtures";

test.afterEach(async ({ page }) => {
  expect(audits.get(page)?.blocked ?? []).toEqual([]);
  expect(
    (audits.get(page)?.dialogs ?? []).filter((message) =>
      /\p{Script=Hangul}/u.test(message),
    ),
  ).toEqual([]);
});

async function imagePoint(page: Page, x: number, y: number) {
  const image = page.getByRole("img", {
    name: "Receiving sheet image for area mapping",
    exact: true,
  });
  await page
    .getByRole("group", { name: "Image area selection", exact: true })
    .scrollIntoViewIfNeeded();
  await image.evaluate(
    (node, point) => {
      const frame = node.closest("[data-pan]")!.parentElement!;
      frame.scrollLeft = point.x * node.clientWidth - frame.clientWidth / 2;
      frame.scrollTop = point.y * node.clientHeight - frame.clientHeight / 2;
    },
    { x, y },
  );
  const bounds = await image.boundingBox();
  if (!bounds) throw new Error("Image not visible");
  return bounds;
}

async function dragArea(page: Page, label: string, rect: readonly number[]) {
  const button = page.getByRole("button", { name: `${label} area`, exact: true });
  await button.click();
  const [left, top, right, bottom] = rect;
  const bounds = await imagePoint(page, (left + right) / 3200, (top + bottom) / 1640);
  await page.mouse.move(
    bounds.x + (left / 1600) * bounds.width,
    bounds.y + (top / 820) * bounds.height,
  );
  await page.mouse.down();
  await page.mouse.move(
    bounds.x + (right / 1600) * bounds.width,
    bounds.y + (bottom / 820) * bounds.height,
    { steps: 4 },
  );
  await page.mouse.up();
  await expect(button).toContainText("Set · Select again");
}

test("OCR intake, area mapping and stock receipt show no Korean in English", async ({
  page,
}) => {
  test.setTimeout(120_000);
  await setup(page, "/admin?section=ocr");
  const found = new Map<string, string[]>();
  await page
    .locator('input[accept="image/png,image/jpeg,image/webp"]')
    .setInputFiles({ name: "intake.png", mimeType: "image/png", buffer: PNG });
  await page
    .getByRole("button", { name: "Extract text with OCR", exact: true })
    .click();
  await expect(
    page.getByRole("button", { name: "Save review", exact: true }),
  ).toBeEnabled();
  await scan(page, "OCR review and area mapping", found);
  await scanHelp(page, "Image area selection", found);

  await expect(
    page.getByRole("img", {
      name: "Receiving sheet image for area mapping",
      exact: true,
    }),
  ).toHaveJSProperty("naturalWidth", 1600);
  // The row spacing help shows only while there is no quantity area.
  await page.getByRole("button", { name: "Quantity none", exact: true }).click();
  await scanHelp(page, "Row spacing", found);
  await dragArea(page, "Product name", [90, 190, 450, 240]);
  await dragArea(page, "Brand", [490, 190, 680, 240]);
  await dragArea(page, "Option", [790, 190, 1000, 240]);
  await dragArea(page, "Quantity", [1270, 190, 1370, 240]);
  const tableEnd = page.getByRole("button", { name: "Set table end", exact: true });
  await tableEnd.click();
  const end = await imagePoint(page, 0.5, 370 / 820);
  await page.mouse.click(end.x + end.width / 2, end.y + (370 / 820) * end.height);
  await expect(tableEnd).toContainText("Set");
  await page
    .getByLabel("The selected quantity area is the actual quantity, not a price", {
      exact: true,
    })
    .check();
  await page.getByRole("button", { name: "Preview areas", exact: true }).click();
  await expect(
    page.getByRole("region", { name: "Area mapping preview table", exact: true }),
  ).toContainText("Synthetic wheels");
  await expect(page.getByText(/^2 products · Total quantity 5/u)).toBeVisible();
  await scan(page, "OCR area mapping preview", found);
  const confirmation = page.waitForEvent("dialog");
  await page.getByRole("button", { name: "Apply area mapping", exact: true }).click();
  // 적용 확인창이 실제로 떴고 영어 문구였는지 단언함. 수락은 공통 핸들러가 함.
  expect((await confirmation).message()).toBe(
    "Replace the current review rows with this area result? Earlier edits to product name, brand, option and quantity will change.",
  );
  await expect(
    page.getByRole("textbox", { name: "Product name", exact: true }).first(),
  ).toHaveValue("Synthetic deck");
  await scan(page, "OCR area mapping applied", found);

  await page.getByRole("button", { name: "Save review", exact: true }).click();
  const panel = page.getByRole("region", { name: "Apply to stock", exact: true });
  await expect(panel).toBeVisible();
  await scanGuide(page, "OCR saved review", 5, found);
  await panel.getByRole("button", { name: "Load stock products", exact: true }).click();
  // New product rows have their own help; switch row 1 there and back.
  const method = panel.getByRole("combobox", {
    name: "Receiving method 1",
    exact: true,
  });
  await method.selectOption("new");
  await scanHelp(page, "New option 1", found);
  await scanHelp(page, "New price 1", found);
  await method.selectOption("existing");
  for (const row of [1, 2]) {
    await panel
      .getByRole("combobox", { name: `Stock product ${row}`, exact: true })
      .selectOption("prd_english_deck");
    await panel.getByLabel(`I checked receiving row ${row}`, { exact: true }).check();
  }
  await panel
    .getByRole("button", { name: "Preview stock changes", exact: true })
    .click();
  // 미리보기는 상품 목록 재조회 뒤 비동기로 생기므로 표·예정 행·확인 대기 상태를 기다림.
  const preview = panel.getByRole("table");
  await expect(preview).toContainText("[TEST] English deck");
  await expect(preview.getByRole("row")).toHaveCount(2);
  await expect(preview).toContainText("Awaiting confirmation");
  await scan(page, "OCR stock receipt preview", found);
  await panel
    .getByLabel("I checked the actual product registration and stock changes", {
      exact: true,
    })
    .check();
  await panel
    .getByRole("button", { name: "Apply confirmed receipt", exact: true })
    .click();
  await expect(panel.getByRole("status").last()).toContainText(
    "The receipt is applied",
  );
  await scan(page, "OCR stock receipt result", found);
  expect(audits.get(page)?.dialogs).toHaveLength(1);
  expectClean(found);
});
