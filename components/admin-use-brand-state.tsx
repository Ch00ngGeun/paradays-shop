// 역할: 관리자 브랜드 메뉴의 입력값·이 화면에서 추가한 브랜드 목록(서버 등록·임시 추가 모두)·알림·저장 중 상태와 중복 저장 방지 ref를 묶은 상태 훅입니다.
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
