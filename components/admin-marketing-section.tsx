// 역할: 관리자 마케팅 메뉴 화면. 캠페인 제목·메시지·채널(이메일·SMS·푸시) 초안을 작성·저장하고 채널별 미리보기를 보여 줍니다(고객 발송은 미연결).
"use client";
import adminMarketingSectionStyles from "./admin-marketing-section.module.css";
import { useLocale } from "@/contexts/locale-context";
import { adminGuideSteps } from "@/lib/admin-ui/admin-guides";
import { CAMPAIGN_LOGO, campaignChannelSupport } from "@/lib/admin-ui/campaign-message";
import Image from "next/image";
import { useState, type FormEvent } from "react";
import styles from "./admin-dashboard.module.css";
import { AdminGuideButton } from "./admin-guide";
import { AdminHelpButton } from "./admin-help-button";
import { GrowingLineInput } from "./admin-product-name-input";
import requiredStyles from "./admin-required.module.css";
import {
  campaignDraftValidation,
  channelLabel,
  localizedText,
  MarketingChannel,
  Notice,
  NoticeMessage,
} from "./admin-shared";
import { AdminStepper } from "./admin-stepper";

export function MarketingSection({
  body,
  canSaveToServer,
  channels,
  notice,
  onBodyChange,
  onChannelChange,
  onSubmit,
  onTitleChange,
  title,
  saving,
}: Readonly<{
  body: string;
  canSaveToServer: boolean;
  channels: Record<MarketingChannel, boolean>;
  notice: Notice;
  onBodyChange: (value: string) => void;
  onChannelChange: (channel: MarketingChannel, selected: boolean) => void;
  onSubmit: (event: FormEvent<HTMLFormElement>) => void;
  onTitleChange: (value: string) => void;
  title: string;
  saving: boolean;
}>) {
  const { locale } = useLocale();
  const isKorean = locale === "ko";
  const [previewChannel, setPreviewChannel] = useState<MarketingChannel>("email");
  const selected = (["email", "sms", "push"] as const).filter(
    (channel) => channels[channel],
  );
  const activePreview = channels[previewChannel] ? previewChannel : selected[0];
  const validationMessage = campaignDraftValidation(title, body, selected.length);
  const hasInput = Boolean(title || body);
  const saved = notice?.kind === "success";
  return (
    <div className={`${styles.sectionStack} ${styles.campaignScreen}`}>
      <header className={adminMarketingSectionStyles.campaignHeader}>
        <div>
          <p>
            {isKorean
              ? "고객 / 마케팅 / 새 캠페인"
              : "Customers / Marketing / New campaign"}
          </p>
          <div>
            <h2>{isKorean ? "캠페인 만들기" : "Create campaign"}</h2>
            <span>
              {saved
                ? canSaveToServer
                  ? isKorean
                    ? "초안 저장 · 발송 없음"
                    : "Draft saved · Not sent"
                  : isKorean
                    ? "로컬 초안 · 발송 없음"
                    : "Local draft · Not sent"
                : isKorean
                  ? "미리보기 · 발송 없음"
                  : "Preview · Not sent"}
            </span>
          </div>
        </div>
        <AdminGuideButton
          locale={locale}
          steps={adminGuideSteps("marketing", locale)}
        />
      </header>
      {/* 안전 안내라서 도움말 안이 아니라 화면에 계속 보여 줍니다. */}
      <p className={adminMarketingSectionStyles.campaignSaveNote}>
        {isKorean
          ? "이 화면은 제목·메시지·채널을 초안으로만 저장합니다. 수신자 조회·예약·발송·이미지 첨부는 지원하지 않습니다."
          : "This screen saves the title, message and channels as a draft only. Recipient lookup, scheduling, sending and image attachments are not supported."}
      </p>
      <AdminStepper
        label={isKorean ? "캠페인 작업 흐름" : "Campaign workflow"}
        locale={locale}
        steps={[
          {
            label: isKorean ? "채널 선택" : "Choose channels",
            state: selected.length ? "complete" : "current",
          },
          {
            label: isKorean ? "문구 작성" : "Write text",
            state: !selected.length
              ? "upcoming"
              : validationMessage
                ? "current"
                : "complete",
          },
          {
            label: isKorean ? "초안 저장" : "Save draft",
            state: saved ? "complete" : validationMessage ? "upcoming" : "current",
          },
          { label: isKorean ? "고객 발송" : "Send to customers", state: "unavailable" },
        ]}
      />
      <div className={adminMarketingSectionStyles.campaignWorkspace}>
        <form
          aria-label={isKorean ? "캠페인 초안 작성" : "Campaign draft"}
          className={adminMarketingSectionStyles.campaignForm}
          noValidate
          onSubmit={onSubmit}
        >
          <fieldset className={styles.campaignFields} disabled={saving}>
            <fieldset
              className={styles.campaignChannels}
              data-admin-guide="marketing.channels"
            >
              <legend>
                {isKorean ? "초안 채널 선택 (복수 선택)" : "Draft channels (multiple)"}
              </legend>
              <div className={adminMarketingSectionStyles.campaignChannelCards}>
                {(["email", "sms", "push"] as const).map((channel) => (
                  <label data-selected={channels[channel]} key={channel}>
                    <span
                      className={adminMarketingSectionStyles.campaignChannelIcon}
                      aria-hidden="true"
                    >
                      <CampaignChannelIcon channel={channel} />
                    </span>
                    <input
                      aria-label={
                        isKorean
                          ? `${channelLabel(channel, locale)} 초안 선택`
                          : `Include ${channelLabel(channel, locale)} in draft`
                      }
                      checked={channels[channel]}
                      onChange={(event) =>
                        onChannelChange(channel, event.target.checked)
                      }
                      type="checkbox"
                    />
                    <strong>{channelLabel(channel, locale)}</strong>
                    <span className={adminMarketingSectionStyles.campaignChannelState}>
                      {channels[channel]
                        ? isKorean
                          ? "초안 포함"
                          : "In draft"
                        : isKorean
                          ? "초안 제외"
                          : "Not in draft"}
                    </span>
                    <small
                      className={adminMarketingSectionStyles.campaignChannelSupport}
                      data-inline-logo={campaignChannelSupport(channel).inlineLogo}
                    >
                      {campaignChannelSupport(channel, locale).label}
                    </small>
                  </label>
                ))}
              </div>
            </fieldset>
            <div className={adminMarketingSectionStyles.campaignScopeNote}>
              <AdminHelpButton
                locale={locale}
                target={isKorean ? "채널 선택" : "Channel selection"}
              >
                <p>
                  {isKorean
                    ? "초안 작성용 선택 · 채널 연결·수신자 수·발송 가능 여부는 미조회입니다."
                    : "Selection for the draft only · Channel connection, recipient count and send availability are not checked."}
                </p>
                <p>
                  {isKorean
                    ? "채널 선택은 초안에 담을 문구의 종류입니다. 실제 채널 연결 상태나 발송 가능 여부를 확인하는 표시가 아닙니다. 수신 동의와 발송 정책은 별도 서버 검증이 필요합니다."
                    : "Channel selection sets which text the draft holds. It does not show whether a channel is connected or can send. Consent and sending policy need separate server checks."}
                </p>
              </AdminHelpButton>
            </div>
            <label>
              <span>
                {isKorean ? "캠페인 제목 (필수)" : "Campaign title (required)"}
                <span aria-hidden="true" className={requiredStyles.requiredMark}>
                  *
                </span>
              </span>
              <GrowingLineInput
                data-admin-guide="marketing.title"
                maxLength={160}
                required
                onValueChange={onTitleChange}
                placeholder={
                  isKorean
                    ? "이번 주 신상품을 확인하세요"
                    : "Check out this week's new arrivals"
                }
                value={title}
              />
              <small>
                {title.length}/160{isKorean ? "자" : " characters"}
              </small>
            </label>
            <label>
              <span>
                {isKorean ? "메시지 (필수)" : "Message (required)"}
                <span aria-hidden="true" className={requiredStyles.requiredMark}>
                  *
                </span>
              </span>
              <textarea
                data-admin-guide="marketing.body"
                maxLength={8_000}
                onChange={(event) => onBodyChange(event.target.value)}
                placeholder={
                  isKorean
                    ? "고객에게 전달할 혜택과 링크 안내를 작성하세요."
                    : "Write the benefit and link details for customers."
                }
                rows={8}
                required
                value={body}
              />
              <small>
                {isKorean
                  ? `${body.length.toLocaleString("ko-KR")}/8,000자 · 초안 API 저장 한도이며 SMS 전송 길이·분할 기준이 아닙니다.`
                  : `${body.length.toLocaleString("en-US")}/8,000 characters · The draft API save limit, not an SMS length or split rule.`}
              </small>
            </label>
            <div className={adminMarketingSectionStyles.campaignConsentNote}>
              <strong>
                {isKorean
                  ? "수신 대상 미조회 · 발송 없음"
                  : "Recipients not loaded · Not sent"}
              </strong>
              <p>
                {isKorean
                  ? "수신 동의가 검증된 대상자 수나 실제 발송 목록은 이 화면에서 확인하지 않습니다."
                  : "This screen does not check the number of verified opted-in recipients or the actual send list."}
              </p>
            </div>
            {hasInput && validationMessage ? (
              <p className={adminMarketingSectionStyles.campaignValidation}>
                {localizedText(validationMessage, locale)}
              </p>
            ) : null}
            <p className={adminMarketingSectionStyles.campaignSaveNote}>
              {canSaveToServer
                ? isKorean
                  ? "서버에 초안만 저장하며 고객에게 메시지를 보내지 않습니다."
                  : "Saves only a draft to the server and sends nothing to customers."
                : isKorean
                  ? "서버 미연결 · 초안을 이 화면에만 준비하고 발송하지 않습니다."
                  : "No server · The draft is prepared on this screen only and not sent."}
            </p>
            <button
              className={styles.primaryButton}
              data-admin-guide="marketing.save"
              disabled={Boolean(validationMessage)}
              type="submit"
            >
              {saving
                ? isKorean
                  ? "저장 중…"
                  : "Saving…"
                : canSaveToServer
                  ? isKorean
                    ? "캠페인 초안 저장"
                    : "Save campaign draft"
                  : isKorean
                    ? "이 화면에 초안 준비"
                    : "Prepare draft here"}
            </button>
          </fieldset>
          {notice ? <NoticeMessage notice={notice} /> : null}
        </form>
        <aside
          className={adminMarketingSectionStyles.campaignPreview}
          data-admin-guide="marketing.preview"
          aria-label={
            isKorean ? "선택 채널 문구 미리보기" : "Selected channel text preview"
          }
        >
          <h3>
            {activePreview
              ? isKorean
                ? `${channelLabel(activePreview, locale)} 미리보기`
                : `${channelLabel(activePreview, locale)} preview`
              : isKorean
                ? "채널 문구 미리보기"
                : "Channel text preview"}
          </h3>
          <div
            className={adminMarketingSectionStyles.campaignPreviewChoices}
            role="group"
            aria-label={isKorean ? "미리보기 채널" : "Preview channel"}
          >
            {selected.map((channel) => (
              <button
                aria-pressed={activePreview === channel}
                key={channel}
                onClick={() => setPreviewChannel(channel)}
                type="button"
              >
                {channelLabel(channel, locale)} {isKorean ? "미리보기" : "preview"}
              </button>
            ))}
          </div>
          {activePreview ? (
            <div
              className={adminMarketingSectionStyles.campaignMessage}
              data-channel={activePreview}
            >
              {campaignChannelSupport(activePreview).inlineLogo ? (
                <div
                  className={adminMarketingSectionStyles.campaignMessageBrand}
                  data-inline-logo="true"
                >
                  <Image
                    alt={CAMPAIGN_LOGO.alt}
                    className={adminMarketingSectionStyles.campaignLogo}
                    height={CAMPAIGN_LOGO.height}
                    src={CAMPAIGN_LOGO.path}
                    width={CAMPAIGN_LOGO.width}
                  />
                  <span>
                    {isKorean
                      ? "본문 삽입(인라인 이미지) · 항상 맨 위 · 초안 문구 예시"
                      : "Inline image in body · Always on top · Draft text example"}
                  </span>
                </div>
              ) : (
                <div
                  className={adminMarketingSectionStyles.campaignMessageBrand}
                  data-inline-logo="false"
                >
                  PARADAYS{" "}
                  <span>
                    {isKorean
                      ? "초안 문구 예시 · 로고 이미지 미포함"
                      : "Draft text example · No logo image"}
                  </span>
                </div>
              )}
              <div className={adminMarketingSectionStyles.campaignMessageBody}>
                <strong>
                  {title.trim() || (isKorean ? "캠페인 제목" : "Campaign title")}
                </strong>
                <p>
                  {body.trim() ||
                    (isKorean
                      ? "메시지를 입력하면 선택 채널의 초안 문구가 표시됩니다."
                      : "Enter a message to see the draft text for the selected channel.")}
                </p>
              </div>
              <small>
                {campaignChannelSupport(activePreview, locale).detail}{" "}
                {activePreview === "sms"
                  ? isKorean
                    ? "문자 분할·발송 비용·인코딩은 계산하지 않습니다."
                    : "Message splitting, sending cost and encoding are not calculated."
                  : activePreview === "push"
                    ? isKorean
                      ? "실제 기기 알림의 길이·모양과 다를 수 있습니다."
                      : "May differ from the length and look of an actual device notification."
                    : isKorean
                      ? "실제 이메일 HTML·수신거부 기능이 포함된 발송물이 아닙니다."
                      : "Not an actual email with HTML and unsubscribe features."}
              </small>
            </div>
          ) : (
            <p className={adminMarketingSectionStyles.campaignEmptyPreview}>
              {isKorean
                ? "초안에 포함할 채널을 하나 이상 선택해 주세요."
                : "Select at least one channel to include in the draft."}
            </p>
          )}
          <p className={adminMarketingSectionStyles.campaignPreviewNote}>
            {isKorean
              ? "이 미리보기는 실제 전송물이 아닙니다. 초안을 저장해도 고객에게 메시지가 발송되지 않습니다."
              : "This preview is not an actual message. Saving the draft does not send anything to customers."}
          </p>
        </aside>
      </div>
    </div>
  );
}

export function CampaignChannelIcon({
  channel,
}: Readonly<{ channel: MarketingChannel }>) {
  return (
    <svg
      aria-hidden="true"
      fill="none"
      height="28"
      stroke="currentColor"
      strokeLinecap="round"
      strokeLinejoin="round"
      strokeWidth="1.6"
      viewBox="0 0 24 24"
      width="28"
    >
      {channel === "email" ? (
        <>
          <rect height="14" rx="2" width="20" x="2" y="5" />
          <path d="m3 6 9 7 9-7" />
        </>
      ) : channel === "sms" ? (
        <path d="M21 11a9 8 0 0 1-9 8H5l-3 3V11a9 8 0 0 1 18 0Z" />
      ) : (
        <>
          <path d="M5 17h14l-2-3V9a5 5 0 0 0-10 0v5l-2 3ZM10 21h4M12 2v2" />
        </>
      )}
    </svg>
  );
}
