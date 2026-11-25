import { expect, test } from "@playwright/test";
import { audits } from "./admin-navigation-base-fixtures";
import {
  loadMembers,
  memberChoice,
  memberDetail,
  memberWorkspace,
  prepareMemberGroup,
  setupMembers,
} from "./admin-navigation-member-fixtures";

test.afterEach(async ({ page }) => {
  expect(audits.get(page)?.blocked ?? []).toEqual([]);
});

test("member redesign: member data loads only on explicit request and distinguishes pending from a successful empty response", async ({
  page,
}) => {
  let release!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const { state, audit } = await setupMembers(page, { members: [], readGate: gate });
  const panel = memberWorkspace(page);
  await expect(
    panel.getByText("회원 목록을 아직 조회하지 않았습니다", { exact: true }),
  ).toBeVisible();
  await expect(
    panel.getByRole("heading", { name: "이번 조회 회원 —", exact: true }),
  ).toBeVisible();
  await expect(
    panel.getByRole("searchbox", { name: "불러온 회원 검색", exact: true }),
  ).toBeDisabled();
  expect(state.reads).toBe(0);
  try {
    await loadMembers(page);
    await expect.poll(() => state.reads).toBe(1);
    await expect(
      panel.getByText("회원 목록을 불러오고 있습니다", { exact: true }),
    ).toBeVisible();
    await expect(
      panel.getByRole("button", { name: "회원 목록 불러오는 중…", exact: true }),
    ).toBeDisabled();
    await expect(
      panel.getByRole("heading", { name: "이번 조회 회원 —", exact: true }),
    ).toBeVisible();
  } finally {
    release();
  }
  await expect(
    panel.getByText("이번 조회에서 회원이 반환되지 않았습니다", { exact: true }),
  ).toBeVisible();
  await expect(
    panel.getByRole("heading", { name: "이번 조회 회원 0명", exact: true }),
  ).toBeVisible();
  expect(state.commands).toEqual([]);
  expect(audit.syntheticWrites).toEqual([]);
});

test("member redesign: loaded search and selected detail reveal only returned read-only facts without persisting personal fields", async ({
  page,
}, testInfo) => {
  await page.setViewportSize({ width: 1440, height: 1000 });
  const { state, audit } = await setupMembers(page);
  await loadMembers(page);
  const panel = memberWorkspace(page);
  await expect(
    panel.getByRole("heading", { name: "이번 조회 회원 3명", exact: true }),
  ).toBeVisible();
  const search = panel.getByRole("searchbox", {
    name: "불러온 회원 검색",
    exact: true,
  });
  await search.fill("  AlEx@EXAMPLE.test  ");
  await expect(panel.locator('button[aria-label$=" 회원 상세"]')).toHaveCount(1);
  await memberChoice(page).focus();
  await page.keyboard.press("Enter");
  await expect(memberChoice(page)).toHaveAttribute("aria-pressed", "true");
  const detail = memberDetail(page);
  await expect(detail).toContainText("member+alex@example.test");
  await expect(detail).toContainText("계정 상태 (읽기 전용)");
  await expect(detail).toContainText("마케팅 수신 동의");
  await expect(detail).toContainText("조회 데이터 없음");
  await expect(detail.getByRole("checkbox")).toHaveCount(0);
  await expect(
    detail.getByRole("button", { name: /활성화|비활성화|수신 동의 변경/ }),
  ).toHaveCount(0);
  await search.fill("");
  await memberChoice(page, "[TEST] Support").click();
  await expect(memberDetail(page, "[TEST] Support")).toContainText("비활성");
  await memberChoice(page).click();
  const directory = panel.getByRole("region", {
    name: "이번 조회 회원 3명",
    exact: true,
  });
  const listBox = await directory.boundingBox();
  const detailBox = await detail.boundingBox();
  expect(listBox).not.toBeNull();
  expect(detailBox).not.toBeNull();
  expect(detailBox!.x).toBeGreaterThan(listBox!.x + listBox!.width - 1);
  expect(
    await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth),
  ).toBe(true);
  await page.screenshot({
    path: testInfo.outputPath("member-redesign-desktop-1440.png"),
    fullPage: true,
  });
  const stored = await page.evaluate(() =>
    JSON.stringify({
      href: location.href,
      history: history.state,
      local: { ...localStorage },
      session: { ...sessionStorage },
    }),
  );
  expect(stored).not.toContain("alex@example.test");
  expect(stored).not.toContain("[TEST] Alex");
  expect(state.reads).toBe(1);
  expect(state.commands).toEqual([]);
  expect(audit.syntheticWrites).toEqual([]);
});

test("member redesign: group previews and cancelled confirmations write nothing while accepted changes use the existing encoded POST and DELETE contract", async ({
  page,
}) => {
  const { state, audit } = await setupMembers(page);
  await loadMembers(page);
  await memberChoice(page).click();
  await prepareMemberGroup(page, "admin", true);
  const detail = memberDetail(page);
  await expect(detail.getByLabel("권한 변경 미리보기", { exact: true })).toContainText(
    "운영 그룹 없음",
  );
  expect(state.commands).toEqual([]);
  let cancelledMessage = "";
  page.once("dialog", async (dialog) => {
    cancelledMessage = dialog.message();
    await dialog.dismiss();
  });
  await detail
    .getByRole("button", { name: "권한 변경 내용 확인", exact: true })
    .click();
  expect(cancelledMessage).toContain("member+alex@example.test");
  expect(cancelledMessage).toContain("현재: 운영 그룹 없음");
  expect(cancelledMessage).toContain("변경 후: admin");
  expect(state.commands).toEqual([]);
  await detail.getByRole("button", { name: "권한 선택 취소", exact: true }).click();
  await expect(detail.getByLabel("권한 변경 미리보기", { exact: true })).toHaveCount(0);
  await prepareMemberGroup(page, "admin", true);
  page.once("dialog", (dialog) => void dialog.accept());
  await detail
    .getByRole("button", { name: "권한 변경 내용 확인", exact: true })
    .click();
  await expect.poll(() => state.commands.length).toBe(1);
  await expect(
    detail.getByRole("button", { name: "admin 해제 준비", exact: true }),
  ).toBeEnabled();
  expect(state.commands[0]).toEqual({
    method: "POST",
    path: "/prod/admin/members/member%2Balex%40example.test/groups",
    body: { group: "admin" },
  });
  await memberChoice(page, "[TEST] Support").click();
  await prepareMemberGroup(page, "support", false, "[TEST] Support");
  page.once("dialog", (dialog) => void dialog.accept());
  await memberDetail(page, "[TEST] Support")
    .getByRole("button", { name: "권한 변경 내용 확인", exact: true })
    .click();
  await expect.poll(() => state.commands.length).toBe(2);
  await expect(
    memberDetail(page, "[TEST] Support").getByRole("button", {
      name: "support 부여 준비",
      exact: true,
    }),
  ).toBeEnabled();
  expect(state.commands[1]).toEqual({
    method: "DELETE",
    path: "/prod/admin/members/synthetic-support/groups",
    body: { group: "support" },
  });
  expect(state.reads).toBe(3);
  expect(audit.syntheticWrites).toEqual([
    "POST https://api.sales.test/prod/admin/members/member%2Balex%40example.test/groups",
    "DELETE https://api.sales.test/prod/admin/members/synthetic-support/groups",
  ]);
});

test("member redesign: an in-flight group update prevents duplicate commands and selection or refresh races", async ({
  page,
}) => {
  let release!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const { state } = await setupMembers(page, { mutationGate: gate });
  await loadMembers(page);
  await memberChoice(page).click();
  await prepareMemberGroup(page, "support", true);
  const detail = memberDetail(page);
  page.once("dialog", (dialog) => void dialog.accept());
  try {
    await detail
      .getByRole("button", { name: "권한 변경 내용 확인", exact: true })
      .click();
    await expect.poll(() => state.commands.length).toBe(1);
    const save = detail.getByRole("button", { name: "권한 변경 중…", exact: true });
    await expect(save).toBeDisabled();
    await expect(memberChoice(page, "[TEST] Support")).toBeDisabled();
    await expect(
      memberWorkspace(page).getByRole("button", {
        name: "회원 목록 불러오기",
        exact: true,
      }),
    ).toBeDisabled();
    await expect(
      detail.getByRole("button", { name: "admin 부여 준비", exact: true }),
    ).toBeDisabled();
    await save.evaluate((button: HTMLButtonElement) => button.click());
    expect(state.commands).toHaveLength(1);
  } finally {
    release();
  }
  await expect(
    detail.getByRole("button", { name: "support 해제 준비", exact: true }),
  ).toBeEnabled();
  expect(state.commands).toHaveLength(1);
  expect(state.reads).toBe(2);
});

test("member redesign: an uncertain group response is not called successful and cannot be resent before explicit refresh", async ({
  page,
}) => {
  const { state } = await setupMembers(page, { mutationFailed: true });
  await loadMembers(page);
  await memberChoice(page).click();
  await prepareMemberGroup(page, "admin", true);
  page.once("dialog", (dialog) => void dialog.accept());
  await memberDetail(page)
    .getByRole("button", { name: "권한 변경 내용 확인", exact: true })
    .click();
  const panel = memberWorkspace(page);
  await expect(panel.getByRole("alert")).toContainText(
    "실제로 반영됐을 수 있으므로 재전송하지 말고",
  );
  await expect(panel.getByRole("status")).toHaveCount(0);
  await expect(
    memberDetail(page).getByRole("button", { name: "admin 부여 준비", exact: true }),
  ).toBeDisabled();
  await expect(
    memberDetail(page).getByRole("button", {
      name: "권한 변경 내용 확인",
      exact: true,
    }),
  ).toBeDisabled();
  expect(state.commands).toHaveLength(1);
  expect(state.members[0]!.groups).toEqual([]);
  await loadMembers(page);
  await expect(
    memberDetail(page).getByRole("button", { name: "admin 부여 준비", exact: true }),
  ).toBeEnabled();
  await expect(
    memberDetail(page).getByLabel("권한 변경 미리보기", { exact: true }),
  ).toHaveCount(0);
  expect(state.commands).toHaveLength(1);
});

test("member redesign: a failed first query is unknown not empty and failed refresh retains an explicitly outdated read-only list", async ({
  page,
}) => {
  const { state } = await setupMembers(page, { initiallyFailed: true });
  const panel = memberWorkspace(page);
  await loadMembers(page);
  await expect(panel.getByRole("alert")).toContainText(
    "회원 목록을 불러오지 못했습니다",
  );
  await expect(
    panel.getByText("최신 회원 목록을 확인하지 못했습니다", { exact: true }),
  ).toBeVisible();
  await expect(
    panel.getByRole("heading", { name: "이번 조회 회원 —", exact: true }),
  ).toBeVisible();
  await expect(
    panel.getByText("이번 조회에서 회원이 반환되지 않았습니다", { exact: true }),
  ).toHaveCount(0);
  state.readFailed = false;
  await loadMembers(page);
  await memberChoice(page).click();
  state.readFailed = true;
  await loadMembers(page);
  await expect(memberChoice(page)).toBeVisible();
  await expect(
    panel.getByText("최신 조회 실패 · 이전 결과일 수 있음", { exact: true }),
  ).toBeVisible();
  await expect(memberDetail(page)).toContainText("최신 권한을 확인해야 합니다");
  await expect(
    memberDetail(page).getByRole("button", { name: "support 부여 준비", exact: true }),
  ).toBeDisabled();
  expect(state.reads).toBe(3);
  expect(state.commands).toEqual([]);
});

test("member redesign: confirmed server update plus failed reload does not display guessed new permissions or allow another change", async ({
  page,
}) => {
  const { state } = await setupMembers(page);
  await loadMembers(page);
  await memberChoice(page).click();
  await prepareMemberGroup(page, "admin", true);
  state.readFailed = true;
  page.once("dialog", (dialog) => void dialog.accept());
  await memberDetail(page)
    .getByRole("button", { name: "권한 변경 내용 확인", exact: true })
    .click();
  await expect(memberWorkspace(page).getByRole("alert")).toContainText(
    "요청은 성공했습니다. 최신 회원 목록을 확인하지 못했으므로",
  );
  await expect(
    memberDetail(page).getByRole("button", { name: "admin 부여 준비", exact: true }),
  ).toBeDisabled();
  await expect(memberWorkspace(page).getByRole("status")).toHaveCount(0);
  expect(state.commands).toHaveLength(1);
  expect(state.members[0]!.groups).toEqual(["admin"]);
  state.readFailed = false;
  await loadMembers(page);
  await expect(
    memberDetail(page).getByRole("button", { name: "admin 해제 준비", exact: true }),
  ).toBeEnabled();
  expect(state.commands).toHaveLength(1);
});

test("member redesign: the signed-in administrator cannot prepare removing their own admin group", async ({
  page,
}) => {
  const { state, audit } = await setupMembers(page);
  await loadMembers(page);
  await memberChoice(page, "[TEST] Current admin").click();
  const detail = memberDetail(page, "[TEST] Current admin");
  const remove = detail.getByRole("button", { name: "admin 해제 준비", exact: true });
  await expect(remove).toBeDisabled();
  await expect(detail).toContainText("본인 계정의 admin 권한은 해제할 수 없습니다");
  await remove.evaluate((button: HTMLButtonElement) => button.click());
  await expect(
    detail.getByRole("button", { name: "권한 변경 내용 확인", exact: true }),
  ).toBeDisabled();
  expect(state.commands).toEqual([]);
  expect(audit.syntheticWrites).toEqual([]);
});

test("member redesign: mobile selection focuses detail and reflows at 375 and 320 with 44-pixel permission controls", async ({
  page,
}, testInfo) => {
  await page.setViewportSize({ width: 375, height: 900 });
  const { state } = await setupMembers(page);
  await loadMembers(page);
  await memberChoice(page).focus();
  await page.keyboard.press("Enter");
  const detail = memberDetail(page);
  const heading = detail.getByRole("heading", { name: "[TEST] Alex", exact: true });
  await expect(heading).toBeFocused();
  const box = await heading.boundingBox();
  expect(box).not.toBeNull();
  expect(box!.y).toBeGreaterThanOrEqual(0);
  expect(box!.y).toBeLessThan(900);
  await page.keyboard.press("Tab");
  await expect(
    detail.getByRole("button", { name: "support 부여 준비", exact: true }),
  ).toBeFocused();
  await prepareMemberGroup(page, "support", true);
  for (const width of [375, 320]) {
    await page.setViewportSize({ width, height: 900 });
    expect(
      await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth),
    ).toBe(true);
    for (const name of [
      "support 부여 준비",
      "admin 부여 준비",
      "권한 변경 내용 확인",
      "권한 선택 취소",
    ])
      expect(
        (await detail.getByRole("button", { name, exact: true }).boundingBox())?.height,
      ).toBeGreaterThanOrEqual(44);
    expect(
      (
        await memberWorkspace(page)
          .getByRole("searchbox", { name: "불러온 회원 검색", exact: true })
          .boundingBox()
      )?.height,
    ).toBeGreaterThanOrEqual(44);
    await page.screenshot({
      path: testInfo.outputPath(`member-redesign-mobile-${width}.png`),
      fullPage: true,
    });
    await detail.screenshot({
      path: testInfo.outputPath(`member-redesign-mobile-detail-${width}.png`),
    });
  }
  expect(state.commands).toEqual([]);
});
