"use client";
import adminMembersSectionStyles from "./admin-members-section.module.css";
import adminSharedStyles from "./admin-shared.module.css";
import { useLocale } from "@/contexts/locale-context";
import { adminGuideSteps } from "@/lib/admin-ui/admin-guides";
import type { AdminMember } from "@/lib/admin-ui/types";
import { useEffect, useRef, useState } from "react";
import styles from "./admin-dashboard.module.css";
import { AdminGuideButton } from "./admin-guide";
import { AdminHelpButton } from "./admin-help-button";
import { MemberDetail } from "./admin-member-detail";
import { EmptyState, Notice, NoticeMessage } from "./admin-shared";
import { AdminStepper, type AdminStep } from "./admin-stepper";

export function MembersSection({
  canLoad,
  canUpdate,
  currentUserSub,
  loaded,
  loadFailed,
  loading,
  members,
  needsRefresh,
  notice,
  onLoad,
  onUpdateGroup,
  revision,
  saving,
}: Readonly<{
  canLoad: boolean;
  canUpdate: boolean;
  currentUserSub?: string;
  loaded: boolean;
  loadFailed: boolean;
  loading: boolean;
  members: readonly AdminMember[];
  needsRefresh: boolean;
  notice: Notice;
  onLoad: () => void;
  onUpdateGroup: (
    username: string,
    group: "admin" | "support",
    add: boolean,
    expectedGroups: readonly string[],
  ) => void;
  revision: number;
  saving: boolean;
}>) {
  const { locale } = useLocale();
  const isKorean = locale === "ko";
  const [search, setSearch] = useState("");
  const [selectedUsername, setSelectedUsername] = useState<string | null>(null);
  // 권한 변경 저장이 성공으로 끝난 경우만 마지막 단계를 완료로 봅니다(조회 성공 알림 제외).
  const [groupChanged, setGroupChanged] = useState(false);
  const [wasSaving, setWasSaving] = useState(saving);
  if (saving !== wasSaving) {
    setWasSaving(saving);
    if (!saving && notice?.kind === "success") setGroupChanged(true);
  }
  const focusFrameRef = useRef<number | null>(null);
  const locked = loading || saving;
  useEffect(
    () => () => {
      if (focusFrameRef.current !== null) cancelAnimationFrame(focusFrameRef.current);
    },
    [],
  );
  const matching = members.filter((member) =>
    [member.displayName, member.email, member.username].some((value) =>
      value?.toLowerCase().includes(search.trim().toLowerCase()),
    ),
  );
  const selected = members.find((member) => member.username === selectedUsername);
  function selectMember(username: string) {
    setSelectedUsername(username);
    setGroupChanged(false);
    if (focusFrameRef.current !== null) cancelAnimationFrame(focusFrameRef.current);
    if (window.matchMedia("(max-width: 1200px)").matches) {
      focusFrameRef.current = requestAnimationFrame(() => {
        focusFrameRef.current = null;
        const heading = document.getElementById("member-detail-title");
        if (heading?.dataset.memberUsername !== username) return;
        heading.focus({ preventScroll: true });
        heading.scrollIntoView({ behavior: "instant", block: "start" });
      });
    }
  }
  const emptyTitle = loading
    ? isKorean
      ? "회원 목록을 불러오고 있습니다"
      : "Loading the member list"
    : loadFailed
      ? isKorean
        ? "최신 회원 목록을 확인하지 못했습니다"
        : "Could not confirm the latest member list"
      : !loaded
        ? isKorean
          ? "회원 목록을 아직 조회하지 않았습니다"
          : "The member list has not been loaded yet"
        : members.length === 0
          ? isKorean
            ? "이번 조회에서 회원이 반환되지 않았습니다"
            : "No members were returned in this query"
          : isKorean
            ? "검색 조건에 맞는 회원이 없습니다"
            : "No members match the search";
  const memberSteps: AdminStep[] = [
    {
      label: isKorean ? "회원 조회" : "Load members",
      state: !canLoad ? "unavailable" : loaded && !loadFailed ? "complete" : "current",
    },
    {
      label: isKorean ? "회원 선택" : "Select member",
      state: !loaded || loadFailed ? "upcoming" : selected ? "complete" : "current",
    },
    {
      label: isKorean ? "권한 변경" : "Change permission",
      state: !canUpdate
        ? "unavailable"
        : !selected
          ? "upcoming"
          : groupChanged && !saving
            ? "complete"
            : "current",
    },
  ];
  return (
    <div className={`${styles.sectionStack} ${styles.memberScreen}`}>
      <AdminStepper
        className={styles.screenStepper}
        label={isKorean ? "회원 작업 흐름" : "Member workflow"}
        locale={locale}
        steps={memberSteps}
      />
      <header className={adminMembersSectionStyles.memberHeader}>
        <div>
          <p>{isKorean ? "고객 / 회원" : "Customers / Members"}</p>
          <h2>{isKorean ? "회원 관리" : "Members"}</h2>
        </div>
        <AdminGuideButton locale={locale} steps={adminGuideSteps("members", locale)} />
      </header>
      <section
        className={styles.memberToolbar}
        aria-label={isKorean ? "회원 조회" : "Load members"}
      >
        <label>
          <span>{isKorean ? "불러온 회원 검색" : "Search loaded members"}</span>
          <input
            disabled={!loaded || locked}
            onChange={(event) => setSearch(event.target.value)}
            placeholder={
              isKorean ? "이름·이메일·계정 식별자" : "Name · email · account ID"
            }
            type="search"
            value={search}
          />
        </label>
        <button
          className={styles.primaryButton}
          data-admin-guide="members.load"
          disabled={locked || !canLoad}
          onClick={onLoad}
          type="button"
        >
          {loading
            ? isKorean
              ? "회원 목록 불러오는 중…"
              : "Loading members…"
            : isKorean
              ? "회원 목록 불러오기"
              : "Load member list"}
        </button>
        <p>
          {isKorean
            ? "필요할 때만 조회 · 검색어와 선택 회원은 URL·저장소에 보관하지 않습니다."
            : "Loaded only when needed · Search terms and the selected member are not kept in the URL or storage."}
        </p>
      </section>
      {!canLoad ? (
        <p className={adminMembersSectionStyles.memberStateNote}>
          {isKorean
            ? "회원 목록 API가 연결되지 않았습니다. 서버 연결 후 조회할 수 있습니다."
            : "The member list API is not connected. You can load members once the server is connected."}
        </p>
      ) : null}
      {notice ? <NoticeMessage notice={notice} /> : null}
      <div className={adminMembersSectionStyles.memberWorkspace}>
        <section
          className={adminMembersSectionStyles.memberDirectory}
          aria-labelledby="member-list-title"
          data-admin-guide="members.list"
        >
          <div className={adminMembersSectionStyles.memberDirectoryHeading}>
            <div className={adminSharedStyles.titleWithHelp}>
              <h3 id="member-list-title">
                {loaded
                  ? isKorean
                    ? `이번 조회 회원 ${members.length}명`
                    : `Members in this query: ${members.length}`
                  : isKorean
                    ? "이번 조회 회원 —"
                    : "Members in this query: —"}
              </h3>
              <AdminHelpButton
                locale={locale}
                target={isKorean ? "회원 목록" : "Member list"}
              >
                <p>
                  {isKorean
                    ? "조회 버튼을 눌러야 회원 정보를 불러옵니다. 검색은 이번 API 응답의 회원만 필터링하며 전체 회원 검색이나 전체 회원 수 집계가 아닙니다."
                    : "Member information loads only when you press the load button. Search filters only the members in this API response; it is not a full member search or total count."}
                </p>
                <p>
                  {isKorean
                    ? "계정 활성 상태는 읽기 전용이며 수신 동의 정보는 제공되지 않습니다. 이 화면에서 변경할 수 있는 항목은 admin·support 운영 권한뿐입니다."
                    : "Account status is read-only and consent information is not provided. Only the admin and support operating permissions can be changed here."}
                </p>
              </AdminHelpButton>
            </div>
            <p>
              {loadFailed
                ? isKorean
                  ? "최신 조회 실패 · 이전 결과일 수 있음"
                  : "Latest load failed · May be an earlier result"
                : isKorean
                  ? "이번 API 응답 범위 · 전체 회원 목록 아님"
                  : "This API response only · Not the full member list"}
            </p>
          </div>
          {matching.length ? (
            <ul className={adminMembersSectionStyles.memberDirectoryList}>
              {matching.map((member) => {
                const label = member.displayName ?? member.email ?? member.username;
                return (
                  <li key={member.username}>
                    <button
                      aria-label={
                        isKorean ? `${label} 회원 상세` : `${label} member details`
                      }
                      aria-pressed={selectedUsername === member.username}
                      disabled={locked}
                      onClick={() => selectMember(member.username)}
                      type="button"
                    >
                      <span className={adminMembersSectionStyles.memberIdentity}>
                        <strong>{label}</strong>
                        <span>{member.email ?? member.username}</span>
                      </span>
                      <span className={adminMembersSectionStyles.memberGroupSummary}>
                        {member.groups.length
                          ? member.groups.join(" · ")
                          : isKorean
                            ? "운영 그룹 없음"
                            : "No operating group"}
                      </span>
                      <span className={adminMembersSectionStyles.memberEnabled}>
                        {member.enabled
                          ? isKorean
                            ? "활성"
                            : "Active"
                          : isKorean
                            ? "비활성"
                            : "Inactive"}
                      </span>
                    </button>
                  </li>
                );
              })}
            </ul>
          ) : (
            <EmptyState
              title={emptyTitle}
              description={
                loaded && members.length > 0
                  ? isKorean
                    ? "이름·이메일·계정 식별자로 다시 검색해 보세요."
                    : "Search again by name, email or account ID."
                  : isKorean
                    ? "조회 버튼을 눌러 이번 응답 범위의 회원 정보를 확인하세요."
                    : "Press the load button to see members in this response."
              }
            />
          )}
        </section>
        {selected ? (
          <MemberDetail
            key={`${selected.username}:${revision}`}
            canUpdate={canUpdate}
            currentUserSub={currentUserSub}
            locked={locked}
            member={selected}
            needsRefresh={needsRefresh || loadFailed}
            onUpdateGroup={onUpdateGroup}
            saving={saving}
          />
        ) : (
          <aside className={adminMembersSectionStyles.memberDetailEmpty}>
            <span aria-hidden="true">◎</span>
            <h3>{isKorean ? "회원 상세" : "Member details"}</h3>
            <p>
              {loaded
                ? isKorean
                  ? "목록에서 회원을 선택하면 계정 상태와 운영 권한을 확인할 수 있습니다."
                  : "Select a member in the list to see account status and operating permissions."
                : isKorean
                  ? "회원 목록을 먼저 불러와 주세요."
                  : "Load the member list first."}
            </p>
          </aside>
        )}
      </div>
    </div>
  );
}
