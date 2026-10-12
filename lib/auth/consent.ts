// 역할: 가입 시 약관 동의 이력을 브라우저에 임시 기록함 (Cognito 콜백 후 프로필 API 연동용).

export const LEGAL_TERM_VERSIONS = {
  termsOfService: "2026-09-20",
  privacyPolicy: "2026-09-20",
  marketing: "2026-09-20",
  ageGate: "2026-09-20",
} as const;

export type ConsentReceipt = Readonly<{
  acceptedAt: string;
  versions: typeof LEGAL_TERM_VERSIONS;
  required: Readonly<{
    termsOfService: true;
    privacyPolicy: true;
    ageGate: true;
  }>;
  optional: Readonly<{
    marketingEmail: boolean;
    marketingSms: boolean;
    marketingPush: boolean;
  }>;
}>;

const CONSENT_STORAGE_KEY = "paradays-signup-consent";

/** 가입 직전 동의 영수증을 sessionStorage에 저장함 */
export function saveConsentReceipt(
  optional: ConsentReceipt["optional"],
): ConsentReceipt {
  const receipt: ConsentReceipt = {
    acceptedAt: new Date().toISOString(),
    versions: LEGAL_TERM_VERSIONS,
    required: {
      termsOfService: true,
      privacyPolicy: true,
      ageGate: true,
    },
    optional,
  };

  try {
    window.sessionStorage.setItem(CONSENT_STORAGE_KEY, JSON.stringify(receipt));
  } catch {
    // 스토리지 불가면 메모리만으로도 Cognito 이동은 계속함
  }

  return receipt;
}

export function readConsentReceipt(): ConsentReceipt | null {
  try {
    const raw = window.sessionStorage.getItem(CONSENT_STORAGE_KEY);
    if (!raw) {
      return null;
    }

    return JSON.parse(raw) as ConsentReceipt;
  } catch {
    return null;
  }
}
