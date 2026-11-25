// 역할: 관리자 쿠폰 메뉴의 쿠폰명·코드·할인 방식·값·만료 시각·알림·저장 중 상태와 중복 저장 방지 ref를 묶은 상태 훅입니다.
"use client";
import { useRef, useState } from "react";
import { Notice } from "./admin-shared";

export function useAdminCouponDraft() {
  const [couponName, setCouponName] = useState("");
  const [couponCode, setCouponCode] = useState("");
  const [couponType, setCouponType] = useState<"percent" | "amount">("percent");
  const [couponValue, setCouponValue] = useState("");
  const [couponExpiresAt, setCouponExpiresAt] = useState("");
  const [couponNotice, setCouponNotice] = useState<Notice>(null);
  const [isSavingCoupon, setIsSavingCoupon] = useState(false);
  const couponBusyRef = useRef(false);
  return {
    couponName,
    setCouponName,
    couponCode,
    setCouponCode,
    couponType,
    setCouponType,
    couponValue,
    setCouponValue,
    couponExpiresAt,
    setCouponExpiresAt,
    couponNotice,
    setCouponNotice,
    isSavingCoupon,
    setIsSavingCoupon,
    couponBusyRef,
  } as const;
}
