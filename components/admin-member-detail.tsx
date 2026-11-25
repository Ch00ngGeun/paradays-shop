// 역할: 회원 메뉴에서 고른 회원의 상세 정보와 admin·support 권한 추가·제거 미리보기를 보여 주고, 확인 체크·재확인 후 권한 변경을 요청합니다(자기 admin 권한 해제는 막음).
"use client";
import adminMembersSectionStyles from "./admin-members-section.module.css";
import { useLocale } from "@/contexts/locale-context";
import type { AdminMember } from "@/lib/admin-ui/types";
import { useState } from "react";
import styles from "./admin-dashboard.module.css";
import { AdminHelpButton } from "./admin-help-button";

export function MemberDetail({
  canUpdate,
  currentUserSub,
  locked,
  member,
  needsRefresh,
  onUpdateGroup,
  saving,
}: Readonly<{
  canUpdate: boolean;
  currentUserSub?: string;
  locked: boolean;
  member: AdminMember;
  needsRefresh: boolean;
  onUpdateGroup: (
    username: string,
    group: "admin" | "support",
    add: boolean,
    expectedGroups: readonly string[],
  ) => void;
  saving: boolean;
}>) {
  const { locale } = useLocale();
  const isKorean = locale === "ko";
  const [group, setGroup] = useState<"admin" | "support" | null>(null);
  const [confirmed, setConfirmed] = useState(false);
  const label = member.displayName ?? member.email ?? member.username;
  const currentGroups = member.groups.length
    ? member.groups.join(" · ")
    : isKorean
      ? "운영 그룹 없음"
      : "No operating group";
  const add = group ? !member.groups.includes(group) : false;
  const nextGroups = group
    ? add
      ? [...member.groups, group]
      : member.groups.filter((value) => value !== group)
    : member.groups;
  const selfAdminBlocked =
    group === "admin" &&
    !add &&
    Boolean(member.userSub && member.userSub === currentUserSub);
  const cannotChange = locked || needsRefresh || !canUpdate;
  return (
    <aside
      className={adminMembersSectionStyles.memberDetail}
      aria-labelledby="member-detail-title"
    >
      <div className={adminMembersSectionStyles.memberDetailHeading}>
        <h3
          data-member-username={member.username}
          id="member-detail-title"
          tabIndex={-1}
        >
          {label}
        </h3>
        <span>
          {needsRefresh
            ? isKorean
              ? "최신 확인 필요"
              : "Check latest"
            : group
              ? isKorean
                ? "변경 전 확인"
                : "Review before change"
              : isKorean
                ? "읽기·권한 관리"
                : "View & permissions"}
        </span>
      </div>
      <dl className={adminMembersSectionStyles.memberFacts}>
        <div>
          <dt>{isKorean ? "계정 식별자" : "Account ID"}</dt>
          <dd>{member.username}</dd>
        </div>
        {member.email ? (
          <div>
            <dt>{isKorean ? "이메일" : "Email"}</dt>
            <dd>{member.email}</dd>
          </div>
        ) : null}
        <div>
          <dt>
            {isKorean ? "계정 상태" : "Account status"}{" "}
            <span>{isKorean ? "(읽기 전용)" : "(read-only)"}</span>
          </dt>
          <dd>
            {member.enabled
              ? isKorean
                ? "활성"
                : "Active"
              : isKorean
                ? "비활성"
                : "Inactive"}
          </dd>
        </div>
        <div>
          <dt>{isKorean ? "마케팅 수신 동의" : "Marketing consent"}</dt>
          <dd>{isKorean ? "조회 데이터 없음" : "No data loaded"}</dd>
        </div>
        <div>
          <dt>{isKorean ? "현재 운영 권한" : "Current permissions"}</dt>
          <dd>{currentGroups}</dd>
        </div>
      </dl>
      <fieldset
        className={adminMembersSectionStyles.memberPermissionFields}
        data-admin-guide="members.roles"
        disabled={cannotChange}
      >
        <legend>{isKorean ? "운영 권한 변경" : "Change operating permission"}</legend>
        <p>
          {isKorean
            ? "변경할 권한을 선택해 현재 상태와 적용할 내용을 비교하세요."
            : "Choose a permission to compare the current state with the change."}
        </p>
        <div className={adminMembersSectionStyles.memberPermissionChoices}>
          {(["support", "admin"] as const).map((value) => {
            const removing = member.groups.includes(value);
            const isSelfAdmin =
              value === "admin" &&
              removing &&
              Boolean(member.userSub && member.userSub === currentUserSub);
            return (
              <button
                aria-pressed={group === value}
                disabled={isSelfAdmin}
                key={value}
                onClick={() => {
                  setGroup(value);
                  setConfirmed(false);
                }}
                type="button"
              >
                {value}{" "}
                {removing
                  ? isKorean
                    ? "해제 준비"
                    : "prepare removal"
                  : isKorean
                    ? "부여 준비"
                    : "prepare grant"}
              </button>
            );
          })}
        </div>
        {member.groups.includes("admin") &&
        member.userSub &&
        member.userSub === currentUserSub ? (
          <p className={adminMembersSectionStyles.memberStateNote}>
            {isKorean
              ? "본인 계정의 admin 권한은 해제할 수 없습니다."
              : "You cannot remove the admin permission from your own account."}
          </p>
        ) : null}
        {group ? (
          <div
            className={adminMembersSectionStyles.memberChangePreview}
            aria-label={isKorean ? "권한 변경 미리보기" : "Permission change preview"}
          >
            <strong>{isKorean ? "아직 미반영" : "Not applied yet"}</strong>
            <dl>
              <div>
                <dt>{isKorean ? "현재" : "Now"}</dt>
                <dd>{currentGroups}</dd>
              </div>
              <div>
                <dt>{isKorean ? "변경 후" : "After"}</dt>
                <dd>
                  {nextGroups.length
                    ? nextGroups.join(" · ")
                    : isKorean
                      ? "운영 그룹 없음"
                      : "No operating group"}
                </dd>
              </div>
            </dl>
            <p>
              {isKorean
                ? `${group} 그룹을 ${add ? "부여" : "해제"}합니다. 대상: ${member.username}`
                : `${add ? "Grants" : "Removes"} the ${group} group. Target: ${member.username}`}
            </p>
            <label>
              <input
                checked={confirmed}
                onChange={(event) => setConfirmed(event.target.checked)}
                type="checkbox"
              />
              {isKorean
                ? "선택한 회원과 권한 변경 내용을 확인했습니다"
                : "I checked the selected member and the permission change"}
            </label>
          </div>
        ) : null}
        <div className={adminMembersSectionStyles.memberPermissionActions}>
          <button
            className={styles.primaryButton}
            disabled={!group || !confirmed || selfAdminBlocked}
            onClick={() => {
              if (!group || !confirmed || cannotChange || selfAdminBlocked) return;
              if (
                !window.confirm(
                  isKorean
                    ? `${label} (${member.username})\n현재: ${currentGroups}\n변경 후: ${nextGroups.length ? nextGroups.join(" · ") : isKorean ? "운영 그룹 없음" : "No operating group"}\n${group} 그룹을 ${add ? "부여" : "해제"}할까요?`
                    : `${label} (${member.username})\nNow: ${currentGroups}\nAfter: ${nextGroups.length ? nextGroups.join(" · ") : "No operating group"}\n${add ? "Grant" : "Remove"} the ${group} group?`,
                )
              )
                return;
              onUpdateGroup(member.username, group, add, member.groups);
            }}
            type="button"
          >
            {saving
              ? isKorean
                ? "권한 변경 중…"
                : "Changing permission…"
              : isKorean
                ? "권한 변경 내용 확인"
                : "Review permission change"}
          </button>
          <button
            className={styles.secondaryButton}
            disabled={!group}
            onClick={() => {
              setGroup(null);
              setConfirmed(false);
            }}
            type="button"
          >
            {isKorean ? "권한 선택 취소" : "Cancel selection"}
          </button>
        </div>
      </fieldset>
      {needsRefresh ? (
        <p className={adminMembersSectionStyles.memberStateWarning}>
          {isKorean
            ? "최신 권한을 확인해야 합니다. 회원 목록을 다시 불러온 뒤 변경 내용을 새로 검토하세요."
            : "Check the latest permissions. Load the member list again, then review the change from scratch."}
        </p>
      ) : !canUpdate ? (
        <p className={adminMembersSectionStyles.memberStateNote}>
          {isKorean
            ? "권한 변경 API가 연결되지 않아 읽기만 가능합니다."
            : "The permission API is not connected, so this is read-only."}
        </p>
      ) : (
        <div className={adminMembersSectionStyles.memberStateNote}>
          <AdminHelpButton
            locale={locale}
            target={isKorean ? "운영 권한 변경" : "Change operating permission"}
          >
            <p>
              {isKorean
                ? "그룹 변경은 서버에서 다시 검증합니다. 새 권한은 다음 로그인부터 적용됩니다."
                : "The server validates group changes again. New permissions apply from the next sign-in."}
            </p>
          </AdminHelpButton>
        </div>
      )}
    </aside>
  );
}
