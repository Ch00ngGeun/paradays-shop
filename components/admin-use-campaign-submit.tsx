// 역할: 캠페인 초안 제출 훅. 제목·메시지·채널을 검증하고, 서버 저장 action이 있으면 초안을 서버에 저장하고 없으면 이 화면에만 준비한 뒤 알림·운영 기록을 남깁니다(고객 발송 없음).
"use client";
import type { AdminCampaignDraft, AdminDashboardActions } from "@/lib/admin-ui/types";
import type { Locale } from "@/types/store";
import { type FormEvent, type RefObject } from "react";
import {
  campaignDraftValidation,
  MarketingChannel,
  Notice,
  OperationActivity,
} from "./admin-shared";

export function useAdminCampaignSubmit({
  campaignBusyRef,
  campaignTitle,
  campaignBody,
  selectedChannels,
  setCampaignNotice,
  campaignChannels,
  actions,
  setIsSavingCampaign,
  recordActivity,
  selectedChannelNames,
}: Readonly<{
  campaignBusyRef: RefObject<boolean>;
  campaignTitle: string;
  campaignBody: string;
  selectedChannels: MarketingChannel[];
  setCampaignNotice: React.Dispatch<React.SetStateAction<Notice>>;
  campaignChannels: Record<MarketingChannel, boolean>;
  actions: AdminDashboardActions | undefined;
  setIsSavingCampaign: React.Dispatch<React.SetStateAction<boolean>>;
  recordActivity: (activity: Omit<OperationActivity, "at">) => void;
  selectedChannelNames: (target: Locale) => string;
}>) {
  const handleCampaignSubmit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (campaignBusyRef.current) return;
    const validationMessage = campaignDraftValidation(
      campaignTitle,
      campaignBody,
      selectedChannels.length,
    );
    if (validationMessage) {
      setCampaignNotice({
        kind: "error",
        message: validationMessage,
      });
      return;
    }

    const draft: AdminCampaignDraft = {
      title: campaignTitle.trim(),
      body: campaignBody.trim(),
      channels: (Object.entries(campaignChannels) as Array<[MarketingChannel, boolean]>)
        .filter(([, selected]) => selected)
        .map(([channel]) =>
          channel === "email" ? "EMAIL" : channel === "sms" ? "SMS" : "PUSH",
        ),
    };

    const saveToServer = actions?.saveCampaignDraft;
    campaignBusyRef.current = true;
    try {
      setIsSavingCampaign(true);
      setCampaignNotice(null);
      if (saveToServer) await saveToServer(draft);
      recordActivity({
        key: "marketing",
        section: "marketing",
        status: "draft",
        detail: saveToServer
          ? {
              ko: "캠페인 초안을 서버에 저장했습니다. 고객 미발송",
              en: "Saved the campaign draft to the server. Not sent to customers",
            }
          : {
              ko: "캠페인 초안을 이 화면에만 준비했습니다. 서버 미저장 · 고객 미발송",
              en: "Prepared the campaign draft on this screen only. Not saved to the server · Not sent to customers",
            },
      });
      setCampaignNotice({
        kind: "success",
        message: saveToServer
          ? {
              ko: `${selectedChannelNames("ko")} 캠페인 초안을 서버에 저장했습니다. 고객에게 발송하지 않았습니다.`,
              en: `Saved the ${selectedChannelNames("en")} campaign draft to the server. It was not sent to customers.`,
            }
          : {
              ko: `${selectedChannelNames("ko")} 캠페인 초안을 이 화면에만 준비했습니다. 서버 저장·고객 발송은 하지 않았습니다.`,
              en: `Prepared the ${selectedChannelNames("en")} campaign draft on this screen only. It was not saved to the server or sent to customers.`,
            },
      });
    } catch {
      recordActivity({
        key: "marketing",
        section: "marketing",
        status: "attention",
        detail: {
          ko: "캠페인 초안 저장 결과를 확인해야 합니다. 고객 발송 완료가 아닙니다.",
          en: "Check the campaign draft save result. It has not been sent to customers.",
        },
      });
      setCampaignNotice({
        kind: "error",
        message: {
          ko: "캠페인 초안 저장 결과를 확인하지 못했습니다. 입력은 유지했습니다. 중복 저장하지 않도록 서버 처리 결과와 연결을 확인해 주세요.",
          en: "Could not confirm the campaign draft save. Your input is kept. To avoid a duplicate, check the server result and the connection.",
        },
      });
    } finally {
      campaignBusyRef.current = false;
      setIsSavingCampaign(false);
    }
  };
  return { handleCampaignSubmit } as const;
}
