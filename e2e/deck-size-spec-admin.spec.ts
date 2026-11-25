import { expect, test } from "@playwright/test";
import {
  API,
  DECK,
  SPEC,
  respond,
  setup,
  editDeck,
  chipNames,
  chip,
  openDeckSpecModal,
} from "./deck-size-spec-fixtures";

test("admin saves the deck size spec from its own modal and the product form saves without a conflict", async ({
  page,
}) => {
  const audit = await setup(page, "/admin?section=products");
  const row = page
    .getByRole("list", { name: "상품 목록" })
    .getByRole("listitem")
    .filter({ hasText: "[TEST] Deck size A" });
  await row.getByRole("button", { name: "수정", exact: true }).click();

  await page.getByRole("button", { name: "+ 상세사이즈 등록" }).click();
  const dialog = page.getByRole("dialog");
  await expect(dialog).toBeVisible();
  await expect(
    dialog.getByRole("button", { name: "저장", exact: true }),
  ).toBeDisabled();
  for (const [field, value] of Object.entries(SPEC))
    await dialog.getByRole("textbox", { name: field }).fill(String(value));
  await expect(dialog).toContainText("(17.5cm)");
  await expect(dialog.locator("svg")).toContainText('6.875"');
  await dialog.getByRole("button", { name: "저장", exact: true }).click();

  await expect(dialog).toBeHidden();
  expect(audit.patches).toEqual([{ version: 3, deckSpec: SPEC }]);
  await expect(page.getByText('8.5" × 31.75" · WB 14.25"')).toBeVisible();
  await expect(page.getByRole("button", { name: "상세사이즈 수정" })).toBeVisible();

  // Saving a public product asks for confirmation first.
  page.once("dialog", (prompt) => void prompt.accept());
  await page.getByRole("button", { name: /수정 저장/ }).click();
  await expect(page.getByText("상품을 공개 상태로 저장했습니다")).toBeVisible();
  expect(audit.patchedIds).toEqual([DECK.id, DECK.id]);
  expect(audit.patches[1]).toMatchObject({ version: 4 });
  expect(audit.patches[1]).not.toHaveProperty("deckSpec");
  expect(audit.blocked).toEqual([]);
});
test("admin edits per-option charts from the chips and the default button stays default-only", async ({
  page,
}) => {
  const option85 = { ...SPEC, width: 8.5, wheelbase: 14.5 };
  const option825 = { ...SPEC, width: 8.25, wheelbase: 14 };
  const audit = await setup(page, "/admin?section=products", SPEC, {
    sizes: ["8.25", "8.5"],
    deckSpecsBySize: { "8.5": option85 },
  });
  const item = audit.store.find((entry) => entry.productId === DECK.id)!;
  await editDeck(page);
  await expect(
    page.getByText('기본 8.5" × 31.75" · WB 14.25" · 옵션별 1개'),
  ).toBeVisible();
  await expect(page.getByRole("list", { name: "추가된 옵션" })).toContainText(
    "8.5상세",
  );
  const dialog = page.getByRole("dialog");
  const input = (field: string) => dialog.getByRole("textbox", { name: field });

  // The default button opens the default chart only: no target picker, no name field.
  await page.getByRole("button", { name: "상세사이즈 수정" }).click();
  await expect(dialog.getByRole("combobox")).toHaveCount(0);
  await expect(input("옵션 이름")).toHaveCount(0);
  await expect(input("wheelbase")).toHaveValue("14.25");
  await page.keyboard.press("Escape");

  // A saved chip opens its own chart with its name.
  await chip(page, "8.5").click();
  await expect(dialog.getByRole("heading")).toContainText("· 8.5");
  await expect(input("옵션 이름")).toHaveValue("8.5");
  await expect(input("wheelbase")).toHaveValue("14.5");
  await dialog.getByRole("button", { name: "삭제", exact: true }).click();
  await expect(dialog).toBeHidden();
  expect(audit.patches[0]).toEqual({ version: 3, size: "8.5", sizeDeckSpec: null });
  expect(item.deckSpec).toEqual(SPEC);

  await chip(page, "8.25").click();
  await expect(input("wheelbase")).toHaveValue("");
  await expect(dialog).toContainText("이 옵션은 지금 기본값을 표시합니다.");
  for (const [field, value] of Object.entries(option825))
    await input(field).fill(String(value));
  await dialog.getByRole("button", { name: "저장", exact: true }).click();
  await expect(dialog).toBeHidden();
  expect(audit.patches[1]).toEqual({
    version: 4,
    size: "8.25",
    sizeDeckSpec: option825,
  });
  expect(item.deckSpecsBySize).toEqual({ "8.25": option825 });

  // Saving the default keeps the old default-only body.
  await page.getByRole("button", { name: "상세사이즈 수정" }).click();
  await input("tail").fill("6.625");
  await dialog.getByRole("button", { name: "저장", exact: true }).click();
  await expect(dialog).toBeHidden();
  expect(audit.patches[2]).toEqual({ version: 5, deckSpec: { ...SPEC, tail: 6.625 } });
  expect(item.deckSpecsBySize).toEqual({ "8.25": option825 });
  expect(audit.blocked).toEqual([]);
});

test("renaming an option moves its chart, renames the chip and the next product save sends the new name", async ({
  page,
}) => {
  const option85 = { ...SPEC, width: 8.5, wheelbase: 14.5 };
  const audit = await setup(page, "/admin?section=products", SPEC, {
    sizes: ["8.25", "8.5"],
    deckSpecsBySize: { "8.5": option85 },
  });
  const item = audit.store.find((entry) => entry.productId === DECK.id)!;
  await editDeck(page);
  const dialog = page.getByRole("dialog");
  const name = dialog.getByRole("textbox", { name: "옵션 이름" });

  await chip(page, "8.5").click();
  for (const [value, message] of [
    ["", "옵션 이름을 입력해 주세요."],
    ["8.25", "이미 있는 옵션 이름입니다."],
    ["8.5, wide", "쉼표나 줄바꿈 없이"],
  ] as const) {
    await name.fill(value);
    await expect(dialog).toContainText(message);
    await expect(
      dialog.getByRole("button", { name: "저장", exact: true }),
    ).toBeDisabled();
  }
  await name.fill(" 8.5 wide ");
  await expect(dialog).toContainText(
    "예전 이름으로 적힌 매출 초안은 옵션을 다시 골라 저장해야",
  );
  await dialog.getByRole("button", { name: "저장", exact: true }).click();
  await expect(dialog).toBeHidden();
  expect(audit.patches[0]).toEqual({
    version: 3,
    size: "8.5",
    sizeName: "8.5 wide",
    sizeDeckSpec: option85,
  });
  await expect(chipNames(page)).toHaveText(["8.25", "8.5 wide"]);
  expect(item.deckSpecsBySize).toEqual({ "8.5 wide": option85 });

  // A name-only rename with all five fields empty.
  await chip(page, "8.25").click();
  await name.fill("8.0");
  await dialog.getByRole("button", { name: "저장", exact: true }).click();
  await expect(dialog).toBeHidden();
  expect(audit.patches[1]).toEqual({
    version: 4,
    size: "8.25",
    sizeName: "8.0",
    sizeDeckSpec: null,
  });
  await expect(chipNames(page)).toHaveText(["8.0", "8.5 wide"]);

  page.once("dialog", (prompt) => void prompt.accept());
  await page.getByRole("button", { name: /수정 저장/ }).click();
  await expect.poll(() => audit.patches.length).toBe(3);
  expect(audit.patches[2]).toMatchObject({ version: 5, sizes: "8.0, 8.5 wide" });
  expect(item.deckSpecsBySize).toEqual({ "8.5 wide": option85 });
  expect(audit.blocked).toEqual([]);
});

test("an unsaved chip asks to save the product first and a reserved rename explains the hold", async ({
  page,
}) => {
  const audit = await setup(page, "/admin?section=products", undefined, {
    sizes: ["8.25", "8.5"],
    deckSpecsBySize: { "8.5": SPEC },
  });
  await editDeck(page);
  await expect(page.getByText("기본 미등록 · 옵션별 1개")).toBeVisible();
  await page.getByRole("button", { name: "8.5 삭제", exact: true }).click();
  await page.getByRole("textbox", { name: "사이즈 / 옵션" }).fill("8.75");
  await page.getByRole("button", { name: "옵션 추가", exact: true }).click();
  await expect(chipNames(page)).toHaveText(["8.25", "8.75"]);
  await chip(page, "8.75").click();
  await expect(page.getByRole("dialog")).toHaveCount(0);
  await expect(
    page.getByRole("alert").filter({ hasText: "상품을 먼저 저장해 주세요." }),
  ).toBeVisible();

  let refusal: string | null = "CATALOG_PRODUCT_RESERVED";
  await page.route(`${API}admin/catalog/products/*`, (route) =>
    route.request().method() === "PATCH" && refusal
      ? respond(route, { code: refusal }, 409)
      : route.fallback(),
  );
  await chip(page, "8.25").click();
  const dialog = page.getByRole("dialog");
  const save = dialog.getByRole("button", { name: "저장", exact: true });
  // A chip added but not saved yet still counts as a taken name.
  await dialog.getByRole("textbox", { name: "옵션 이름" }).fill("8.75");
  await expect(dialog).toContainText("이미 있는 옵션 이름입니다.");
  await expect(save).toBeDisabled();
  await dialog.getByRole("textbox", { name: "옵션 이름" }).fill("8.0");
  await save.click();
  // The reason is shown inside the open dialog, not behind it.
  await expect(dialog.getByRole("alert")).toContainText(
    "결제 대기 중인 주문이 있어 지금은 옵션 이름을 바꿀 수 없습니다.",
  );
  refusal = "CATALOG_PRODUCT_DUPLICATE";
  await save.click();
  await expect(dialog.getByRole("alert")).toContainText(
    "같은 이름·브랜드의 다른 상품에 이 옵션이 있어",
  );
  await expect(chipNames(page)).toHaveText(["8.25", "8.75"]);

  // A later success leaves no refusal text anywhere on the page.
  refusal = null;
  await save.click();
  await expect(dialog).toBeHidden();
  await expect(chipNames(page)).toHaveText(["8.0", "8.75"]);
  await expect(page.getByText("결제 대기 중인 주문이 있어")).toHaveCount(0);
  await expect(page.getByText("같은 이름·브랜드의 다른 상품")).toHaveCount(0);
  expect(audit.blocked).toEqual([]);
});

test("a duplicated legacy option name opens its chart without a name field", async ({
  page,
}) => {
  const audit = await setup(page, "/admin?section=products", SPEC, {
    sizes: ["M", "M", "L"],
  });
  await editDeck(page);
  const dialog = page.getByRole("dialog");
  const reason = "같은 이름의 옵션이 여러 개 저장돼 있어 이름은 바꿀 수 없고";
  await page
    .getByRole("list", { name: "추가된 옵션" })
    .getByRole("button", { name: "M", exact: true })
    .nth(1)
    .click();
  await expect(dialog.getByRole("heading")).toContainText("· M");
  await expect(dialog.getByRole("textbox", { name: "옵션 이름" })).toHaveCount(0);
  // The reason is inside the open dialog.
  await expect(dialog).toContainText(reason);
  for (const [field, value] of Object.entries(SPEC))
    await dialog.getByRole("textbox", { name: field }).fill(String(value));
  await dialog.getByRole("button", { name: "저장", exact: true }).click();
  await expect(dialog).toBeHidden();
  expect(audit.patches).toEqual([{ version: 3, size: "M", sizeDeckSpec: SPEC }]);
  await expect(chipNames(page)).toHaveText(["M", "M", "L"]);

  // Removing one M only in the draft still saves both, so the same reason shows with no name field.
  await page.getByRole("button", { name: "M 삭제", exact: true }).first().click();
  await expect(chipNames(page)).toHaveText(["M", "L"]);
  await page
    .getByRole("list", { name: "추가된 옵션" })
    .getByRole("button", { name: "M", exact: true })
    .click();
  await expect(dialog.getByRole("textbox", { name: "옵션 이름" })).toHaveCount(0);
  await expect(dialog).toContainText(reason);
  expect(audit.blocked).toEqual([]);
});

test("Esc closes the help inside the size chart dialog first, then the dialog, and nothing stays locked", async ({
  page,
}) => {
  const audit = await setup(page, "/admin?section=products");
  await editDeck(page);
  const open = page.getByRole("button", { name: "+ 상세사이즈 등록" });
  await open.click();
  const chart = page.getByRole("dialog", {
    name: /^상세사이즈 · \[TEST\] Deck size A/,
  });
  await expect(chart).toBeVisible();
  // The inch explanation is behind the help button.
  await expect(chart).not.toContainText("인치로 입력하면");
  const help = chart.getByRole("button", {
    name: "상세사이즈 입력 도움말",
    exact: true,
  });
  await help.click();
  const helpDialog = page.getByRole("dialog", { name: "상세사이즈 입력 도움말" });
  await expect(helpDialog).toContainText("인치로 입력하면 cm는 자동으로 계산됩니다.");
  const inert = (locator: typeof chart) =>
    locator.evaluate((element) => element.closest("[inert]") !== null);
  expect(await inert(chart)).toBe(true);

  await page.keyboard.press("Escape");
  await expect(helpDialog).toHaveCount(0);
  await expect(chart).toBeVisible();
  await expect(help).toBeFocused();
  expect(await inert(chart)).toBe(false);

  // A wrong value brings the range back as an error tied to that field.
  const nose = chart.getByRole("textbox", { name: "nose" });
  await nose.fill("0");
  await expect(chart).toContainText(
    "0 초과 100 이하의 인치로, 소수 4자리까지 입력해 주세요.",
  );
  await expect(nose).toHaveAccessibleDescription(
    "0 초과 100 이하의 인치로, 소수 4자리까지 입력해 주세요.",
  );

  await page.keyboard.press("Escape");
  await expect(chart).toHaveCount(0);
  expect(
    await page.evaluate(() => ({
      overflow: document.body.style.overflow,
      inert: [...document.body.children].some(
        (element) => (element as HTMLElement).inert,
      ),
    })),
  ).toEqual({ overflow: "", inert: false });
  await expect(open).toBeEnabled();
  await open.click();
  await expect(chart).toBeVisible();
  expect(audit.blocked).toEqual([]);
});

test("ESC during a pending save keeps the modal open, and a failed save keeps the inputs with an error", async ({
  page,
}) => {
  const audit = await setup(page, "/admin?section=products");
  let release = () => {};
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  // Registered after setup, so it takes precedence for the deckSpec PATCH only.
  await page.route(`${API}admin/catalog/products/*`, async (route) => {
    if (route.request().method() !== "PATCH") return route.fallback();
    await gate;
    return respond(route, { code: "CATALOG_STORAGE_UNAVAILABLE" }, 503);
  });
  await page
    .getByRole("list", { name: "상품 목록" })
    .getByRole("listitem")
    .filter({ hasText: "[TEST] Deck size A" })
    .getByRole("button", { name: "수정", exact: true })
    .click();
  await page.getByRole("button", { name: "+ 상세사이즈 등록" }).click();
  const dialog = page.getByRole("dialog");
  for (const [field, value] of Object.entries(SPEC))
    await dialog.getByRole("textbox", { name: field }).fill(String(value));
  await dialog.getByRole("button", { name: "저장", exact: true }).click();
  await expect(dialog.getByRole("button", { name: "저장 중…" })).toBeVisible();

  await page.keyboard.press("Escape");
  await expect(dialog).toBeVisible();

  release();
  await expect(dialog.getByRole("alert")).toContainText("저장하지 못했습니다");
  await expect(dialog.getByRole("textbox", { name: "nose" })).toHaveValue("6.875");
  await expect(dialog.getByRole("button", { name: "저장", exact: true })).toBeEnabled();
  expect(audit.patches).toEqual([]);
  expect(audit.blocked).toEqual([]);
});
test("after a lost save response, a retry stops on the conflict instead of overwriting", async ({
  page,
}) => {
  const audit = await setup(page, "/admin?section=products");
  let lost = false;
  await page.route(`${API}admin/catalog/products/*`, async (route) => {
    if (route.request().method() !== "PATCH" || lost) return route.fallback();
    lost = true;
    // The server commits the write, but the browser never sees a valid response.
    const item = audit.store.find((entry) => entry.productId === DECK.id)!;
    item.deckSpec = SPEC;
    item.version += 1;
    return respond(route, { code: "INTERNAL" }, 500);
  });
  const dialog = await openDeckSpecModal(page, "[TEST] Deck size A");
  await dialog.getByRole("button", { name: "저장", exact: true }).click();
  await expect(dialog.getByRole("alert")).toContainText("저장하지 못했습니다");

  await dialog.getByRole("textbox", { name: "tail" }).fill("6.625");
  await dialog.getByRole("button", { name: "저장", exact: true }).click();
  await expect(page.getByText("편집을 닫고 다시 열어")).toBeVisible();
  await expect(dialog).toBeVisible();
  expect(audit.patches).toEqual([{ version: 3, deckSpec: { ...SPEC, tail: 6.625 } }]);
  expect(audit.store.find((entry) => entry.productId === DECK.id)).toMatchObject({
    version: 4,
    deckSpec: SPEC,
  });
  expect(audit.blocked).toEqual([]);
});

test("a late save response for one product does not close another product's modal", async ({
  page,
}) => {
  const audit = await setup(page, "/admin?section=products");
  let release = () => {};
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  await page.route(`${API}admin/catalog/products/${DECK.id}`, async (route) => {
    if (route.request().method() !== "PATCH") return route.fallback();
    await gate;
    return route.fallback();
  });
  const first = await openDeckSpecModal(page, "[TEST] Deck size A");
  await first.getByRole("button", { name: "저장", exact: true }).click();
  await expect(first.getByRole("button", { name: "저장 중…" })).toBeVisible();

  await page.goBack();
  await expect(page.getByRole("dialog")).toHaveCount(0);
  const second = await openDeckSpecModal(page, "[TEST] Deck size B");
  release();
  // Assert only after the app has parsed and committed A's late success.
  await page.waitForFunction(
    () => (window as unknown as { __patchSettled: number }).__patchSettled >= 1,
  );
  expect(audit.patchedIds).toEqual([DECK.id]);
  await expect(second).toBeVisible();
  await expect(second.getByRole("textbox", { name: "nose" })).toHaveValue("6.875");
  expect(audit.blocked).toEqual([]);
});

test("a late save response does not close a new modal after returning to the same editor", async ({
  page,
}) => {
  const audit = await setup(page, "/admin?section=products");
  let release = () => {};
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  await page.route(`${API}admin/catalog/products/${DECK.id}`, async (route) => {
    if (route.request().method() !== "PATCH") return route.fallback();
    await gate;
    return route.fallback();
  });
  const first = await openDeckSpecModal(page, "[TEST] Deck size A");
  await first.getByRole("button", { name: "저장", exact: true }).click();
  await expect(first.getByRole("button", { name: "저장 중…" })).toBeVisible();

  await page.goBack();
  await page.goForward();
  await expect(page.getByRole("dialog")).toHaveCount(0);
  await page.getByRole("button", { name: "+ 상세사이즈 등록" }).click();
  const second = page.getByRole("dialog");
  await second.getByRole("textbox", { name: "nose" }).fill("7");
  release();
  // The summary behind the modal changes only once the app has processed the late success.
  await expect(page.getByText('8.5" × 31.75" · WB 14.25"')).toBeVisible();
  await page.waitForFunction(
    () => (window as unknown as { __patchSettled: number }).__patchSettled >= 1,
  );
  await expect(second).toBeVisible();
  await expect(second.getByRole("textbox", { name: "nose" })).toHaveValue("7");
  expect(audit.blocked).toEqual([]);
});
