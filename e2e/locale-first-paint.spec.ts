// 역할: 저장 언어가 ko인 사용자에게 정적 en HTML이 한 프레임도 보이지 않고, 숨김이 항상 풀리는지 확인합니다.
import { expect, test, type Page } from "@playwright/test";

const ORIGIN = "http://127.0.0.1:3010";
// 언어에 따라 바뀌는 문구만 씀(장바구니 제목 Your Cart는 ko에서도 같음).
const CART_ENGLISH = ["Your cart is empty.", "Continue shopping"];
const CART_KOREAN = "장바구니가 비어 있음.";

type Frame = { pending: boolean; text: string };
type Watch = { errors: string[] };

/**
 * 페이지 스크립트보다 먼저 저장값을 넣고, 매 프레임 그리기 직전에 실제로 보이는 글자를 기록합니다.
 * 보임 판정은 글자 요소의 계산된 visibility와 모든 조상의 opacity를 함께 봅니다.
 */
async function prepare(
  page: Page,
  stored: "ko" | "en" | null,
  options: { blockStorage?: boolean } = {},
): Promise<Watch> {
  const watch: Watch = { errors: [] };
  page.on("console", (message) => {
    if (message.type() === "error") watch.errors.push(message.text());
  });
  page.on("pageerror", (error) => watch.errors.push(error.message));
  await page.route("**/*", (route) =>
    route.request().url().startsWith(ORIGIN) ? route.fallback() : route.abort(),
  );
  await page.addInitScript(
    ({ stored, blockStorage }) => {
      if (stored) localStorage.setItem("paradays-locale", stored);
      else localStorage.removeItem("paradays-locale");
      if (blockStorage)
        Storage.prototype.getItem = () => {
          throw new DOMException("blocked", "SecurityError");
        };
      const shown = (element: Element) => {
        if (getComputedStyle(element).visibility !== "visible") return false;
        for (let node: Element | null = element; node; node = node.parentElement)
          if (getComputedStyle(node).opacity === "0") return false;
        return true;
      };
      const frames: Frame[] = [];
      (window as unknown as { __frames: Frame[] }).__frames = frames;
      const sample = () => {
        if (document.body) {
          const parts: string[] = [];
          const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
          while (walker.nextNode()) {
            const node = walker.currentNode as Text;
            const parent = node.parentElement;
            if (
              parent &&
              node.data.trim() &&
              !parent.closest("script,style,noscript") &&
              shown(parent)
            )
              parts.push(node.data.trim());
          }
          frames.push({
            pending: document.documentElement.hasAttribute("data-locale-pending"),
            text: parts.join("\n"),
          });
        }
        requestAnimationFrame(sample);
      };
      requestAnimationFrame(sample);
    },
    { stored, blockStorage: options.blockStorage ?? false },
  );
  return watch;
}

/** 앱 스크립트를 일정 시간 붙잡아, 하이드레이션 전 정적 HTML 프레임을 반드시 관찰하게 합니다. */
async function holdAppScripts(page: Page, milliseconds: number | "forever") {
  await page.route("**/_next/**", async (route) => {
    if (route.request().resourceType() !== "script") return route.fallback();
    if (milliseconds === "forever") return new Promise<void>(() => {});
    await new Promise((resolve) => setTimeout(resolve, milliseconds));
    return route.fallback();
  });
}
const frames = (page: Page) =>
  page.evaluate(() => (window as unknown as { __frames: Frame[] }).__frames);
/** 해제 뒤 다음 프레임들에서 숨김 없이 영어 본문이 실제로 기록될 때까지 기다립니다. */
async function expectEnglishFrame(page: Page) {
  await expect
    .poll(async () => {
      const last = (await frames(page)).at(-1);
      return !!last && !last.pending && last.text.includes("Your cart is empty.");
    })
    .toBe(true);
}
const hydrationErrors = (watch: Watch) =>
  watch.errors.filter((text) => /hydrat|did not match|server rendered/iu.test(text));

test("a saved Korean preference never paints the static English cart, even when scripts arrive after 4 seconds", async ({
  page,
}) => {
  const watch = await prepare(page, "ko");
  await holdAppScripts(page, 4_000);
  await page.goto("/cart");
  await expect(page.getByText(CART_KOREAN, { exact: true })).toBeVisible({
    timeout: 20_000,
  });
  await expect(page.locator("html")).toHaveAttribute("lang", "ko");
  await expect(page.locator("html")).not.toHaveAttribute("data-locale-pending");
  const recorded = await frames(page);
  // 숨김이 실제로 걸린 정적 HTML 프레임을 관찰했어야 함(숨김 누락 시 여기서 영어가 보임).
  expect(recorded.some((frame) => frame.pending && frame.text === "")).toBe(true);
  const shown = recorded.filter((frame) => frame.text !== "");
  expect(shown[0].text).toContain(CART_KOREAN);
  expect(
    shown.filter((frame) => CART_ENGLISH.some((text) => frame.text.includes(text))),
  ).toEqual([]);
  expect(hydrationErrors(watch)).toEqual([]);
  expect(watch.errors.filter((text) => !/Failed to load resource/u.test(text))).toEqual(
    [],
  );
});

for (const stored of ["en", null] as const) {
  test(`${stored ?? "no"} saved preference shows English without hiding the page`, async ({
    page,
  }) => {
    const watch = await prepare(page, stored);
    await holdAppScripts(page, 1_000);
    await page.goto("/cart");
    await expect(page.getByText("Your cart is empty.", { exact: true })).toBeVisible();
    const recorded = await frames(page);
    expect(recorded.some((frame) => frame.pending)).toBe(false);
    expect(recorded.find((frame) => frame.text !== "")?.text).toContain(
      "Your cart is empty.",
    );
    await expect(page.locator("html")).toHaveAttribute("lang", "en");
    expect(hydrationErrors(watch)).toEqual([]);
  });
}

test("blocked storage never hides the page", async ({ page }) => {
  await prepare(page, "ko", { blockStorage: true });
  await holdAppScripts(page, 1_000);
  await page.goto("/cart");
  await expect(page.getByText("Your cart is empty.", { exact: true })).toBeVisible();
  expect((await frames(page)).some((frame) => frame.pending)).toBe(false);
});

test("failed app scripts release the hidden page at once with an English document language", async ({
  page,
}) => {
  await prepare(page, "ko");
  await page.route("**/_next/**", (route) =>
    route.request().resourceType() === "script" ? route.abort() : route.fallback(),
  );
  await page.goto("/cart", { waitUntil: "domcontentloaded" });
  await expect(page.locator("html")).not.toHaveAttribute("data-locale-pending", {
    timeout: 3_000,
  });
  await expect(page.locator("html")).toHaveAttribute("lang", "en");
  // abort된 스크립트 오류가 첫 프레임보다 먼저 처리될 수 있어 숨김 프레임 관찰은 단언하지 않음.
  await expectEnglishFrame(page);
});

test("app scripts that never arrive release the hidden page after the final timeout", async ({
  page,
}) => {
  test.setTimeout(30_000);
  await prepare(page, "ko");
  await holdAppScripts(page, "forever");
  await page.goto("/cart", { waitUntil: "domcontentloaded" });
  await page.waitForTimeout(1_000);
  await expect(page.locator("html")).toHaveAttribute("data-locale-pending", "");
  await expect(page.locator("html")).not.toHaveAttribute("data-locale-pending", {
    timeout: 12_000,
  });
  await expect(page.locator("html")).toHaveAttribute("lang", "en");
  await expectEnglishFrame(page);
});

test("a child with an explicit visibility:visible stays hidden while the Korean preference is pending", async ({
  page,
}) => {
  // 관리자 메뉴(admin-dashboard.module.css의 visibility: visible)와 같은 조건을 장바구니에서 재현함.
  await prepare(page, "ko");
  await page.addInitScript(() => {
    document.addEventListener("DOMContentLoaded", () => {
      const probe = document.createElement("p");
      probe.textContent = "VISIBLE_CHILD_PROBE";
      probe.style.visibility = "visible";
      document.body.append(probe);
    });
  });
  await holdAppScripts(page, 4_000);
  await page.goto("/cart");
  await expect(page.getByText(CART_KOREAN, { exact: true })).toBeVisible({
    timeout: 20_000,
  });
  const recorded = await frames(page);
  expect(recorded.some((frame) => frame.pending)).toBe(true);
  expect(
    recorded.filter(
      (frame) => frame.pending && frame.text.includes("VISIBLE_CHILD_PROBE"),
    ),
  ).toEqual([]);
});

test("hidden links cannot be focused, activated or clicked while the Korean preference is pending", async ({
  page,
}) => {
  await prepare(page, "ko");
  await holdAppScripts(page, 4_000);
  await page.goto("/cart", { waitUntil: "domcontentloaded" });
  await expect(page.locator("html")).toHaveAttribute("data-locale-pending", "");
  // 보이지 않는 실제 링크의 중심을 마우스로 누름(좌표가 링크 밖이면 차단이 깨져도 통과하므로).
  const box = await page.locator('a[href="/signup"]').first().boundingBox();
  if (!box) throw new Error("signup link has no box");
  await page.mouse.click(box.x + box.width / 2, box.y + box.height / 2);
  for (let step = 0; step < 6; step++) {
    await page.keyboard.press("Tab");
    await page.keyboard.press("Enter");
  }
  await expect(page.locator("html")).toHaveAttribute("data-locale-pending", "");
  expect(new URL(page.url()).pathname).toBe("/cart");
  expect(await page.evaluate(() => document.activeElement?.tagName)).toBe("BODY");
  // 해제 뒤에는 키보드 이동이 다시 동작해야 함.
  await expect(page.getByText(CART_KOREAN, { exact: true })).toBeVisible({
    timeout: 20_000,
  });
  await page.keyboard.press("Tab");
  expect(await page.evaluate(() => document.activeElement?.tagName)).not.toBe("BODY");
});

test("switching languages after a Korean first paint keeps the saved value format", async ({
  page,
}) => {
  await prepare(page, "ko");
  await page.goto("/cart");
  await expect(page.getByText(CART_KOREAN, { exact: true })).toBeVisible();
  await page.getByRole("button", { name: "영어", exact: true }).click();
  await expect(page.getByText("Your cart is empty.", { exact: true })).toBeVisible();
  expect(await page.evaluate(() => localStorage.getItem("paradays-locale"))).toBe("en");
  await expect(page.locator("html")).toHaveAttribute("lang", "en");
});
