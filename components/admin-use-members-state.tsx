// 역할: 관리자 회원 메뉴의 회원 목록·조회/저장 상태·새로고침 필요 여부·목록 갱신 번호와 중복 요청 방지 ref를 묶은 상태 훅입니다.
"use client";
import type { AdminMember } from "@/lib/admin-ui/types";
import { useRef, useState } from "react";
import { Notice } from "./admin-shared";

export function useAdminMembersState() {
  const [members, setMembers] = useState<readonly AdminMember[]>([]);
  const [memberNotice, setMemberNotice] = useState<Notice>(null);
  const [isLoadingMembers, setIsLoadingMembers] = useState(false);
  const [membersLoaded, setMembersLoaded] = useState(false);
  const [memberLoadFailed, setMemberLoadFailed] = useState(false);
  const [memberNeedsRefresh, setMemberNeedsRefresh] = useState(false);
  const [isSavingMemberGroup, setIsSavingMemberGroup] = useState(false);
  const [memberRevision, setMemberRevision] = useState(0);
  const memberBusyRef = useRef(false);
  return {
    members,
    setMembers,
    memberNotice,
    setMemberNotice,
    isLoadingMembers,
    setIsLoadingMembers,
    membersLoaded,
    setMembersLoaded,
    memberLoadFailed,
    setMemberLoadFailed,
    memberNeedsRefresh,
    setMemberNeedsRefresh,
    isSavingMemberGroup,
    setIsSavingMemberGroup,
    memberRevision,
    setMemberRevision,
    memberBusyRef,
  } as const;
}
