// 역할: 관리자 재고 메뉴의 알림·저장 중 상품 id 목록과 상품별 중복 저장 방지 ref를 묶은 상태 훅입니다.
"use client";
import { useRef, useState } from "react";
import { Notice } from "./admin-shared";

export function useAdminInventoryState() {
  const [inventoryNotice, setInventoryNotice] = useState<Notice>(null);
  const [inventorySavingIds, setInventorySavingIds] = useState<ReadonlySet<string>>(
    () => new Set(),
  );
  const inventoryBusyRef = useRef(new Set<string>());
  return {
    inventoryNotice,
    setInventoryNotice,
    inventorySavingIds,
    setInventorySavingIds,
    inventoryBusyRef,
  } as const;
}
