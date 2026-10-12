// 역할: 가입 화면에 보여줄 약관 전문 초안 (버전은 consent.ts와 맞춤).

import { LEGAL_TERM_VERSIONS } from "@/lib/auth/consent";
import type { Locale } from "@/types/store";

export type LegalDocumentId =
  | "termsOfService"
  | "privacyPolicy"
  | "marketing"
  | "ageGate";

type LegalDocument = Readonly<{
  id: LegalDocumentId;
  version: string;
  title: Record<Locale, string>;
  body: Record<Locale, string>;
}>;

export const legalDocuments: LegalDocument[] = [
  {
    id: "termsOfService",
    version: LEGAL_TERM_VERSIONS.termsOfService,
    title: { en: "Terms of Service", ko: "서비스 이용약관" },
    body: {
      en: "These Terms of Service govern use of the PARADAYS storefront. By creating an account you agree to follow store policies, payment rules, and acceptable use. PARADAYS may update these terms; continued use after notice means acceptance of the new version.",
      ko: "본 이용약관은 PARADAYS 스토어프론트 이용에 적용됨. 계정을 만들면 스토어 정책·결제 규칙·이용 제한에 동의하는 것으로 봄. 약관이 갱신될 수 있으며, 고지 후 계속 이용하면 새 버전에 동의한 것으로 봄.",
    },
  },
  {
    id: "privacyPolicy",
    version: LEGAL_TERM_VERSIONS.privacyPolicy,
    title: { en: "Privacy Policy", ko: "개인정보 수집 및 이용" },
    body: {
      en: "We collect account identifiers (email), profile fields you provide, and order data needed to fulfill purchases. Data is processed under AWS Cognito and commerce APIs. You may request access or deletion subject to legal retention.",
      ko: "이메일 등 계정 식별자, 제공한 프로필, 주문 이행에 필요한 정보를 수집함. AWS Cognito·커머스 API로 처리하며, 법령상 보관 의무를 제외하고 열람·삭제 요청이 가능함.",
    },
  },
  {
    id: "marketing",
    version: LEGAL_TERM_VERSIONS.marketing,
    title: { en: "Marketing Communications", ko: "마케팅 정보 수신" },
    body: {
      en: "Optional marketing may be sent by email, SMS, or push. You can withdraw consent anytime in Account settings.",
      ko: "선택 동의한 경우 이메일·SMS·푸시로 마케팅 정보를 받을 수 있음. 계정 설정에서 언제든 철회 가능함.",
    },
  },
  {
    id: "ageGate",
    version: LEGAL_TERM_VERSIONS.ageGate,
    title: { en: "Age Confirmation", ko: "만 14세 이상 확인" },
    body: {
      en: "You confirm that you are at least 14 years old, as required for account creation under applicable Korean youth protection rules.",
      ko: "계정 생성에 필요한 청소년 보호 관련 기준에 따라 만 14세 이상임을 확인함.",
    },
  },
];

export function getLegalDocument(id: LegalDocumentId) {
  return legalDocuments.find((document) => document.id === id) ?? null;
}
