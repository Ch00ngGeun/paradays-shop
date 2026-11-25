// 역할: 관리자 화면 안내의 대상 테두리·단계 이동·키보드·숨김 처리와 화면별 도움말, 좁은 화면 배치를 검증함.
import { expect, test } from "@playwright/test";
import {
  boxOf,
  guideLines,
  guideRing,
} from "./admin-navigation-accessibility-fixtures";
import {
  audits,
  products,
  respond,
  select,
  setup,
} from "./admin-navigation-base-fixtures";
import {
  brandNameInput,
  brandProducts,
  brandWorkspace,
} from "./admin-navigation-brand-fixtures";
import { couponField, couponWorkspace } from "./admin-navigation-coupon-fixtures";
import {
  inventoryProducts,
  inventoryWorkspace,
} from "./admin-navigation-inventory-fixtures";
import {
  loadMembers,
  memberChoice,
  memberWorkspace,
  setupMembers,
} from "./admin-navigation-member-fixtures";
import { newProduct } from "./admin-navigation-product-fixtures";

test.afterEach(async ({ page }) => {
  expect(audits.get(page)?.blocked ?? []).toEqual([]);
});

test("screen guide walks the home steps around the real elements with keys, buttons and Esc", async ({
  page,
}) => {
  await setup(page, { path: "/admin?section=overview" });
  const open = page.getByRole("button", { name: "화면 도움말", exact: true });
  await expect(open).toContainText("도움말");
  // 머리말 버튼 모양을 유지하는 "New product" 바로 왼쪽에 놓임.
  const newProduct = page
    .locator("main")
    .getByRole("button", { name: "새 상품", exact: false })
    .first();
  const helpBox = await boxOf(open);
  const newBox = await boxOf(newProduct);
  expect(helpBox.x + helpBox.width).toBeLessThanOrEqual(newBox.x);
  expect(newBox.x - (helpBox.x + helpBox.width)).toBeLessThan(40);
  expect(
    await newProduct.evaluate((button) => getComputedStyle(button).borderRadius),
  ).toBe("4px");
  await open.click();
  const bubble = page.getByRole("dialog");
  await expect(bubble).toContainText("1/4단계");
  await expect(bubble.getByRole("heading")).toHaveText("오늘 숫자 보기");

  // 표시한 요소 둘레에 테두리가 생기고 뒤쪽 페이지는 비활성(inert)이 됨.
  const metrics = page.locator('[data-admin-guide="home.metrics"]');
  await expect
    .poll(async () => {
      const ring = await boxOf(guideRing(page));
      const target = await boxOf(metrics);
      return (
        ring.x <= target.x &&
        ring.y <= target.y &&
        ring.x + ring.width >= target.x + target.width &&
        ring.y + ring.height >= target.y + target.height
      );
    })
    .toBe(true);
  expect(await metrics.evaluate((element) => element.closest("[inert]") !== null)).toBe(
    true,
  );

  await bubble.getByRole("button", { name: "다음", exact: true }).click();
  await expect(bubble).toContainText("2/4단계");
  await expect(bubble.getByRole("heading")).toHaveText("재고가 적은 상품");
  await page.keyboard.press("ArrowRight");
  await expect(bubble.getByRole("heading")).toHaveText("하루 마감");
  await page.keyboard.press("ArrowLeft");
  await expect(bubble.getByRole("heading")).toHaveText("재고가 적은 상품");
  await bubble.getByRole("button", { name: "이전", exact: true }).click();
  await expect(bubble).toContainText("1/4단계");
  await expect(
    bubble.getByRole("button", { name: "이전", exact: true }),
  ).toBeDisabled();

  // 마지막 단계 버튼 이름은 Done이고 주문 번호 입력란에 밑줄이 그어짐.
  for (let step = 0; step < 3; step += 1)
    await bubble.getByRole("button", { name: "다음", exact: true }).click();
  await expect(bubble).toContainText("4/4단계");
  await expect(guideLines(page)).toHaveCount(2);
  await expect(bubble.getByRole("button", { name: "완료", exact: true })).toBeVisible();

  await page.keyboard.press("Escape");
  await expect(bubble).toHaveCount(0);
  await expect(open).toBeFocused();
  expect(await metrics.evaluate((element) => element.closest("[inert]") !== null)).toBe(
    false,
  );
});

test("screen guide button sits at the right end of the product editor toolbar", async ({
  page,
}) => {
  await setup(page, { path: "/admin?section=products" });
  await newProduct(page);
  const back = page.getByRole("button", { name: "← 목록으로", exact: true });
  const help = page.getByRole("button", { name: "화면 도움말", exact: true });
  const toolbar = back.locator("xpath=..");
  const toolbarBox = await boxOf(toolbar);
  const helpBox = await boxOf(help);
  expect(
    Math.abs(toolbarBox.x + toolbarBox.width - (helpBox.x + helpBox.width)),
  ).toBeLessThan(2);
  expect(helpBox.x).toBeGreaterThan((await boxOf(back)).x + 200);
});

test("headers with the guide button fit a 320px screen in English without sideways scrolling", async ({
  page,
}) => {
  await page.setViewportSize({ width: 320, height: 760 });
  await setup(page, { path: "/admin?section=products", products: true });
  for (const section of ["products", "overview", "inventory"]) {
    await page.goto(`/admin?section=${section}`);
    // setup 스크립트가 매번 로드할 때 언어를 초기화하므로 화면마다 전환함.
    await page.getByRole("button", { name: "영어", exact: true }).click();
    const help = page.getByRole("button", { name: "Screen help", exact: true });
    await expect(help).toBeVisible();
    expect(
      await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth),
      section,
    ).toBe(true);
    const box = await boxOf(help);
    expect(box.x + box.width, section).toBeLessThanOrEqual(320);
  }
});

test("screen guide skips steps whose element is not on the screen", async ({
  page,
}) => {
  await setup(page, { path: "/admin?section=products", products: true });
  await page.getByRole("button", { name: "화면 도움말", exact: true }).click();
  const bubble = page.getByRole("dialog");
  // 목록 화면에는 편집 입력란이 없으므로 목록 단계만 남음.
  await expect(bubble).toContainText("1/1단계");
  await expect(bubble.getByRole("heading")).toHaveText("상품 고르기");
  await bubble.getByRole("button", { name: "완료", exact: true }).click();
  await expect(bubble).toHaveCount(0);
});

test("screen guide closes when the screen holding its button gets hidden", async ({
  page,
}) => {
  await setup(page, { path: "/admin?section=products", products: true });
  const open = page.getByRole("button", { name: "화면 도움말", exact: true });
  await open.click();
  const bubble = page.getByRole("dialog");
  await expect(bubble).toContainText("1/1단계");
  // 매출은 마운트된 채 뒤로 가기로 벗어날 때만 숨겨지므로 여기서도 같은 `hidden` 전환을 씀.
  await open.evaluate((button) =>
    button.closest("section")!.setAttribute("hidden", ""),
  );
  await expect(bubble).toHaveCount(0);
});

test("screen guide moves from the empty state to a step whose element shows up later", async ({
  page,
}) => {
  let release = () => {};
  const loaded = new Promise<void>((resolve) => (release = resolve));
  await setup(page, {
    path: "/admin?section=products",
    // 붙잡아 둔 카탈로그 요청은 release() 전까지 네트워크를 바쁜 상태로 둠.
    waitForIdle: false,
    handleCatalog: async (route) => {
      await loaded;
      await respond(route, { products });
    },
  });
  await page.getByRole("button", { name: "화면 도움말", exact: true }).click();
  const bubble = page.getByRole("dialog");
  await expect(bubble).toContainText("이 화면에서 지금 짚어 줄 항목이 없습니다.");
  release();
  await expect(bubble).toContainText("1/1단계");
  await expect(bubble.getByRole("heading")).toHaveText("상품 고르기");
});

test("screen guide underlines the stock input and keeps the bubble on a 375px screen", async ({
  page,
}) => {
  await page.setViewportSize({ width: 375, height: 760 });
  await setup(page, {
    path: "/admin?section=inventory",
    catalogProducts: inventoryProducts,
  });
  await inventoryWorkspace(page)
    .getByRole("button", { name: `${products[0]!.name} 재고 조정`, exact: true })
    .click();
  await page.getByRole("button", { name: "화면 도움말", exact: true }).click();
  const bubble = page.getByRole("dialog");
  await expect(bubble).toContainText("1/3단계");
  await page.keyboard.press("ArrowRight");
  await expect(bubble.getByRole("heading")).toHaveText("새 수량 넣기");
  const input = page.locator('[data-admin-guide="inventory.quantity"]');
  // 첫 선은 밑줄이며 입력란 바로 아래에 입력란 너비만큼 그어짐.
  await expect
    .poll(async () => {
      const target = await boxOf(input);
      const underline = await boxOf(guideLines(page).first());
      return (
        Math.abs(underline.y - (target.y + target.height)) <= 6 &&
        Math.abs(underline.width - target.width) <= 6
      );
    })
    .toBe(true);
  const box = await boxOf(bubble);
  expect(box.x).toBeGreaterThanOrEqual(0);
  expect(box.x + box.width).toBeLessThanOrEqual(375);
  expect(box.y).toBeGreaterThanOrEqual(0);
  expect(box.y + box.height).toBeLessThanOrEqual(760);
  expect(
    await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth),
  ).toBe(true);
});

test("help on home, stock, brand and member screens opens on demand while warnings stay visible", async ({
  page,
}) => {
  await setup(page, { path: "/admin?section=overview" });
  const dialog = page.getByRole("dialog");
  const check = async (target: string, text: string) => {
    const help = page.getByRole("button", { name: `${target} 도움말`, exact: true });
    await expect(page.getByText(text, { exact: false })).toHaveCount(0);
    await help.click();
    await expect(dialog).toContainText(text);
    await page.keyboard.press("Escape");
    await expect(dialog).toHaveCount(0);
    await expect(help).toBeFocused();
  };
  await check("최근 운영 기록", "서버 전체 운영 이력이 아닙니다");
  await select(page, "brands");
  await check("브랜드 추가", "저장하면 서버에 브랜드가 등록됩니다.");
});

test("coupon and campaign help opens on demand while their draft-only warnings stay visible", async ({
  page,
}) => {
  await setup(page, { path: "/admin?section=coupons" });
  const dialog = page.getByRole("dialog");
  const panel = couponWorkspace(page);
  // 접힌 도움말 안에 있던 경고는 이제 항상 화면에 표시됨.
  await expect(
    page.getByText(
      "이 화면은 쿠폰 초안만 저장합니다. 고객에게 발급하거나 결제에 적용하지 않습니다.",
    ),
  ).toBeVisible();
  await expect(panel.getByText("서버에 초안만 저장합니다")).toBeVisible();
  // 코드 형식 안내는 화면에서 숨겨도 입력란의 설명으로 남음.
  await expect(couponField(page, "쿠폰 코드 (필수)")).toHaveAccessibleDescription(
    /영문·숫자로 시작하는 3–32자/,
  );
  const check = async (target: string, text: string) => {
    const help = page.getByRole("button", { name: `${target} 도움말`, exact: true });
    await help.click();
    await expect(dialog).toContainText(text);
    await page.keyboard.press("Escape");
    await expect(dialog).toHaveCount(0);
    await expect(help).toBeFocused();
  };
  await expect(panel.getByText("1–100 사이 정수")).toHaveCount(0);
  await check("쿠폰 코드", "영문·숫자로 시작하는 3–32자");
  await check("할인 값", "1–100 사이 정수");
  await check("만료 시각", "입력한 한국 시간의 해당 시각에 만료합니다");

  await select(page, "marketing");
  await expect(
    page.getByText("이 화면은 제목·메시지·채널을 초안으로만 저장합니다."),
  ).toBeVisible();
  for (const text of [
    "수신 대상 미조회 · 발송 없음",
    "이 미리보기는 실제 전송물이 아닙니다",
  ])
    await expect(page.getByText(text, { exact: false }).first()).toBeVisible();
  await expect(page.getByText("초안 작성용 선택 · 채널 연결")).toHaveCount(0);
  await check(
    "채널 선택",
    "초안 작성용 선택 · 채널 연결·수신자 수·발송 가능 여부는 미조회입니다.",
  );
});

test("stock help explains the range while the input keeps its description and the error shows it again", async ({
  page,
}) => {
  await setup(page, {
    path: "/admin?section=inventory",
    catalogProducts: inventoryProducts,
  });
  await inventoryWorkspace(page)
    .getByRole("button", { name: `${products[0]!.name} 재고 조정`, exact: true })
    .click();
  const input = page.getByRole("textbox", { name: "변경 후 재고 수량", exact: true });
  // 화면에서는 숨겨도 입력란 설명으로는 계속 읽힘.
  await expect(input).toHaveAccessibleDescription(/0~1,000,000개/);
  const hint = page.locator("#inventory-input-hint");
  expect(
    await hint.evaluate((element) => element.getBoundingClientRect().width),
  ).toBeLessThanOrEqual(1);
  const help = page.getByRole("button", {
    name: "변경 후 재고 수량 도움말",
    exact: true,
  });
  await help.click();
  await expect(page.getByRole("dialog")).toContainText(
    "확인 전에는 수량이 변경되지 않습니다",
  );
  await page.keyboard.press("Escape");
  await expect(help).toBeFocused();
  await input.fill("1000001");
  await expect(page.locator("#inventory-draft-error")).toContainText(
    "0~1,000,000 사이의 정수를 입력해 주세요",
  );
});

test("product help: explanations stay behind '?' buttons that open, close with Esc and return focus", async ({
  page,
}) => {
  await setup(page, { path: "/admin?section=products" });
  await newProduct(page);
  const panel = page.locator("#admin-panel-products");
  // 설명은 요청하기 전까지 화면에 없음.
  for (const text of [
    "직접 입력하거나 선택한 뒤",
    "JPEG·PNG·WebP·GIF",
    "비공개 상품은 고객에게 표시되지 않습니다",
    "아직 고객에게 보이지 않습니다",
  ])
    await expect(panel.getByText(text)).toHaveCount(0);

  const dialog = page.getByRole("dialog");
  for (const [target, text] of [
    ["사이즈 / 옵션", "직접 입력하거나 선택한 뒤 ‘옵션 추가’를 누르세요"],
    ["대표 이미지", "JPEG·PNG·WebP·GIF · 최대 6MB"],
    ["상품 저장", "비공개 상품은 고객에게 표시되지 않습니다"],
    ["고객 화면 미리보기", "아직 고객에게 보이지 않습니다"],
  ] as const) {
    const help = panel.getByRole("button", { name: `${target} 도움말`, exact: true });
    const box = (await help.boundingBox())!;
    expect(box.width).toBeGreaterThanOrEqual(44);
    expect(box.height).toBeGreaterThanOrEqual(44);
    await help.click();
    await expect(dialog).toContainText(text);
    await expect(dialog.getByRole("heading")).toHaveText(`${target} 도움말`);
    await page.keyboard.press("Escape");
    await expect(dialog).toHaveCount(0);
    await expect(help).toBeFocused();
  }

  // 닫기 버튼도 같은 방식으로 동작함.
  const option = panel.getByRole("button", {
    name: "사이즈 / 옵션 도움말",
    exact: true,
  });
  await option.click();
  await dialog.getByRole("button", { name: "닫기", exact: true }).click();
  await expect(dialog).toHaveCount(0);
  await expect(option).toBeFocused();
});

test("screen guide walks the brand list, name and register button", async ({
  page,
}) => {
  await setup(page, { path: "/admin?section=brands", catalogProducts: brandProducts });
  const open = brandWorkspace(page).getByRole("button", {
    name: "화면 도움말",
    exact: true,
  });
  await open.click();
  const bubble = page.getByRole("dialog");
  await expect(bubble).toContainText("1/3단계");
  await expect(bubble.getByRole("heading")).toHaveText("있는 브랜드 확인");
  await page.keyboard.press("ArrowRight");
  await expect(bubble.getByRole("heading")).toHaveText("브랜드 이름 쓰기");
  // 이름 입력란 바로 아래에 밑줄이 그어짐.
  await expect
    .poll(async () => {
      const target = await boxOf(brandNameInput(page));
      const line = await boxOf(guideLines(page).first());
      return Math.abs(line.y - (target.y + target.height)) <= 6;
    })
    .toBe(true);
  await page.keyboard.press("ArrowRight");
  await expect(bubble.getByRole("heading")).toHaveText("등록하기");
  await bubble.getByRole("button", { name: "완료", exact: true }).click();
  await expect(bubble).toHaveCount(0);
  await expect(open).toBeFocused();
});

test("screen guide on members adds the permission step once a member is open", async ({
  page,
}) => {
  await setupMembers(page);
  const panel = memberWorkspace(page);
  const open = panel.getByRole("button", { name: "화면 도움말", exact: true });
  await expect(panel.locator("summary", { hasText: /^도움말$/ })).toHaveCount(0);
  await open.click();
  const bubble = page.getByRole("dialog");
  // 아직 아무도 선택하지 않았으므로 권한 영역은 화면에 없음.
  await expect(bubble).toContainText("1/2단계");
  await expect(bubble.getByRole("heading")).toHaveText("회원 불러오기");
  await page.keyboard.press("ArrowRight");
  await expect(bubble.getByRole("heading")).toHaveText("회원 고르기");
  await page.keyboard.press("Escape");
  await expect(bubble).toHaveCount(0);

  await loadMembers(page);
  // 목록 제목의 '?'가 예전 머리말 도움말 내용을 담음.
  await panel.getByRole("button", { name: "회원 목록 도움말", exact: true }).click();
  const listHelp = page.getByRole("dialog", { name: "회원 목록 도움말", exact: true });
  await expect(listHelp).toContainText(
    "전체 회원 검색이나 전체 회원 수 집계가 아닙니다",
  );
  await expect(listHelp).toContainText("admin·support 운영 권한뿐입니다");
  await page.keyboard.press("Escape");
  await expect(listHelp).toHaveCount(0);

  await memberChoice(page).click();
  await open.click();
  await expect(bubble).toContainText("1/3단계");
  await page.keyboard.press("ArrowRight");
  await page.keyboard.press("ArrowRight");
  await expect(bubble.getByRole("heading")).toHaveText("권한 바꾸기");
  await expect(guideRing(page)).toHaveCount(1);
  await bubble.getByRole("button", { name: "완료", exact: true }).click();
  await expect(open).toBeFocused();
});
