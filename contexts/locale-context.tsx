// 역할: 활성 인터페이스 언어를 저장하고 새로고침 이후에도 사용자 설정을 유지합니다.
"use client";

import {
  createContext,
  useContext,
  useEffect,
  useMemo,
  useState,
  type ReactNode,
} from "react";

import type { Locale } from "@/types/store";

/** localStorage에 선택한 언어를 저장할 때 쓰는 키 */
const LOCALE_STORAGE_KEY = "paradays-locale";

// 카탈로그 원문을 키로 사용해 상품명은 유지하면서 상세 사양만 로케일에 맞게 표시합니다.
const productDescriptionTranslations: Record<Locale, Record<string, string>> = {
  en: {},
  ko: {
    // Deck
    "7-Ply Canadian Maple": "캐나다산 7겹 메이플",
    "Medium Concave": "미디엄 컨케이브",
    "8.25 inch Width": "8.25인치 너비",
    "8.375 inch Width": "8.375인치 너비",
    "8.5 inch Width": "8.5인치 너비",
    "Brian O'Dwyer Pro Model": "Brian O'Dwyer 프로 모델",
    // Top — Plaid Overshirt
    "Heavy Flannel Weave": "헤비 플란넬 조직",
    "Dual Chest Pockets": "더블 체스트 포켓",
    "Button Front Closure": "버튼 프론트 여밈",
    "Relaxed Boxy Fit": "릴랙스드 박시 핏",
    // Top — Triangle Sweater
    "All-Over Triangle Knit": "올오버 트라이앵글 니트",
    "Ribbed Collar, Cuffs & Hem": "골지 카라·커프스·밑단",
    "Crewneck Fit": "크루넥 핏",
    "100% Cotton": "면 100%",
    // Accessories — Hat
    "6-Panel Crown": "6패널 크라운",
    "Embroidered Front Mark": "전면 자수 마크",
    "Adjustable Back Strap": "길이 조절 백 스트랩",
    "One Size": "원사이즈",
    // Wheels
    "56mm Diameter": "56mm 직경",
    "82A Durometer": "82A 경도",
    "Conical Shape": "코니컬 쉐입",
    "Set of 4": "4개 세트",
  },
};

/** UI 문구 사전 (헤더·장바구니·검색·상세 공통). */
const translations = {
  en: {
    home: "Home",
    menu: "Menu",
    cart: "Cart",
    search: "Search",
    account: "Account",
    myPage: "My Page",
    adminPage: "Admin Page",
    close: "Close",
    browse: "Browse by category",
    addToCart: "Add to cart",
    addedToCart: "Added to cart",
    searchTitle: "Search PARADAYS",
    searchPlaceholder: "Search...",
    searchHint: "Search stays on this page.",
    searchResults: "Matches",
    noResults: "No matching products yet.",
    yourCart: "Your Cart",
    continueShopping: "Continue shopping",
    wasAddedToCart: "was added to your cart",
    checkoutLink: "Checkout",
    emptyCart: "Your cart is empty.",
    remove: "Remove",
    quantity: "Quantity",
    productQuantity: "Qty:",
    productSize: "Size",
    subtotal: "Subtotal",
    freeShipping: "• • Free shipping over ₩150,000 • •",
    updateCart: "UPDATE CART",
    sellerInstructions: "Special instructions for the seller:",
    agreeToTerms: "I agree to the terms and refund policy",
    checkout: "CHECK OUT",
    checkoutPreparing: "Preparing payment...",
    checkoutSetupRequired: "Payment setup is not available yet.",
    checkoutSignInRequired: "Sign in is required before checkout.",
    checkoutRequestFailed: "Could not start the payment. Please try again.",
    paymentConfirming: "Confirming payment...",
    paymentComplete: "Payment completed.",
    paymentPending: "Payment is waiting for final confirmation.",
    paymentFailed: "Payment was not completed.",
    accountTitle: "Account",
    accountLoading: "Loading account...",
    authComplete: "Signed in. Continue to your account.",
    authCompleteAdmin: "Signed in. Continue to admin.",
    accountUnavailable: "Account service is not configured yet.",
    signIn: "Sign in",
    signUp: "Sign up",
    signOut: "Sign out",
    displayName: "Display name",
    phoneNumber: "Phone number",
    marketingConsent: "I agree to receive marketing messages",
    saveChanges: "Save changes",
    editProfile: "Edit",
    cancelEdit: "Cancel",
    profileSaved: "Profile saved.",
    profileUpdatedModal: "Your changes have been saved.",
    orders: "Orders",
    noOrders: "No orders yet.",
    accountRequestFailed: "Could not load or save account information.",
    accountProfileLoadFailed:
      "Could not load profile from the server. You can still edit with local account info.",
    accountOrdersLoadFailed: "Could not load order history.",
    themeToDark: "Switch to dark mode",
    themeToLight: "Switch to light mode",
    previousImage: "Previous image",
    sizeChart: "Size chart",
    nextImage: "Next image",
    loginTitle: "Login",
    signUpTitle: "Sign",
    loginLead: "Sign in with ID/password or a social account.",
    signUpLead: "Create an account. Required fields only.",
    loginSubmit: "Sign in",
    signUpSubmit: "Sign up",
    authEmail: "Email",
    authLoginId: "ID",
    authLoginIdPlaceholder: "ID (omit @gmail.com)",
    authLoginIdInvalid: "Enter a valid ID or email.",
    authPassword: "Password",
    authConfirmPassword: "Confirm password",
    authPhone: "Phone number",
    authPhoneInvalid: "Enter a valid mobile number.",
    authEmailInvalid: "Enter a valid email address.",
    authPasswordRequired: "Enter your password.",
    authPasswordInvalid: "Password does not meet the policy.",
    authPasswordMismatch: "Passwords do not match.",
    authPasswordPolicy: "Password requirements",
    authPasswordRule_length: "Password must contain at least 12 characters",
    authPasswordRule_lowercase: "Password must contain a lower case letter",
    authPasswordRule_uppercase: "Password must contain an upper case letter",
    authPasswordRule_number: "Password must contain a number",
    authPasswordRule_special: "Password must contain a special character or a space",
    authPasswordRule_noEdgeSpace:
      "Password must not contain a leading or trailing space",
    authIdentityMethod: "Identity verification",
    authIdentityEmail: "Email verification",
    authIdentitySms: "SMS verification",
    authIdentitySmsUnavailable:
      "SMS verification is not available right now. Please use email verification.",
    authIdentityRequired: "Complete identity verification to continue.",
    authVerifyTitle: "Enter verification code",
    authVerifyLead: "Enter the code sent to complete sign up.",
    authVerifyEmailLead: "A verification code will be sent to your email.",
    authVerifySmsLead: "A verification code will be sent by SMS.",
    authVerifyEmailFallback:
      "SMS verified. Enter the confirmation code sent to your email.",
    authVerifyCode: "Verification code",
    authVerifyCodeRequired: "Enter the verification code.",
    authVerifySend: "Send code",
    authVerifySubmit: "Confirm and sign in",
    authVerifyResend: "Send code",
    authVerifySent: "Code sent.",
    authVerifySentStatus: "Sent · {time} left",
    authNewPassword: "New password",
    authAccountExists: "An account already exists for this person.",
    authRecoveryTitle: "Reset password",
    authRecoveryCodeTitle: "Set a new password",
    authRecoveryAction: "Forgot your password?",
    authRecoveryIdGuide:
      "Your PARADAYS login ID is the email used to sign up. Check your signup email.",
    authRecoverySmsUnavailable:
      "SMS verification is not available right now. Reset your password with your signup email.",
    authRecoveryCognitoUnavailable:
      "Online account recovery is not available right now. Try again after setup is complete or contact support.",
    authRecoveryRequest: "Request password reset code",
    authRecoveryRequestAccepted:
      "If a recoverable account matches the information provided, check its registered email.",
    authRecoveryTemporaryError:
      "We could not start account recovery right now. Please try again later.",
    authRecoveryCodeInvalid: "The code is invalid or expired. Request a new code.",
    authRecoveryCooldown: "Please wait before requesting another code.",
    authRecoveryConfirm: "Set new password",
    authPasswordResetDone: "Password updated. Sign in with the new password.",
    authAgreeAll: "Agree to all",
    authMarketingAll: "Marketing messages",
    authAgreements: "Agreements",
    authAgreeTerms: "Terms of Service",
    authAgreePrivacy: "Privacy collection & use",
    authAgreeAge: "I am 14 or older",
    authMarketingEmail: "Marketing email",
    authMarketingSms: "Marketing SMS",
    authMarketingPush: "Marketing push",
    authTermsRequired: "Accept all required agreements.",
    authViewTerms: "View",
    authSocialLead: "Or continue with",
    authCognitoHint:
      "Email/password uses Cognito on this page. Social sign-in uses Cognito when IdPs are connected.",
    authNeedAccount: "Need an account?",
    authHaveAccount: "Already have an account?",
    authAlreadySignedIn: "You are already signed in.",
    authNavSign: "Sign",
    authNavLogin: "Login",
    authGoToAdmin: "Admin",
    authContinueToAdmin: "Continue to admin",
    adminAccessEyebrow: "ADMIN ACCESS",
    adminAccessDeniedEyebrow: "ACCESS DENIED",
    adminAuthSetupRequired: "Admin authentication setup is required",
    adminAuthSetupDescription:
      "Once the Cognito domain and public client are configured, this screen will verify admin group permissions.",
    adminCheckingPermissions: "Checking permissions",
    adminCheckingPermissionsDescription:
      "Verifying your secure login session and admin group.",
    adminCheckingPermissionsLoading: "Checking permissions",
    adminLoginRequired: "Admin login required",
    adminLoginRequiredDescription:
      "Sign in with an account that has admin privileges to manage products and customer data.",
    adminLoginAction: "Admin login",
    adminAccessDenied: "You don't have admin access",
    adminAccessDeniedDescription:
      "This account is not linked to the admin group. Ask an operator to assign the admin group.",
    adminGoToAccount: "Go to my account",
    adminBackToStore: "Back to store",
    adminOverviewMenu: "Home (Operations Overview)",
    adminOverviewTitle: "Operations overview",
    adminOverviewLiveDescription:
      "Live metrics use Asia/Seoul time. Last updated {asOf}.",
    adminOverviewLoadingDescription: "Loading live operations metrics.",
    adminOverviewUnavailableDescription:
      "Live operations metrics appear after the admin API is connected.",
    adminOverviewMetricLoading: "Loading live metric",
    adminOverviewApiUnavailable: "Admin API connection required",
    adminOverviewAggregationPending: "Aggregation is being prepared",
    adminOverviewTodayOrders: "Orders today (orders)",
    adminOverviewTodayOrdersNote: "Orders created today (KST)",
    adminOverviewTodayRevenue: "Today's revenue",
    adminOverviewTodayRevenueNote: "Paid orders completed today (KST)",
    adminOverviewItemsSold: "Products sold (items)",
    adminOverviewItemsSoldNote: "Units in today's paid orders",
    adminOverviewNewMembers: "New members",
    adminOverviewNewMembersNote: "Members created today (KST)",
    adminOverviewLowStock: "Low stock",
    adminOverviewLowStockNote: "Products with {threshold} or fewer in stock",
    adminOverviewIssuedCoupons: "Issued coupons",
    adminOverviewIssuedCouponsNote: "Registered coupons, including drafts",
    adminOverviewMarketingAudience: "Marketing audience",
    adminOverviewMarketingAudienceNote: "Members who opted in to marketing",
  },
  ko: {
    home: "Home",
    menu: "Menu",
    cart: "Cart",
    search: "Search",
    account: "계정",
    myPage: "마이페이지",
    adminPage: "관리자페이지",
    close: "닫기",
    browse: "카테고리 보기",
    addToCart: "장바구니 담기",
    addedToCart: "장바구니에 담김",
    searchTitle: "PARADAYS 검색",
    searchPlaceholder: "검색...",
    searchHint: "검색 결과는 현재 페이지에서 확인 가능함.",
    searchResults: "검색 결과",
    noResults: "일치하는 상품 없음.",
    yourCart: "장바구니",
    continueShopping: "쇼핑 계속하기",
    wasAddedToCart: "장바구니에 담겼습니다",
    checkoutLink: "결제하기",
    emptyCart: "장바구니가 비어 있음.",
    remove: "삭제",
    quantity: "수량",
    productQuantity: "수량:",
    productSize: "사이즈",
    subtotal: "상품 합계",
    freeShipping: "• • ₩150,000 이상 무료 배송 • •",
    updateCart: "장바구니 업데이트",
    sellerInstructions: "판매자 요청사항:",
    agreeToTerms: "이용약관 및 환불 정책에 동의함",
    checkout: "결제하기",
    checkoutPreparing: "결제창 준비 중...",
    checkoutSetupRequired: "결제 설정이 아직 준비되지 않음.",
    checkoutSignInRequired: "결제를 진행하려면 로그인 필요함.",
    checkoutRequestFailed: "결제를 시작하지 못함. 다시 시도해 주세요.",
    paymentConfirming: "결제 승인 확인 중...",
    paymentComplete: "결제가 완료됨.",
    paymentPending: "결제 최종 승인을 기다리는 중임.",
    paymentFailed: "결제가 완료되지 않음.",
    accountTitle: "계정",
    accountLoading: "계정 정보 불러오는 중...",
    authComplete: "로그인됨. 계정으로 계속 진행하세요.",
    authCompleteAdmin: "로그인됨. 관리자 페이지로 계속 진행하세요.",
    accountUnavailable: "계정 서비스 설정이 아직 준비되지 않음.",
    signIn: "로그인",
    signUp: "회원가입",
    signOut: "로그아웃",
    displayName: "표시 이름",
    phoneNumber: "전화번호",
    marketingConsent: "마케팅 알림 수신에 동의함",
    saveChanges: "변경사항 저장",
    editProfile: "수정",
    cancelEdit: "취소",
    profileSaved: "프로필 저장됨.",
    profileUpdatedModal: "변경이 완료되었습니다.",
    orders: "주문 내역",
    noOrders: "주문 내역 없음.",
    accountRequestFailed: "계정 정보를 불러오거나 저장하지 못함.",
    accountProfileLoadFailed:
      "서버에서 프로필을 불러오지 못함. 로그인 정보로 수정은 가능함.",
    accountOrdersLoadFailed: "주문 내역을 불러오지 못함.",
    themeToDark: "다크 모드로 전환",
    themeToLight: "라이트 모드로 전환",
    previousImage: "이전 이미지",
    sizeChart: "상세사이즈",
    nextImage: "다음 이미지",
    loginTitle: "로그인",
    signUpTitle: "회원가입",
    loginLead: "아이디/비밀번호 또는 소셜 계정으로 로그인함.",
    signUpLead: "필수 항목만으로 가입함.",
    loginSubmit: "로그인",
    signUpSubmit: "회원가입",
    authEmail: "이메일",
    authLoginId: "아이디",
    authLoginIdPlaceholder: "아이디 (@gmail.com 생략 가능)",
    authLoginIdInvalid: "올바른 아이디 또는 이메일을 입력함.",
    authPassword: "비밀번호",
    authConfirmPassword: "비밀번호 확인",
    authPhone: "휴대폰 번호",
    authPhoneInvalid: "올바른 휴대폰 번호를 입력함.",
    authEmailInvalid: "올바른 이메일 형식을 입력함.",
    authPasswordRequired: "비밀번호를 입력함.",
    authPasswordInvalid: "비밀번호 정책을 충족하지 않음.",
    authPasswordMismatch: "비밀번호가 일치하지 않음.",
    authPasswordPolicy: "비밀번호 조건",
    authPasswordRule_length: "12자 이상",
    authPasswordRule_lowercase: "영문 소문자 포함",
    authPasswordRule_uppercase: "영문 대문자 포함",
    authPasswordRule_number: "숫자 포함",
    authPasswordRule_special: "특수문자 또는 공백 포함",
    authPasswordRule_noEdgeSpace: "앞뒤 공백 없음",
    authIdentityMethod: "본인인증",
    authIdentityEmail: "이메일 인증",
    authIdentitySms: "문자 인증",
    authIdentitySmsUnavailable:
      "문자 인증은 현재 제공되지 않습니다. 이메일 인증을 이용하세요.",
    authIdentityRequired: "본인인증을 완료해야 함.",
    authVerifyTitle: "인증 코드 입력",
    authVerifyLead: "받은 인증 코드를 입력하면 가입이 완료됨.",
    authVerifyEmailLead: "이메일로 인증 코드를 보냄.",
    authVerifySmsLead: "문자로 인증 코드를 보냄.",
    authVerifyEmailFallback: "문자 인증 완료. 이메일로 온 확인 코드를 입력함.",
    authVerifyCode: "인증 코드",
    authVerifyCodeRequired: "인증 코드를 입력함.",
    authVerifySend: "인증 코드 받기",
    authVerifySubmit: "확인 후 로그인",
    authVerifyResend: "인증 코드 받기",
    authVerifySent: "인증 코드를 보냄.",
    authVerifySentStatus: "발송 완료 · {time}",
    authNewPassword: "새 비밀번호",
    authAccountExists: "이미 가입된 계정임. 한 사람당 하나의 계정만 가능함.",
    authRecoveryTitle: "비밀번호 재설정",
    authRecoveryCodeTitle: "새 비밀번호 설정",
    authRecoveryAction: "비밀번호를 잊으셨나요?",
    authRecoveryIdGuide:
      "PARADAYS 로그인 아이디는 가입 이메일입니다. 가입 이메일을 확인해 주세요.",
    authRecoverySmsUnavailable:
      "문자 인증은 현재 제공하지 않습니다. 가입 이메일로 비밀번호를 재설정해 주세요.",
    authRecoveryCognitoUnavailable:
      "온라인 계정 복구는 현재 사용할 수 없음. 설정 완료 후 다시 시도하거나 고객센터에 문의해 주세요.",
    authRecoveryRequest: "비밀번호 재설정 코드 요청",
    authRecoveryRequestAccepted:
      "입력한 정보와 일치하는 복구 가능한 계정이 있는 경우, 등록된 이메일을 확인해 주세요.",
    authRecoveryTemporaryError:
      "현재 계정 복구를 시작할 수 없음. 잠시 후 다시 시도해 주세요.",
    authRecoveryCodeInvalid: "코드가 올바르지 않거나 만료됨. 새 코드를 요청해 주세요.",
    authRecoveryCooldown: "다음 코드 요청 전 잠시 기다려 주세요.",
    authRecoveryConfirm: "새 비밀번호 설정",
    authPasswordResetDone: "비밀번호를 변경함. 새 비밀번호로 로그인함.",
    authAgreeAll: "전체 동의",
    authMarketingAll: "마케팅 수신 동의",
    authAgreements: "약관 동의",
    authAgreeTerms: "서비스 이용약관",
    authAgreePrivacy: "개인정보 수집 및 이용",
    authAgreeAge: "만 14세 이상",
    authMarketingEmail: "마케팅 이메일",
    authMarketingSms: "마케팅 SMS",
    authMarketingPush: "마케팅 푸시",
    authTermsRequired: "필수 약관에 모두 동의함.",
    authViewTerms: "보기",
    authSocialLead: "또는 소셜로 계속",
    authCognitoHint:
      "이메일/비밀번호는 Cognito로 처리함. 소셜은 Cognito IdP 연결 후 사용 가능함.",
    authNeedAccount: "계정이 없나요?",
    authHaveAccount: "이미 계정이 있나요?",
    authAlreadySignedIn: "이미 로그인된 상태임.",
    authNavSign: "Sign",
    authNavLogin: "Login",
    authGoToAdmin: "관리자",
    authContinueToAdmin: "관리자 페이지로 이동",
    adminAccessEyebrow: "ADMIN ACCESS",
    adminAccessDeniedEyebrow: "ACCESS DENIED",
    adminAuthSetupRequired: "관리자 인증 설정이 필요합니다",
    adminAuthSetupDescription:
      "Cognito 도메인과 공개 클라이언트 설정이 완료되면 이 화면에서 관리자 그룹 권한을 확인합니다.",
    adminCheckingPermissions: "권한을 확인하는 중입니다",
    adminCheckingPermissionsDescription:
      "안전한 로그인 세션과 관리자 그룹을 확인하고 있습니다.",
    adminCheckingPermissionsLoading: "권한 확인 중",
    adminLoginRequired: "관리자 로그인이 필요합니다",
    adminLoginRequiredDescription:
      "관리 권한이 부여된 계정으로 로그인한 뒤 상품과 고객 데이터를 관리할 수 있습니다.",
    adminLoginAction: "관리자 로그인",
    adminAccessDenied: "관리자 권한이 없습니다",
    adminAccessDeniedDescription:
      "현재 계정에는 관리자 그룹이 연결되어 있지 않습니다. 운영자에게 admin 그룹 배정을 요청하세요.",
    adminGoToAccount: "내 계정으로 이동",
    adminBackToStore: "스토어로 돌아가기",
    adminOverviewMenu: "홈(운영현황)",
    adminOverviewTitle: "운영 현황",
    adminOverviewLiveDescription:
      "Asia/Seoul 기준 실시간 집계입니다. 마지막 갱신 {asOf}.",
    adminOverviewLoadingDescription: "실시간 운영 지표를 불러오는 중입니다.",
    adminOverviewUnavailableDescription:
      "실제 운영 지표는 관리자 API가 연결된 뒤에만 표시합니다.",
    adminOverviewMetricLoading: "실시간 집계 불러오는 중",
    adminOverviewApiUnavailable: "관리자 API 연결 대기",
    adminOverviewAggregationPending: "집계 준비 중",
    adminOverviewTodayOrders: "오늘 주문(건)",
    adminOverviewTodayOrdersNote: "오늘(KST) 생성된 주문",
    adminOverviewTodayRevenue: "오늘 매출",
    adminOverviewTodayRevenueNote: "오늘(KST) 결제완료 주문 기준",
    adminOverviewItemsSold: "판매 상품 수량(개)",
    adminOverviewItemsSoldNote: "오늘 결제완료 판매 수량(개)",
    adminOverviewNewMembers: "신규 회원",
    adminOverviewNewMembersNote: "오늘(KST) 가입한 회원",
    adminOverviewLowStock: "재고 주의",
    adminOverviewLowStockNote: "재고 {threshold}개 이하 상품",
    adminOverviewIssuedCoupons: "발급 쿠폰",
    adminOverviewIssuedCouponsNote: "등록된 쿠폰(초안 포함)",
    adminOverviewMarketingAudience: "마케팅 대상",
    adminOverviewMarketingAudienceNote: "마케팅 수신 동의 회원",
  },
} as const;

type LocaleContextValue = {
  locale: Locale;
  setLocale: (locale: Locale) => void;
  copy: (typeof translations)[Locale];
};

const LocaleContext = createContext<LocaleContextValue | null>(null);

/**
 * 언어 Provider.
 * 서버 첫 렌더는 항상 en으로 맞추고, 하이드레이션 후 저장된 선호을 읽습니다.
 */
export function LocaleProvider({ children }: { children: ReactNode }) {
  const [locale, setLocale] = useState<Locale>("en");
  const [hasLoadedPreference, setHasLoadedPreference] = useState(false);

  // 하이드레이션 이후에 로드해 서버 마크업을 결정적으로 유지하고, 스토리지는 브라우저에서만 사용합니다.
  useEffect(() => {
    let isCurrent = true;

    // 동기 effect 업데이트를 피하려고 스토리지 읽기를 외부 브라우저 콜백으로 예약합니다.
    window.queueMicrotask(() => {
      try {
        const savedLocale = window.localStorage.getItem(LOCALE_STORAGE_KEY);

        if (isCurrent && (savedLocale === "ko" || savedLocale === "en")) {
          setLocale(savedLocale);
        }
      } catch {
        // 시크릿/임베디드 브라우징 환경에서는 스토리지를 사용할 수 없을 수 있습니다.
      } finally {
        if (isCurrent) {
          setHasLoadedPreference(true);
        }
      }
    });

    return () => {
      isCurrent = false;
    };
  }, []);

  // 로드가 끝난 뒤에만 선택 언어를 저장합니다.
  useEffect(() => {
    if (hasLoadedPreference) {
      try {
        window.localStorage.setItem(LOCALE_STORAGE_KEY, locale);
      } catch {
        // 지속성을 사용할 수 없어도 메모리 안의 로케일은 계속 쓸 수 있게 합니다.
      }
    }
  }, [hasLoadedPreference, locale]);

  // <html lang>을 현재 로케일과 동기화합니다.
  useEffect(() => {
    document.documentElement.lang = locale;
  }, [locale]);

  const value = useMemo(
    () => ({ locale, setLocale, copy: translations[locale] }),
    [locale],
  );

  return <LocaleContext.Provider value={value}>{children}</LocaleContext.Provider>;
}

/** LocaleProvider 하위에서 언어·UI 문구에 접근합니다. */
export function useLocale() {
  const context = useContext(LocaleContext);

  if (!context) {
    throw new Error("useLocale must be used within LocaleProvider.");
  }

  return context;
}

/** 번역표에 없는 새 상품 사양은 원문을 노출해 카탈로그 렌더링을 끊지 않습니다. */
export function translateProductDescription(locale: Locale, description: string) {
  return productDescriptionTranslations[locale][description] ?? description;
}
