// 역할: 저장 언어가 ko인 사용자에게 정적 en HTML이 한 프레임도 보이지 않고, 숨김이 항상 풀리는지 확인합니다.
import { expect, test, type Page } from "@playwright/test";

const ORIGIN = "http://127.0.0.1:3010";
// 언어에 따라 바뀌는 장바구니 문구만 씀(제목 Your Cart는 ko에서도 같음).
const ENGLISH = ["Your cart is empty.", "Continue shopping"];
const KOREAN = "장바구니가 비어 있음.";

type Frame = { visible: boolean; text: string };

/** 페이지 스크립트보다 먼저 저장값을 넣고, 매 프레임 그리기 직전의 보임 여부와 본문을 기록합니다. */
async function prepare(
  page: Page,
  stored: "ko" | "en" | null,
  options: { blockStorage?: boolean } = {},
) {
  const errors: string[] = [];
  page.on("console", (message) => {
    if (message.type() === "error") errors.push(message.text());
  });
  await page.route("**/*", (route) =>
    route.request().url().startsWith(ORIGIN) ? route.continue() : route.abort(),
  );
  await page.addInitScript(
    ({ stored, blockStorage }) => {
      if (stored) localStorage.setItem("paradays-locale", stored);
      else localStorage.removeItem("paradays-locale");
      if (blockStorage)
        Storage.prototype.getItem = () => {
          throw new DOMException("blocked", "SecurityError");
        };
      const frames: Frame[] = [];
      (window as unknown as { __frames: Frame[] }).__frames = frames;
      const sample = () => {
        if (document.body)
          frames.push({
            visible: getComputedStyle(document.body).visibility !== "hidden",
            text: document.body.innerText,
          });
        requestAnimationFrame(sample);
      };
      requestAnimationFrame(sample);
    },
    { stored, blockStorage: options.blockStorage ?? false },
  );
  return errors;
}
const frames = (page: Page) =>
  page.evaluate(() => (window as unknown as { __frames: Frame[] }).__frames);
const hydrationErrors = (errors: string[]) =>
  errors.filter((text) => /hydrat|did not match/iu.test(text));

test("a saved Korean preference never paints the static English page", async ({
  page,
}) => {
  const errors = await prepare(page, "ko");
  await page.goto("/cart");
  await expect(page.getByText(KOREAN, { exact: true })).toBeVisible();
  await expect(page.locator("html")).toHaveAttribute("lang", "ko");
  await expect(page.locator("html")).not.toHaveAttribute("data-locale-pending");
  const recorded = await frames(page);
  const visible = recorded.filter((frame) => frame.visible);
  expect(visible.length).toBeGreaterThan(0);
  expect(
    visible.filter((frame) => ENGLISH.some((text) => frame.text.includes(text))),
  ).toEqual([]);
  expect(hydrationErrors(errors)).toEqual([]);
});

for (const stored of ["en", null] as const) {
  test(`${stored ?? "no"} saved preference shows English without hiding the page`, async ({
    page,
  }) => {
    const errors = await prepare(page, stored);
    await page.goto("/cart");
    await expect(page.getByText("Your cart is empty.", { exact: true })).toBeVisible();
    expect((await frames(page)).every((frame) => frame.visible)).toBe(true);
    await expect(page.locator("html")).toHaveAttribute("lang", "en");
    expect(hydrationErrors(errors)).toEqual([]);
  });
}

test("blocked storage never hides the page", async ({ page }) => {
  await prepare(page, "ko", { blockStorage: true });
  await page.goto("/cart");
  await expect(page.getByText("Your cart is empty.", { exact: true })).toBeVisible();
  expect((await frames(page)).every((frame) => frame.visible)).toBe(true);
});

test("a saved Korean preference is released even when the app scripts fail", async ({
  page,
}) => {
  await prepare(page, "ko");
  // dev 청크 URL에는 query가 붙으므로 확장자가 아니라 요청 종류로 앱 스크립트를 모두 막음.
  await page.route("**/_next/**", (route) =>
    route.request().resourceType() === "script" ? route.abort() : route.continue(),
  );
  await page.goto("/cart", { waitUntil: "domcontentloaded" });
  await expect(page.locator("html")).toHaveAttribute("data-locale-pending", "");
  // 앱 스크립트 없이도 head 스크립트의 3초 해제로 정적 화면이 다시 보여야 함.
  await expect(page.locator("html")).not.toHaveAttribute("data-locale-pending", {
    timeout: 6_000,
  });
  await expect(page.locator("body")).toBeVisible();
});

test("switching languages after a Korean first paint keeps the saved value format", async ({
  page,
}) => {
  await prepare(page, "ko");
  await page.goto("/cart");
  await expect(page.getByText(KOREAN, { exact: true })).toBeVisible();
  await page.getByRole("button", { name: "영어", exact: true }).click();
  await expect(page.getByText("Your cart is empty.", { exact: true })).toBeVisible();
  expect(await page.evaluate(() => localStorage.getItem("paradays-locale"))).toBe("en");
  await expect(page.locator("html")).toHaveAttribute("lang", "en");
});
