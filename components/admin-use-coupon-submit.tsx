"use client";
import type { AdminCouponDraft, AdminDashboardActions } from "@/lib/admin-ui/types";
import { type FormEvent, type RefObject } from "react";
import {
  couponDraftValidation,
  couponExpiryIso,
  moneyFormatter,
  Notice,
  OperationActivity,
} from "./admin-shared";

export function useAdminCouponSubmit({
  couponBusyRef,
  couponName,
  couponCode,
  couponType,
  couponValue,
  couponExpiresAt,
  setCouponNotice,
  actions,
  setIsSavingCoupon,
  recordActivity,
}: Readonly<{
  couponBusyRef: RefObject<boolean>;
  couponName: string;
  couponCode: string;
  couponType: "percent" | "amount";
  couponValue: string;
  couponExpiresAt: string;
  setCouponNotice: React.Dispatch<React.SetStateAction<Notice>>;
  actions: AdminDashboardActions | undefined;
  setIsSavingCoupon: React.Dispatch<React.SetStateAction<boolean>>;
  recordActivity: (activity: Omit<OperationActivity, "at">) => void;
}>) {
  const handleCouponSubmit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (couponBusyRef.current) return;
    const validationMessage = couponDraftValidation(
      couponName,
      couponCode,
      couponType,
      couponValue,
      couponExpiresAt,
    );
    if (validationMessage) {
      setCouponNotice({
        kind: "error",
        message: validationMessage,
      });
      return;
    }

    const formattedBenefit =
      couponType === "percent"
        ? { ko: `${Number(couponValue)}% 할인`, en: `${Number(couponValue)}% off` }
        : {
            ko: `${moneyFormatter.format(Number(couponValue))} 할인`,
            en: `${moneyFormatter.format(Number(couponValue))} off`,
          };
    const expiresAt = couponExpiryIso(couponExpiresAt);
    const draft: AdminCouponDraft = {
      name: couponName.trim(),
      code: couponCode.trim().toUpperCase(),
      discountType: couponType === "percent" ? "PERCENT" : "AMOUNT",
      discountValue: Number(couponValue),
      ...(expiresAt ? { expiresAt } : {}),
    };

    const saveToServer = actions?.saveCouponDraft;
    couponBusyRef.current = true;
    try {
      setIsSavingCoupon(true);
      setCouponNotice(null);
      if (saveToServer) await saveToServer(draft);
      recordActivity({
        key: "coupons",
        section: "coupons",
        status: "draft",
        detail: saveToServer
          ? {
              ko: "쿠폰 초안을 서버에 저장했습니다. 고객 미발급",
              en: "Saved the coupon draft to the server. Not issued to customers",
            }
          : {
              ko: "쿠폰 초안을 이 화면에만 준비했습니다. 서버 미저장 · 고객 미발급",
              en: "Prepared the coupon draft on this screen only. Not saved to the server · Not issued to customers",
            },
      });
      setCouponNotice({
        kind: "success",
        message: saveToServer
          ? {
              ko: `${draft.code} · ${formattedBenefit.ko} 초안을 서버에 저장했습니다. 아직 고객에게 발급되지 않았습니다.`,
              en: `Saved the ${draft.code} · ${formattedBenefit.en} draft to the server. It has not been issued to customers yet.`,
            }
          : {
              ko: `${draft.code} · ${formattedBenefit.ko} 초안을 이 화면에만 준비했습니다. 서버 저장·고객 발급은 하지 않았습니다.`,
              en: `Prepared the ${draft.code} · ${formattedBenefit.en} draft on this screen only. It was not saved to the server or issued to customers.`,
            },
      });
    } catch {
      recordActivity({
        key: "coupons",
        section: "coupons",
        status: "attention",
        detail: {
          ko: "쿠폰 초안 저장 결과를 확인해야 합니다. 고객 발급 완료가 아닙니다.",
          en: "Check the coupon draft save result. It has not been issued to customers.",
        },
      });
      setCouponNotice({
        kind: "error",
        message: {
          ko: "쿠폰 초안 저장 결과를 확인하지 못했습니다. 입력은 유지했습니다. 중복 저장하지 않도록 서버 처리 결과와 연결을 확인해 주세요.",
          en: "Could not confirm the coupon draft save. Your input is kept. To avoid a duplicate, check the server result and the connection.",
        },
      });
    } finally {
      couponBusyRef.current = false;
      setIsSavingCoupon(false);
    }
  };
  return { handleCouponSubmit } as const;
}
