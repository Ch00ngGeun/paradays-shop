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
