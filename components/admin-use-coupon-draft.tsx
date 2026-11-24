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
