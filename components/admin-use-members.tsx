// 역할: 회원 메뉴 훅. 관리자가 명시적으로 누를 때만 회원 목록을 조회하고, admin·support 권한 변경 뒤 목록을 다시 읽으며 조회·저장 상태와 결과 알림을 갱신합니다.
"use client";
import { useAuth } from "@/contexts/auth-context";
import type { AdminDashboardActions } from "@/lib/admin-ui/types";
import { type RefObject } from "react";
import { Notice } from "./admin-shared";

export function useAdminMembers({
  memberBusyRef,
  actions,
  setMemberLoadFailed,
  setMemberNotice,
  setIsLoadingMembers,
  setMembers,
  setMembersLoaded,
  setMemberNeedsRefresh,
  setMemberRevision,
  memberNeedsRefresh,
  memberLoadFailed,
  members,
  currentAdmin,
  setIsSavingMemberGroup,
}: Readonly<{
  memberBusyRef: RefObject<boolean>;
  actions: AdminDashboardActions | undefined;
  setMemberLoadFailed: React.Dispatch<React.SetStateAction<boolean>>;
  setMemberNotice: React.Dispatch<React.SetStateAction<Notice>>;
  setIsLoadingMembers: React.Dispatch<React.SetStateAction<boolean>>;
  setMembers: React.Dispatch<
    React.SetStateAction<
      readonly Readonly<{
        username: string;
        userSub?: string;
        email?: string;
        displayName?: string;
        enabled: boolean;
        groups: readonly string[];
      }>[]
    >
  >;
  setMembersLoaded: React.Dispatch<React.SetStateAction<boolean>>;
  setMemberNeedsRefresh: React.Dispatch<React.SetStateAction<boolean>>;
  setMemberRevision: React.Dispatch<React.SetStateAction<number>>;
  memberNeedsRefresh: boolean;
  memberLoadFailed: boolean;
  members: readonly Readonly<{
    username: string;
    userSub?: string;
    email?: string;
    displayName?: string;
    enabled: boolean;
    groups: readonly string[];
  }>[];
  currentAdmin: ReturnType<typeof useAuth>["user"];
  setIsSavingMemberGroup: React.Dispatch<React.SetStateAction<boolean>>;
}>) {
  /** 회원 개인정보는 자동 렌더링하지 않고 admin이 명시적으로 조회할 때만 API에서 읽습니다. */
  const handleLoadMembers = async () => {
    if (memberBusyRef.current) return;
    if (!actions?.listMembers) {
      setMemberLoadFailed(true);
      setMemberNotice({
        kind: "error",
        message: {
          ko: "회원 목록 API가 아직 연결되지 않았습니다.",
          en: "The member list API is not connected yet.",
        },
      });
      return;
    }

    memberBusyRef.current = true;
    try {
      setIsLoadingMembers(true);
      setMemberNotice(null);
      const nextMembers = await actions.listMembers();
      setMembers(nextMembers);
      setMembersLoaded(true);
      setMemberLoadFailed(false);
      setMemberNeedsRefresh(false);
      setMemberRevision((current) => current + 1);
      setMemberNotice({
        kind: "success",
        message: {
          ko: `이번 조회에서 회원 ${nextMembers.length}명을 불러왔습니다. 전체 회원 수가 아닌 이번 API 응답 범위입니다.`,
          en: `Loaded ${nextMembers.length} members in this query. This is the range of this API response, not the total member count.`,
        },
      });
    } catch {
      setMemberLoadFailed(true);
      setMemberNotice({
        kind: "error",
        message: {
          ko: "회원 목록을 불러오지 못했습니다. 기존 목록이 있다면 이전 조회 결과이며 최신 상태가 아닐 수 있습니다. 관리자 권한·연결을 확인한 뒤 다시 조회해 주세요.",
          en: "Could not load the member list. Any list shown is from an earlier query and may be out of date. Check admin access and the connection, then load it again.",
        },
      });
    } finally {
      memberBusyRef.current = false;
      setIsLoadingMembers(false);
    }
  };

  const handleMemberGroupUpdate = async (
    username: string,
    group: "admin" | "support",
    add: boolean,
    expectedGroups: readonly string[],
  ) => {
    if (memberBusyRef.current || memberNeedsRefresh || memberLoadFailed) return;
    const member = members.find((item) => item.username === username);
    if (
      !member ||
      JSON.stringify([...member.groups].sort()) !==
        JSON.stringify([...expectedGroups].sort()) ||
      member.groups.includes(group) === add
    ) {
      setMemberNeedsRefresh(true);
      setMemberNotice({
        kind: "error",
        message: {
          ko: "확인한 회원 권한과 현재 목록이 다릅니다. 회원 목록을 다시 조회하고 변경 내용을 검토해 주세요.",
          en: "The confirmed member permissions differ from the current list. Load the member list again and review the change.",
        },
      });
      return;
    }
    if (
      group === "admin" &&
      !add &&
      member.userSub &&
      member.userSub === currentAdmin?.sub
    ) {
      setMemberNotice({
        kind: "error",
        message: {
          ko: "자기 자신의 admin 권한은 해제할 수 없습니다.",
          en: "You cannot remove your own admin permission.",
        },
      });
      return;
    }
    if (!actions?.updateMemberGroup) {
      setMemberNotice({
        kind: "error",
        message: {
          ko: "회원 그룹 API가 아직 연결되지 않았습니다.",
          en: "The member group API is not connected yet.",
        },
      });
      return;
    }

    const changeLabel = {
      ko: `${username} 계정의 ${group} 그룹 ${add ? "부여" : "해제"}`,
      en: `${add ? "Granting" : "Removing"} the ${group} group ${add ? "to" : "from"} ${username}`,
    };
    memberBusyRef.current = true;
    setIsSavingMemberGroup(true);
    setMemberNotice(null);
    try {
      await actions.updateMemberGroup({ username, group, add });
      try {
        if (!actions.listMembers) throw new Error("Member list unavailable");
        setIsLoadingMembers(true);
        const nextMembers = await actions.listMembers();
        setMembers(nextMembers);
        setMembersLoaded(true);
        setMemberLoadFailed(false);
        setMemberNeedsRefresh(false);
        setMemberRevision((current) => current + 1);
      } catch {
        setMemberLoadFailed(true);
        setMemberNeedsRefresh(true);
        setMemberNotice({
          kind: "error",
          message: {
            ko: `${changeLabel.ko} 요청은 성공했습니다. 최신 회원 목록을 확인하지 못했으므로 이전 권한 표시를 신뢰하지 말고 다시 조회해 주세요. 재조회 전에는 권한을 다시 변경할 수 없습니다.`,
            en: `${changeLabel.en} succeeded. The latest member list could not be confirmed, so do not trust the earlier permissions shown; load the list again. You cannot change permissions again until you do.`,
          },
        });
        return;
      }
      setMemberNotice({
        kind: "success",
        message: {
          ko: `${changeLabel.ko} 요청이 성공했고 목록을 다시 불러왔습니다. 새 권한은 다음 로그인부터 적용됩니다.`,
          en: `${changeLabel.en} succeeded and the list was reloaded. The new permission applies from the next sign-in.`,
        },
      });
    } catch {
      setMemberNeedsRefresh(true);
      setMemberNotice({
        kind: "error",
        message: {
          ko: `${changeLabel.ko} 결과를 확인하지 못했습니다. 실제로 반영됐을 수 있으므로 재전송하지 말고 회원 목록을 다시 조회해 주세요. 자기 자신의 admin 해제는 서버에서 금지합니다.`,
          en: `Could not confirm the result of ${changeLabel.en}. It may have been applied, so do not resend; load the member list again. The server blocks removing your own admin permission.`,
        },
      });
    } finally {
      memberBusyRef.current = false;
      setIsSavingMemberGroup(false);
      setIsLoadingMembers(false);
    }
  };
  return { handleLoadMembers, handleMemberGroupUpdate } as const;
}
