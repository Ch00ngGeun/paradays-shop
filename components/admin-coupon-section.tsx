// 역할: 관리자 쿠폰 메뉴 화면. 쿠폰명·코드·할인 방식·값·만료 시각 초안을 입력·검증하고 고객 노출 미리보기와 초안 저장을 제공합니다(고객 발급은 미연결).
"use client";
import adminCouponSectionStyles from "./admin-coupon-section.module.css";
import adminSharedStyles from "./admin-shared.module.css";
import { useLocale } from "@/contexts/locale-context";
import { adminGuideSteps } from "@/lib/admin-ui/admin-guides";
import { type FormEvent } from "react";
import styles from "./admin-dashboard.module.css";
import { AdminGuideButton } from "./admin-guide";
import { AdminHelpButton } from "./admin-help-button";
import { GrowingLineInput } from "./admin-product-name-input";
import requiredStyles from "./admin-required.module.css";
import {
  couponDraftValidation,
  couponExpiryIso,
  localizedText,
  moneyFormatter,
  Notice,
  NoticeMessage,
} from "./admin-shared";
import { AdminStepper } from "./admin-stepper";

export function CouponSection({
  canSaveToServer,
  couponCode,
  couponExpiresAt,
  couponName,
  couponType,
  couponValue,
  notice,
  onCodeChange,
  onExpiresAtChange,
  onNameChange,
  onSubmit,
  onTypeChange,
  onValueChange,
  saving,
}: Readonly<{
  canSaveToServer: boolean;
  couponCode: string;
  couponExpiresAt: string;
  couponName: string;
  couponType: "percent" | "amount";
  couponValue: string;
  notice: Notice;
  onCodeChange: (value: string) => void;
  onExpiresAtChange: (value: string) => void;
  onNameChange: (value: string) => void;
  onSubmit: (event: FormEvent<HTMLFormElement>) => void;
  onTypeChange: (value: "percent" | "amount") => void;
  onValueChange: (value: string) => void;
  saving: boolean;
}>) {
  const { locale } = useLocale();
  const isKorean = locale === "ko";
  const validationMessage = couponDraftValidation(
    couponName,
    couponCode,
    couponType,
    couponValue,
    couponExpiresAt,
  );
  const hasInput = Boolean(couponName || couponCode || couponValue || couponExpiresAt);
  const benefitPreview = validationMessage
    ? isKorean
      ? "혜택 설정 필요"
      : "Set the benefit"
    : couponType === "percent"
      ? `${Number(couponValue)}%`
      : moneyFormatter.format(Number(couponValue));
  const saved = notice?.kind === "success";

  return (
    <div className={`${styles.sectionStack} ${styles.couponScreen}`}>
      <header className={adminCouponSectionStyles.couponHeader}>
        <div>
          <p>
            {isKorean ? "고객 / 쿠폰 / 새 초안" : "Customers / Coupons / New draft"}
          </p>
          <div>
            <h2>{isKorean ? "쿠폰 만들기" : "Create coupon"}</h2>
            <span>
              {saved
                ? canSaveToServer
                  ? isKorean
                    ? "초안 저장 · 미발급"
                    : "Draft saved · Not issued"
                  : isKorean
                    ? "로컬 초안 · 미발급"
                    : "Local draft · Not issued"
                : isKorean
                  ? "초안 · 미발급"
                  : "Draft · Not issued"}
            </span>
          </div>
        </div>
        <AdminGuideButton locale={locale} steps={adminGuideSteps("coupons", locale)} />
      </header>
      {/* 안전 안내라서 도움말 안이 아니라 화면에 계속 보여 줍니다. */}
      <p className={adminCouponSectionStyles.couponSaveNote}>
        {isKorean
          ? "이 화면은 쿠폰 초안만 저장합니다. 고객에게 발급하거나 결제에 적용하지 않습니다."
          : "This screen saves coupon drafts only. It does not issue coupons to customers or apply them at checkout."}
      </p>
      <AdminStepper
        label={isKorean ? "쿠폰 작업 흐름" : "Coupon workflow"}
        locale={locale}
        steps={[
          {
            label: isKorean ? "혜택 설정" : "Set benefit",
            state: validationMessage ? "current" : "complete",
          },
          {
            label: isKorean ? "미리보기 확인" : "Check preview",
            state: validationMessage ? "upcoming" : "complete",
          },
          {
            label: isKorean ? "초안 저장" : "Save draft",
            state: saved ? "complete" : validationMessage ? "upcoming" : "current",
          },
          // 고객 발급은 연결되지 않아 완료로 표시하지 않습니다.
          {
            label: isKorean ? "고객 발급" : "Issue to customers",
            state: "unavailable",
          },
        ]}
      />
      <div className={adminCouponSectionStyles.couponWorkspace}>
        <form
          aria-label={isKorean ? "쿠폰 초안 설정" : "Coupon draft settings"}
          className={adminCouponSectionStyles.couponForm}
          noValidate
          onSubmit={onSubmit}
        >
          <div className={adminSharedStyles.titleWithHelp}>
            <h3>{isKorean ? "혜택 설정" : "Set benefit"}</h3>
            <AdminHelpButton
              locale={locale}
              target={isKorean ? "혜택 설정" : "Set benefit"}
            >
              <p>
                {isKorean
                  ? "대상 선택·최소 주문 금액·최대 할인·시작일 설정은 현재 지원하지 않습니다. 만료 시각은 한국 시간으로 입력하며 해당 시각에 만료하는 초안입니다."
                  : "Target selection, minimum order, maximum discount and start date are not supported yet. Enter the expiry in Korea time; the draft expires at that time."}
              </p>
            </AdminHelpButton>
          </div>
          <fieldset disabled={saving} className={styles.couponFields}>
            <label>
              <span>
                {isKorean ? "쿠폰명 (필수)" : "Coupon name (required)"}
                <span aria-hidden="true" className={requiredStyles.requiredMark}>
                  *
                </span>
              </span>
              <GrowingLineInput
                data-admin-guide="coupons.name"
                maxLength={120}
                required
                onValueChange={onNameChange}
                placeholder={
                  isKorean ? "첫 구매 웰컴 쿠폰" : "First purchase welcome coupon"
                }
                value={couponName}
              />
            </label>
            <div className={styles.helpField}>
              <label>
                <span>
                  {isKorean ? "쿠폰 코드 (필수)" : "Coupon code (required)"}
                  <span aria-hidden="true" className={requiredStyles.requiredMark}>
                    *
                  </span>
                </span>
                <input
                  aria-describedby="coupon-code-help"
                  maxLength={32}
                  required
                  onChange={(event) => onCodeChange(event.target.value.toUpperCase())}
                  placeholder="WELCOME10"
                  value={couponCode}
                />
                {/* 화면에서는 도움말 버튼으로 보이지만, 입력칸의 설명으로 계속 연결해 둡니다. */}
                <small className="srOnly" id="coupon-code-help">
                  {isKorean
                    ? "영문·숫자로 시작하는 3–32자 · 영문 대문자·숫자·_·- 사용"
                    : "3–32 characters starting with a letter or number · Uppercase letters, numbers, _ and -"}
                </small>
              </label>
              <span className={styles.fieldHelpCorner}>
                <AdminHelpButton
                  locale={locale}
                  target={isKorean ? "쿠폰 코드" : "Coupon code"}
                >
                  <p>
                    {isKorean
                      ? "영문·숫자로 시작하는 3–32자 · 영문 대문자·숫자·_·- 사용"
                      : "3–32 characters starting with a letter or number · Uppercase letters, numbers, _ and -"}
                  </p>
                </AdminHelpButton>
              </span>
            </div>
            <div
              className={adminCouponSectionStyles.couponInlineFields}
              data-admin-guide="coupons.benefit"
            >
              <label>
                <span>{isKorean ? "혜택 유형" : "Benefit type"}</span>
                <select
                  onChange={(event) =>
                    onTypeChange(event.target.value as "percent" | "amount")
                  }
                  value={couponType}
                >
                  <option value="percent">
                    {isKorean ? "정률 할인 (%)" : "Percent off (%)"}
                  </option>
                  <option value="amount">
                    {isKorean ? "정액 할인 (원)" : "Amount off (KRW)"}
                  </option>
                </select>
              </label>
              <div className={styles.helpField}>
                <label>
                  <span>
                    {couponType === "percent"
                      ? isKorean
                        ? "할인율 (%)"
                        : "Discount rate (%)"
                      : isKorean
                        ? "할인 금액 (원)"
                        : "Discount amount (KRW)"}{" "}
                    {isKorean ? "(필수)" : "(required)"}
                    <span aria-hidden="true" className={requiredStyles.requiredMark}>
                      *
                    </span>
                  </span>
                  <input
                    inputMode="numeric"
                    maxLength={12}
                    required
                    onChange={(event) => onValueChange(event.target.value)}
                    placeholder={couponType === "percent" ? "10" : "5000"}
                    type="text"
                    value={couponValue}
                  />
                </label>
                <span className={styles.fieldHelpCorner}>
                  <AdminHelpButton
                    locale={locale}
                    target={isKorean ? "할인 값" : "Discount value"}
                  >
                    <p>
                      {couponType === "percent"
                        ? isKorean
                          ? "1–100 사이 정수"
                          : "Whole number from 1 to 100"
                        : isKorean
                          ? "1–100,000,000원 사이 정수"
                          : "Whole number from 1 to 100,000,000 KRW"}{" "}
                      {isKorean
                        ? "· 쉼표·소수·지수 표기 제외"
                        : "· No commas, decimals or exponents"}
                    </p>
                  </AdminHelpButton>
                </span>
              </div>
            </div>
            <div className={styles.helpField}>
              <label>
                <span>
                  {isKorean
                    ? "만료 시각 (한국 시간·선택)"
                    : "Expiry (Korea time · optional)"}
                </span>
                <input
                  onChange={(event) => onExpiresAtChange(event.target.value)}
                  type="datetime-local"
                  value={couponExpiresAt}
                />
              </label>
              <span className={styles.fieldHelpCorner}>
                <AdminHelpButton
                  locale={locale}
                  target={isKorean ? "만료 시각" : "Expiry"}
                >
                  <p>
                    {isKorean
                      ? "입력한 한국 시간의 해당 시각에 만료합니다. 비우면 초안에 만료 시각을 넣지 않습니다."
                      : "Expires at the entered Korea time. Leave it empty to save the draft without an expiry."}
                  </p>
                </AdminHelpButton>
              </span>
            </div>
            {hasInput && validationMessage ? (
              <p className={adminCouponSectionStyles.couponValidation}>
                {localizedText(validationMessage, locale)}
              </p>
            ) : null}
            <p className={adminCouponSectionStyles.couponSaveNote}>
              {canSaveToServer
                ? isKorean
                  ? "서버에 초안만 저장합니다. 고객 발급·할인 적용은 하지 않습니다."
                  : "Saves only a draft to the server. It is not issued to customers or applied as a discount."
                : isKorean
                  ? "서버 미연결 · 이 화면에만 준비하며 발급하지 않습니다."
                  : "No server · Prepared on this screen only and not issued."}
            </p>
            <button
              className={styles.primaryButton}
              data-admin-guide="coupons.save"
              disabled={Boolean(validationMessage)}
              type="submit"
            >
              {saving
                ? isKorean
                  ? "저장 중…"
                  : "Saving…"
                : canSaveToServer
                  ? isKorean
                    ? "쿠폰 초안 저장"
                    : "Save coupon draft"
                  : isKorean
                    ? "이 화면에 초안 준비"
                    : "Prepare draft here"}
            </button>
          </fieldset>
          {notice ? <NoticeMessage notice={notice} /> : null}
        </form>
        <aside
          className={adminCouponSectionStyles.couponDraftPreview}
          data-admin-guide="coupons.preview"
          aria-label={isKorean ? "쿠폰 고객 노출 미리보기" : "Coupon customer preview"}
        >
          <div className={adminCouponSectionStyles.couponPreviewHeading}>
            <h3>{isKorean ? "쿠폰 미리보기" : "Coupon preview"}</h3>
            <span>
              {isKorean ? "초안 예시 · 사용 불가" : "Draft example · Not usable"}
            </span>
          </div>
          <div
            className={adminCouponSectionStyles.couponDraftTicket}
            data-valid={!validationMessage}
          >
            <span>PARADAYS</span>
            <strong>{benefitPreview}</strong>
            <p>
              {couponName.trim() ||
                (isKorean ? "쿠폰명을 입력하세요" : "Enter a coupon name")}
            </p>
            <code>
              {/^[A-Z0-9][A-Z0-9_-]{2,31}$/.test(couponCode.trim().toUpperCase())
                ? couponCode.trim().toUpperCase()
                : isKorean
                  ? "쿠폰 코드 확인 필요"
                  : "Check the coupon code"}
            </code>
            <small>
              {couponExpiresAt
                ? couponExpiryIso(couponExpiresAt)
                  ? isKorean
                    ? `만료 기준 ${couponExpiresAt.replace("T", " ")} (한국 시간)`
                    : `Expires ${couponExpiresAt.replace("T", " ")} (Korea time)`
                  : isKorean
                    ? "만료 시각 확인 필요"
                    : "Check the expiry"
                : isKorean
                  ? "만료 시각 미설정"
                  : "No expiry set"}
            </small>
          </div>
          <div className={adminCouponSectionStyles.couponUnissued}>
            <strong>{isKorean ? "아직 발급되지 않았습니다" : "Not issued yet"}</strong>
            <p>
              {isKorean
                ? "입력한 혜택을 확인하는 예시입니다. 초안을 저장해도 고객이 사용할 수 있는 쿠폰이 되지 않습니다."
                : "An example to check the benefit you entered. Saving the draft does not make a coupon customers can use."}
            </p>
          </div>
        </aside>
      </div>
    </div>
  );
}
