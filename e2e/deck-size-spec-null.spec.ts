import { expect, test } from "@playwright/test";
import {
  DECK,
  SPEC,
  setup,
  editDeck,
  chipNames,
  chip,
  TOP,
  topProduct,
  storefrontChart,
} from "./deck-size-spec-fixtures";

test("a deck saves a partial size chart with null, shows null, reopens empty and deletes when emptied", async ({
  page,
}) => {
  const audit = await setup(page, "/admin?section=products");
  await editDeck(page);
  await page.getByRole("button", { name: "+ 상세사이즈 등록" }).click();
  const dialog = page.getByRole("dialog");
  const input = (field: string) => dialog.getByRole("textbox", { name: field });
  const save = dialog.getByRole("button", { name: "저장", exact: true });
  // Nothing saved and nothing typed: nothing to save.
  await expect(save).toBeDisabled();
  await input("width").fill("8.5");
  await input("length").fill("31.75");
  // The preview shows at once, with null on the blank fields.
  await expect(dialog.locator("svg")).toHaveAttribute(
    "aria-label",
    /^nose null, tail null/,
  );
  await save.click();
  await expect(dialog).toBeHidden();
  const partial = {
    nose: null,
    tail: null,
    width: 8.5,
    length: 31.75,
    wheelbase: null,
  };
  expect(audit.patches).toEqual([{ version: 3, deckSpec: partial }]);
  await expect(
    page.getByText('8.5" × 31.75" · WB null', { exact: true }),
  ).toBeVisible();

  // Reopened, blank fields are empty inputs, not the word null.
  await page.getByRole("button", { name: "상세사이즈 수정" }).click();
  await expect(input("nose")).toHaveValue("");
  await expect(input("width")).toHaveValue("8.5");
  // Emptying every field is the same as deleting.
  await input("width").fill("");
  await input("length").fill("");
  await expect(save).toBeEnabled();
  await save.click();
  await expect(dialog).toBeHidden();
  expect(audit.patches[1]).toEqual({ version: 4, deckSpec: null });
  await expect(page.getByRole("button", { name: "+ 상세사이즈 등록" })).toBeVisible();
  expect(audit.blocked).toEqual([]);
});

test("a top saves partial default and option values with null, renames with every field empty, and an empty form saves nothing", async ({
  page,
}) => {
  const audit = await setup(page, "/admin?section=products", undefined, topProduct());
  const item = audit.store.find((entry) => entry.productId === DECK.id)!;
  await editDeck(page);
  await page.getByRole("button", { name: "+ 상세사이즈 등록" }).click();
  const dialog = page.getByRole("dialog");
  const save = dialog.getByRole("button", { name: "저장", exact: true });
  await dialog.getByRole("textbox", { name: "가슴단면" }).fill("56");
  await expect(dialog.locator("svg")).toHaveAttribute(
    "aria-label",
    /^반팔: 총장 null, 어깨너비 null, 가슴단면 56cm/,
  );
  await save.click();
  await expect(dialog).toBeHidden();
  const blank = Object.fromEntries(Object.keys(TOP).map((key) => [key, null]));
  expect(audit.patches[0]).toEqual({
    version: 3,
    sizeChart: { kind: "shortSleeve", values: { ...blank, chest: 56 } },
  });
  // The summary names the first measurement even when it is blank.
  await expect(page.getByText("반팔 · 총장 null", { exact: true })).toBeVisible();

  // An option with nothing saved and nothing typed has nothing to save.
  await chip(page, "M").click();
  await expect(save).toBeDisabled();
  // A new name with every field empty saves the name alone.
  await dialog.getByRole("textbox", { name: "옵션 이름" }).fill("L");
  await expect(save).toBeEnabled();
  await save.click();
  await expect(dialog).toBeHidden();
  expect(audit.patches[1]).toEqual({
    version: 4,
    size: "M",
    sizeName: "L",
    sizeChartValues: null,
  });
  await expect(chipNames(page)).toHaveText(["S", "L"]);

  // A partial option value saves with null.
  await chip(page, "L").click();
  await dialog.getByRole("textbox", { name: "총장" }).fill("74");
  await save.click();
  await expect(dialog).toBeHidden();
  expect(audit.patches[2]).toEqual({
    version: 5,
    size: "L",
    sizeChartValues: { ...blank, length: 74 },
  });
  expect(item.sizeChartsBySize).toEqual({ L: { ...blank, length: 74 } });
  expect(audit.blocked).toEqual([]);
});

test("the store draws blank fields as null for decks and tops, and switching sizes changes the numbers", async ({
  page,
}) => {
  const blank = Object.fromEntries(Object.keys(TOP).map((key) => [key, null]));
  const audit = await setup(page, `/products/${DECK.slug}`, undefined, {
    category: "Top",
    sizes: ["S", "M"],
    sizeChart: { kind: "shortSleeve", values: { ...blank, length: 72, chest: 56 } },
    sizeChartKind: "shortSleeve",
    sizeChartsBySize: { M: { ...blank, length: 74 } },
  });
  await expect(page.getByRole("heading", { name: "[TEST] Deck size A" })).toBeVisible();
  let svg = await storefrontChart(page);
  await expect(svg).toHaveAttribute(
    "aria-label",
    /^반팔: 총장 72cm \(28\.3"\), 어깨너비 null, 가슴단면 56cm/,
  );
  await expect(svg).toContainText("null");
  await expect(svg).not.toContainText("nullcm");
  await page.keyboard.press("Escape");
  await page.getByRole("button", { name: "M", exact: true }).click();
  svg = await storefrontChart(page);
  await expect(svg).toHaveAttribute(
    "aria-label",
    /^반팔: 총장 74cm \(29\.1"\), 어깨너비 null, 가슴단면 null/,
  );
  await page.keyboard.press("Escape");
  expect(audit.blocked).toEqual([]);

  const deck = await setup(page, `/products/${DECK.slug}`, {
    ...SPEC,
    nose: null,
    tail: null,
  } as unknown as typeof SPEC);
  svg = await storefrontChart(page);
  await expect(svg).toHaveAttribute("aria-label", /^nose null, tail null, width 8\.5"/);
  await expect(svg).not.toContainText('null"');
  await page.keyboard.press("Escape");
  expect(deck.blocked).toEqual([]);
});
