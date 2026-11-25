// 역할: 회원 조회·권한 변경 검사용 모의 회원 응답과 회원 목록·상세·그룹 변경 준비 도우미를 제공함.
import { expect, type Page } from "@playwright/test";
import { respond, setup, SUBJECT } from "./admin-navigation-base-fixtures";

type SyntheticMember = {
  username: string;
  userSub: string;
  email: string;
  displayName: string;
  enabled: boolean;
  groups: string[];
};

const memberFixtures: SyntheticMember[] = [
  {
    username: "member+alex@example.test",
    userSub: "member-synthetic-alex",
    email: "alex@example.test",
    displayName: "[TEST] Alex",
    enabled: true,
    groups: [],
  },
  {
    username: "synthetic-support",
    userSub: "member-synthetic-support",
    email: "support@example.test",
    displayName: "[TEST] Support",
    enabled: false,
    groups: ["support"],
  },
  {
    username: "synthetic-admin",
    userSub: SUBJECT,
    email: "admin@example.test",
    displayName: "[TEST] Current admin",
    enabled: true,
    groups: ["admin"],
  },
];

type MemberFixtureState = {
  members: SyntheticMember[];
  reads: number;
  commands: Array<{ method: string; path: string; body: unknown }>;
  readFailed: boolean;
};

async function setupMembers(
  page: Page,
  options: {
    members?: SyntheticMember[];
    readGate?: Promise<void>;
    mutationGate?: Promise<void>;
    mutationFailed?: boolean;
    initiallyFailed?: boolean;
    waitForIdle?: boolean;
  } = {},
) {
  const state: MemberFixtureState = {
    members: structuredClone(options.members ?? memberFixtures),
    reads: 0,
    commands: [],
    readFailed: options.initiallyFailed ?? false,
  };
  const audit = await setup(page, {
    path: "/admin?section=members",
    waitForIdle: options.waitForIdle,
    handleMembers: async (route) => {
      state.reads += 1;
      if (options.readGate) await options.readGate;
      await respond(
        route,
        state.readFailed
          ? { code: "SYNTHETIC_MEMBER_QUERY_UNAVAILABLE" }
          : { members: state.members },
        state.readFailed ? 503 : 200,
      );
    },
    handleMemberMutation: async (route) => {
      const request = route.request();
      const path = new URL(request.url()).pathname;
      const body = request.postDataJSON();
      state.commands.push({ method: request.method(), path, body });
      expect(request.headers().authorization).toMatch(/^Bearer /);
      if (options.mutationGate) await options.mutationGate;
      if (options.mutationFailed)
        return respond(route, { code: "SYNTHETIC_MEMBER_GROUP_UNAVAILABLE" }, 503);
      const username = decodeURIComponent(path.split("/").at(-2)!);
      const member = state.members.find((item) => item.username === username)!;
      expect(["admin", "support"]).toContain(body.group);
      member.groups =
        request.method() === "POST"
          ? [...new Set([...member.groups, body.group])]
          : member.groups.filter((group) => group !== body.group);
      await respond(route, {
        username,
        group: body.group,
        action: request.method() === "POST" ? "ADDED" : "REMOVED",
      });
    },
  });
  return { state, audit };
}

const memberWorkspace = (page: Page) => page.locator("#admin-panel-members");

const loadMembers = (page: Page) =>
  memberWorkspace(page)
    .getByRole("button", { name: "회원 목록 불러오기", exact: true })
    .click();

const memberChoice = (page: Page, name = "[TEST] Alex") =>
  memberWorkspace(page).getByRole("button", { name: `${name} 회원 상세`, exact: true });

const memberDetail = (page: Page, name = "[TEST] Alex") =>
  memberWorkspace(page).getByRole("complementary", { name, exact: true });

async function prepareMemberGroup(
  page: Page,
  group: "admin" | "support",
  add: boolean,
  name = "[TEST] Alex",
) {
  const detail = memberDetail(page, name);
  await detail
    .getByRole("button", {
      name: `${group} ${add ? "부여" : "해제"} 준비`,
      exact: true,
    })
    .click();
  await expect(detail.getByLabel("권한 변경 미리보기", { exact: true })).toContainText(
    "아직 미반영",
  );
  await expect(
    detail.getByRole("button", { name: "권한 변경 내용 확인", exact: true }),
  ).toBeDisabled();
  await detail
    .getByLabel("선택한 회원과 권한 변경 내용을 확인했습니다", { exact: true })
    .check();
}

export {
  loadMembers,
  memberChoice,
  memberDetail,
  memberWorkspace,
  prepareMemberGroup,
  setupMembers,
};
