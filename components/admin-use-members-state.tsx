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
