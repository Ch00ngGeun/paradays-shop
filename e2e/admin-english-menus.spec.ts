import { expect, test } from "@playwright/test";
import { DAY, CLOSED_DAY, order } from "./admin-english-data-fixtures";
import {
  audits,
  setup,
  hangul,
  scan,
  scanHelp,
  scanGuide,
  expectClean,
  openSection,
} from "./admin-english-fixtures";

test.afterEach(async ({ page }) => {
  expect(audits.get(page)?.blocked ?? []).toEqual([]);
  expect(
    (audits.get(page)?.dialogs ?? []).filter((message) =>
      /\p{Script=Hangul}/u.test(message),
    ),
  ).toEqual([]);
});

test("all nine menus and the overview order panels show no Korean in English", async ({
  page,
}) => {
  test.setTimeout(120_000);
  await setup(page, "/admin?section=overview");
  const found = new Map<string, string[]>();
  // 검사기 자기 확인: NFD 조합형·확장 자모 한글도 수집해야 함.
  const decomposed = `${"한글".normalize("NFD")}\uA960\uD7B0`;
  await page.evaluate((text) => {
    const probe = document.createElement("p");
    probe.id = "hangul-probe";
    probe.textContent = text;
    document.body.append(probe);
  }, decomposed);
  expect(await hangul(page)).toContain(decomposed);
  await page.evaluate(() => document.getElementById("hangul-probe")?.remove());
  // Guide steps each untouched menu shows; a missing target would lower the count.
  for (const [name, steps] of [
    ["Home (Operations Overview)", 4],
    ["Product registration", 1],
    ["Stock editing", 1],
    ["Sales & daily close", 1],
    ["Brands", 3],
    ["Members", 2],
    ["Coupons", 4],
    ["Marketing", 5],
    ["Stock-in OCR", 3],
  ] as const) {
    await openSection(page, name);
    await page.waitForLoadState("networkidle");
    await scan(page, `menu ${name}`, found);
    // Each menu's screen guide, as far as the untouched screen offers steps.
    await scanGuide(page, name, steps, found);
  }
  await openSection(page, "Sales & daily close");
  await scanHelp(page, "Real operations", found);
  await openSection(page, "Brands");
  await scanHelp(page, "Add brand", found);
  await openSection(page, "Stock-in OCR");
  await scanHelp(page, "Source image", found);
  await openSection(page, "Home (Operations Overview)");
  await scanHelp(page, "Recent activity", found);
  await page
    .getByRole("textbox", { name: "Order number", exact: true })
    .fill(order.orderId);
  await page.getByRole("button", { name: "Look up order", exact: true }).click();
  await expect(page.getByRole("heading", { name: /pd_order_001/ })).toBeVisible();
  await scan(page, "order stock panel", found);

  // The mock test opens from a launcher into a modal.
  await page
    .getByRole("button", { name: "Mock order and stock test", exact: true })
    .click();
  await page
    .getByLabel("I understand this mock test does not change real orders or stock", {
      exact: true,
    })
    .check();
  await page.getByRole("button", { name: "Start mock test", exact: true }).click();
  await page
    .getByRole("button", { name: "Mock approve · Deduct 2", exact: true })
    .click();
  await page.getByRole("button", { name: "Mock confirm shipped", exact: true }).click();
  await page
    .getByRole("button", { name: "Mock shipped item refund · No restock", exact: true })
    .click();
  await page
    .getByRole("button", { name: "Mock shipped item refund · No restock", exact: true })
    .click();
  await expect(page.getByRole("status", { name: "Mock result" })).toBeVisible();
  await scan(page, "mock order panel", found);
  // This help opens on top of the mock test dialog.
  await scanHelp(page, "Mock partial actions", found);
  await expect(
    page.getByRole("dialog", { name: "Mock order and stock test", exact: true }),
  ).toBeVisible();
  expectClean(found);
});

test("product editor, size chart dialog and stock stepper show no Korean in English", async ({
  page,
}) => {
  await setup(page, "/admin?section=products");
  const found = new Map<string, string[]>();
  await page.getByRole("button", { name: "Register new product", exact: true }).click();
  await scan(page, "new product editor", found);
  await scanGuide(page, "product editor", 4, found);
  for (const target of [
    "Size / options",
    "Main image",
    "Saving the product",
    "Customer preview",
  ])
    await scanHelp(page, target, found);
  await openSection(page, "Product registration");
  await page.getByRole("button", { name: "Edit", exact: true }).first().click();
  await scanHelp(page, "Size chart", found);
  await page.getByRole("button", { name: "+ Add size chart" }).click();
  await expect(page.getByRole("dialog")).toBeVisible();
  await scan(page, "size chart dialog", found);
  // This help opens on top of the size chart dialog; Esc closes only the help.
  await scanHelp(page, "Size chart input", found);
  await expect(page.getByRole("dialog")).toBeVisible();
  await page.keyboard.press("Escape");
  // A saved chip opens the option dialog; a rename shows the name check and the sales notice.
  const chips = page.getByRole("list", { name: "Added options", exact: true });
  await chips.getByRole("button").first().click();
  const dialog = page.getByRole("dialog");
  await expect(dialog).toContainText("This option shows the default now.");
  const optionName = dialog.getByRole("textbox", { name: "Option name" });
  await optionName.fill("");
  await expect(dialog).toContainText("Enter an option name.");
  await scan(page, "option dialog name error", found);
  await optionName.fill("Synthetic wide");
  await expect(dialog).toContainText("Saving changes the option name");
  await scan(page, "option dialog rename notice", found);
  await page.keyboard.press("Escape");
  // A chip added but not yet saved only asks to save the product first.
  await page.getByRole("textbox", { name: "Size / options" }).fill("9.0");
  await page.getByRole("button", { name: "Add option", exact: true }).click();
  await chips.getByRole("button", { name: "9.0", exact: true }).click();
  await expect(
    page.getByRole("alert").filter({ hasText: "Save the product first." }),
  ).toBeVisible();
  await scan(page, "unsaved option chip", found);
  await openSection(page, "Stock editing");
  await page
    .getByRole("button", { name: "Adjust stock for [TEST] English deck", exact: true })
    .click();
  await scan(page, "stock stepper", found);
  await scanGuide(page, "stock stepper", 3, found);
  await scanHelp(page, "Stock after change", found);
  expectClean(found);
});

test("real sales ledger with slips, reversal, close and reopen history shows no Korean in English", async ({
  page,
}) => {
  await setup(page, "/admin?section=sales");
  const found = new Map<string, string[]>();
  await page
    .getByRole("button", {
      name: "Open real operations · Open real sales and daily close",
      exact: true,
    })
    .click();
  await page.getByLabel("Business day (Korea time)", { exact: true }).fill(DAY);
  await page.getByRole("button", { name: "Load ledger", exact: true }).click();
  await expect(page.getByText("CARD-001", { exact: true })).toBeVisible();
  await scan(page, "open ledger", found);
  await scanGuide(page, "open ledger", 3, found);
  await page
    .getByRole("button", { name: "Continue editing · Select slip sale_english_002" })
    .click();
  await scan(page, "draft slip editor", found);
  await page
    .getByRole("button", { name: "Register sale · New slip", exact: true })
    .click();
  await page.getByRole("button", { name: "Add unmatched line", exact: true }).click();
  await scan(page, "new slip editor", found);
  await page
    .getByRole("button", { name: "Details · Select slip sale_english_001" })
    .click();
  await scan(page, "posted slip and reversal form", found);
  await page
    .getByRole("button", { name: "Details · Select slip sale_english_003" })
    .click();
  await scan(page, "reversal slip details", found);
  await page.getByLabel("Business day (Korea time)", { exact: true }).fill(CLOSED_DAY);
  await page.getByRole("button", { name: "Load ledger", exact: true }).click();
  // 이력은 접힌 details 안에 있음. scan이 details를 모두 펼친 뒤 검사함.
  await expect(page.getByText("Sales reconciliation confirmed").first()).toBeAttached();
  await scan(page, "closed ledger and history", found);
  await expect(page.getByText("Sales reconciliation confirmed").first()).toBeVisible();
  // 관리자 입력 재개방 사유는 원문 그대로 남고, 허용 목록 정확 일치로만 통과함.
  expect(await hangul(page)).toContain("현금 재확인");
  expectClean(found);
});

test("mock sales practice through posting and daily close shows no Korean in English", async ({
  page,
}) => {
  await setup(page, "/admin?section=sales");
  const found = new Map<string, string[]>();
  await scan(page, "sales mode choice", found);
  await page
    .getByLabel(
      "I confirm this mock practice does not change the real ledger or stock",
      {
        exact: true,
      },
    )
    .check();
  await page
    .getByRole("button", { name: "Try mock sales and daily close", exact: true })
    .click();
  await page.getByRole("button", { name: "Load card example", exact: true }).click();
  await page.getByRole("button", { name: "Save mock draft", exact: true }).click();
  await page
    .getByRole("button", { name: "Check virtual stock plan", exact: true })
    .click();
  // 검사기 자체 확인: 허용 목록의 모의 상품명은 실제로 수집돼야 함.
  expect(await hangul(page)).toContain("[테스트] 가상 데크");
  await scan(page, "mock stock plan", found);
  await page
    .getByLabel("I checked the virtual stock deduction in the plan", { exact: true })
    .check();
  await page.getByRole("button", { name: "Post mock sale", exact: true }).click();
  await page
    .getByLabel("Mock handwritten cash amount (KRW)", { exact: true })
    .fill("0");
  await page
    .getByLabel("I checked the mock totals and cash amount", { exact: true })
    .check();
  await page
    .getByRole("button", { name: "Confirm mock daily close", exact: true })
    .click();
  await expect(page.getByText("TEST_CLOSE_1", { exact: true })).toBeVisible();
  await scan(page, "mock closed day", found);
  expectClean(found);
});

test("member detail, coupon and campaign steps show no Korean in English", async ({
  page,
}) => {
  await setup(page, "/admin?section=members");
  const found = new Map<string, string[]>();
  await page.getByRole("button", { name: "Load member list", exact: true }).click();
  await page
    .getByRole("button", { name: "[TEST] Alex member details", exact: true })
    .click();
  await scan(page, "member detail", found);
  await scanGuide(page, "member detail", 3, found);
  await scanHelp(page, "Change operating permission", found);
  await openSection(page, "Coupons");
  await page.getByLabel("Coupon name (required)").fill("Welcome");
  await scan(page, "coupon draft", found);
  for (const target of ["Coupon code", "Discount value", "Expiry"])
    await scanHelp(page, target, found);
  await openSection(page, "Marketing");
  await page.getByLabel("Campaign title (required)").fill("Autumn");
  await page.getByLabel("Message (required)").fill("Synthetic message");
  await scan(page, "campaign draft", found);
  await scanHelp(page, "Channel selection", found);
  expectClean(found);
});
