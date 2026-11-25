// 역할: 브랜드 추가 폼 제출 훅. 이름·메모를 검증하고, 서버 저장 action이 있으면 등록하고 없으면 이 화면에만 임시 추가한 뒤 알림·운영 기록을 남깁니다.
"use client";
import type {
  AdminBrandDraft,
  AdminCatalogListItem,
  AdminDashboardActions,
} from "@/lib/admin-ui/types";
import { type FormEvent, type RefObject } from "react";
import { Notice, OperationActivity } from "./admin-shared";

export function useAdminBrandDraft({
  brandBusyRef,
  brandName,
  setBrandNotice,
  brandMemo,
  localBrands,
  localProducts,
  actions,
  setIsSavingBrand,
  setLocalBrands,
  recordActivity,
  setBrandName,
  setBrandMemo,
}: Readonly<{
  brandBusyRef: RefObject<boolean>;
  brandName: string;
  setBrandNotice: React.Dispatch<React.SetStateAction<Notice>>;
  brandMemo: string;
  localBrands: string[];
  localProducts: readonly AdminCatalogListItem[];
  actions: AdminDashboardActions | undefined;
  setIsSavingBrand: React.Dispatch<React.SetStateAction<boolean>>;
  setLocalBrands: React.Dispatch<React.SetStateAction<string[]>>;
  recordActivity: (activity: Omit<OperationActivity, "at">) => void;
  setBrandName: React.Dispatch<React.SetStateAction<string>>;
  setBrandMemo: React.Dispatch<React.SetStateAction<string>>;
}>) {
  const handleBrandSubmit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (brandBusyRef.current) return;
    const normalizedBrand = brandName.trim();

    if (!normalizedBrand) {
      setBrandNotice({
        kind: "error",
        message: { ko: "브랜드명을 입력해 주세요.", en: "Enter a brand name." },
      });
      return;
    }

    if (normalizedBrand.length > 100 || brandMemo.trim().length > 1_000) {
      setBrandNotice({
        kind: "error",
        message: {
          ko: "브랜드명은 100자, 운영 메모는 1,000자까지 입력해 주세요.",
          en: "Keep the brand name to 100 characters and the note to 1,000.",
        },
      });
      return;
    }

    if (
      [...localBrands, ...localProducts.map((product) => product.brand)].some(
        (brand) => brand.trim().toLowerCase() === normalizedBrand.toLowerCase(),
      )
    ) {
      setBrandNotice({
        kind: "error",
        message: {
          ko: "이미 이 화면의 목록에 있는 브랜드명입니다. 목록에서 확인해 주세요.",
          en: "This brand name is already in the list on this screen. Check the list.",
        },
      });
      return;
    }

    const draft: AdminBrandDraft = {
      name: normalizedBrand,
      ...(brandMemo.trim() ? { memo: brandMemo.trim() } : {}),
    };

    const saveToServer = actions?.saveBrandDraft;
    brandBusyRef.current = true;
    try {
      setIsSavingBrand(true);
      if (saveToServer) await saveToServer(draft);
      setLocalBrands((current) => [...current, normalizedBrand]);
      recordActivity({
        key: "brands",
        section: "brands",
        status: saveToServer ? "complete" : "draft",
        detail: saveToServer
          ? {
              ko: "서버가 브랜드 등록을 확인했습니다.",
              en: "The server confirmed the brand registration.",
            }
          : {
              ko: "브랜드를 이 화면에만 추가했습니다. 서버 미저장",
              en: "Added the brand on this screen only. Not saved to the server",
            },
      });
      setBrandNotice({
        kind: "success",
        message: saveToServer
          ? {
              ko: `“${normalizedBrand}” 브랜드를 서버에 등록했습니다.`,
              en: `Registered the brand “${normalizedBrand}” on the server.`,
            }
          : {
              ko: `“${normalizedBrand}” 브랜드명을 이 화면에만 임시 추가했습니다. 서버에는 저장되지 않습니다.`,
              en: `Temporarily added the brand “${normalizedBrand}” on this screen only. It is not saved to the server.`,
            },
      });
      setBrandName("");
      setBrandMemo("");
    } catch {
      recordActivity({
        key: "brands",
        section: "brands",
        status: "attention",
        detail: {
          ko: "브랜드 등록 결과를 확인해야 합니다. 입력은 유지됩니다.",
          en: "Check the brand registration result. Your input is kept.",
        },
      });
      setBrandNotice({
        kind: "error",
        message: {
          ko: "브랜드 등록 결과를 확인하지 못했습니다. 입력은 유지했습니다. 중복 등록하지 않도록 관리자 권한·연결과 서버의 처리 결과를 확인해 주세요.",
          en: "Could not confirm the brand registration. Your input is kept. To avoid a duplicate, check admin access, the connection and the server result.",
        },
      });
    } finally {
      brandBusyRef.current = false;
      setIsSavingBrand(false);
    }
  };
  return { handleBrandSubmit } as const;
}
