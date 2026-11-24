"use client";
import { useRef, useState } from "react";
import { Notice } from "./admin-shared";

export function useAdminBrandState() {
  const [brandName, setBrandName] = useState("");
  const [brandMemo, setBrandMemo] = useState("");
  const [localBrands, setLocalBrands] = useState<string[]>([]);
  const [brandNotice, setBrandNotice] = useState<Notice>(null);
  const [isSavingBrand, setIsSavingBrand] = useState(false);
  const brandBusyRef = useRef(false);
  return {
    brandName,
    setBrandName,
    brandMemo,
    setBrandMemo,
    localBrands,
    setLocalBrands,
    brandNotice,
    setBrandNotice,
    isSavingBrand,
    setIsSavingBrand,
    brandBusyRef,
  } as const;
}
