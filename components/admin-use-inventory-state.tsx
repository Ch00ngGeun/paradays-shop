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
