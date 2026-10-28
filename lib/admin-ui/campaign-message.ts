/**
 * 캠페인 본문 template입니다. 발송 기능은 연결하지 않으며 문구와 첨부 구성만 만듭니다.
 * 이메일 로고는 원격 URL이 아니라 본문 삽입(인라인 이미지, Content-ID)으로 항상 맨 위에 둡니다.
 */
import type { Locale } from "@/types/store";

export type CampaignChannel = "email" | "sms" | "push";

/** 홈 헤더와 같은 승인 로고 파일입니다. 새 로고를 만들지 않습니다. */
export const CAMPAIGN_LOGO = {
  path: "/brand/paradays-logo.jpg",
  fileName: "paradays-logo.jpg",
  contentType: "image/jpeg",
  contentId: "paradays-logo@paradays.web.app",
  alt: "PARADAYS",
  width: 220,
  height: 34,
} as const;

export type CampaignInlineImage = Readonly<{
  contentId: string;
  path: string;
  fileName: string;
  contentType: string;
  disposition: "inline";
}>;

export type CampaignEmail = Readonly<{
  subject: string;
  html: string;
  text: string;
  inlineImages: readonly CampaignInlineImage[];
}>;

export type CampaignChannelSupport = Readonly<{
  channel: CampaignChannel;
  /** 본문 상단 로고를 이 채널의 본문에 직접 넣을 수 있는지입니다. */
  inlineLogo: boolean;
  /** 실제 발송 연결 여부입니다. 현재 모든 채널이 미연결입니다. */
  sendingConnected: false;
  label: string;
  detail: string;
}>;

type LocalizedSupport = Omit<CampaignChannelSupport, "label" | "detail"> &
  Readonly<{ label: Record<Locale, string>; detail: Record<Locale, string> }>;

const SUPPORT: Readonly<Record<CampaignChannel, LocalizedSupport>> = {
  email: {
    channel: "email",
    inlineLogo: true,
    sendingConnected: false,
    label: {
      ko: "로고 본문 삽입 · 발송 미연결",
      en: "Logo in body · Sending not connected",
    },
    detail: {
      ko: "PARADAYS 로고를 본문 맨 위에 인라인 이미지로 넣습니다. 실제 이메일 발송은 연결되지 않았습니다.",
      en: "Places the PARADAYS logo as an inline image at the top of the body. Actual email sending is not connected.",
    },
  },
  sms: {
    channel: "sms",
    inlineLogo: false,
    sendingConnected: false,
    label: {
      ko: "이미지 불가 · 발송 미연결",
      en: "No images · Sending not connected",
    },
    detail: {
      ko: "일반 SMS는 본문에 이미지를 넣을 수 없습니다. 로고를 보내려면 MMS 등 이미지 지원 채널 연결이 필요합니다.",
      en: "Plain SMS cannot include images in the body. Sending the logo needs an image-capable channel such as MMS.",
    },
  },
  push: {
    channel: "push",
    inlineLogo: false,
    sendingConnected: false,
    label: {
      ko: "이미지 미연결 · 발송 미연결",
      en: "Images not connected · Sending not connected",
    },
    detail: {
      ko: "푸시 알림 이미지는 기기·발송 서비스 연결이 필요합니다. 현재는 문구만 미리 봅니다.",
      en: "Push notification images need a device and sending service connection. For now only the text is previewed.",
    },
  },
};

export function campaignChannelSupport(
  channel: CampaignChannel,
  locale: Locale = "ko",
): CampaignChannelSupport {
  const support = SUPPORT[channel];
  return { ...support, label: support.label[locale], detail: support.detail[locale] };
}

const escapeHtml = (value: string) =>
  value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");

/** 제목 줄바꿈은 메일 header를 깨뜨리므로 공백 하나로 합칩니다. */
const singleLine = (value: string) => value.replace(/[\r\n\t]+/g, " ").trim();

export function buildCampaignEmail(
  input: Readonly<{ title: string; body: string }>,
): CampaignEmail {
  const subject = singleLine(input.title);
  const body = input.body.replace(/\r\n?/g, "\n").trim();
  if (!subject || !body) throw new Error("캠페인 제목과 메시지를 입력해 주세요.");
  const paragraphs = body
    .split(/\n{2,}/)
    .map(
      (p) => `<p style="margin:0 0 16px">${escapeHtml(p).replace(/\n/g, "<br>")}</p>`,
    )
    .join("");
  const logo = CAMPAIGN_LOGO;
  const html = [
    "<!doctype html>",
    '<html lang="ko"><head><meta charset="utf-8">',
    `<title>${escapeHtml(subject)}</title></head>`,
    '<body style="margin:0;padding:0;background:#ffffff">',
    '<div style="max-width:600px;margin:0 auto;padding:24px;font-family:sans-serif;color:#111111;line-height:1.6">',
    `<img src="cid:${logo.contentId}" alt="${logo.alt}" width="${logo.width}" height="${logo.height}" style="display:block;margin:0 auto 24px;border:0">`,
    `<h1 style="margin:0 0 16px;font-size:22px">${escapeHtml(subject)}</h1>`,
    paragraphs,
    "</div></body></html>",
  ].join("");
  return {
    subject,
    html,
    text: `${logo.alt}\n\n${subject}\n\n${body}`,
    inlineImages: [
      {
        contentId: logo.contentId,
        path: logo.path,
        fileName: logo.fileName,
        contentType: logo.contentType,
        disposition: "inline",
      },
    ],
  };
}
