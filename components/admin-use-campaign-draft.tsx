// 역할: 관리자 마케팅 메뉴의 캠페인 제목·메시지·채널 선택·알림·저장 중 상태와 중복 저장 방지 ref를 묶은 상태 훅입니다.
"use client";
import { useRef, useState } from "react";
import { MarketingChannel, Notice } from "./admin-shared";

export function useAdminCampaignDraft() {
  const [campaignTitle, setCampaignTitle] = useState("");
  const [campaignBody, setCampaignBody] = useState("");
  const [campaignChannels, setCampaignChannels] = useState<
    Record<MarketingChannel, boolean>
  >({ email: true, sms: false, push: false });
  const [campaignNotice, setCampaignNotice] = useState<Notice>(null);
  const [isSavingCampaign, setIsSavingCampaign] = useState(false);
  const campaignBusyRef = useRef(false);
  return {
    campaignTitle,
    setCampaignTitle,
    campaignBody,
    setCampaignBody,
    campaignChannels,
    setCampaignChannels,
    campaignNotice,
    setCampaignNotice,
    isSavingCampaign,
    setIsSavingCampaign,
    campaignBusyRef,
  } as const;
}
