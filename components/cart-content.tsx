// 역할: 장바구니 수량·소계·약관 동의를 서버 주문 생성과 Toss Payments 결제창 흐름에 연결합니다.
"use client";

import Image from "next/image";
import Link from "next/link";
import { useEffect, useRef, useState } from "react";

import { useAuth } from "@/contexts/auth-context";
import { useCart } from "@/contexts/cart-context";
import { useLocale } from "@/contexts/locale-context";
import { rememberAuthReturnPath } from "@/lib/auth/return-path";
import {
  CheckoutApiRequestError,
  CheckoutAuthorizationRequiredError,
  CheckoutClientUnavailableError,
  createCheckoutApiClientFromEnvironment,
} from "@/lib/commerce/checkout-api-client";
import { getLocalizedProductName } from "@/lib/commerce/product-i18n";
import {
  getTossPaymentsClientConfig,
  requestTossPayment,
  TossPaymentsClientUnavailableError,
} from "@/lib/commerce/toss-payments-client";

import styles from "./cart-content.module.css";

/** 장바구니 화면에 표시할 결제 진행·오류 상태입니다. */
type CheckoutFeedback =
  | Readonly<{ kind: "error"; message: string; signInLink?: boolean }>
  | Readonly<{ kind: "info"; message: string }>
  | Readonly<{ kind: "success"; message: string }>
  | null;

/** 장바구니 라인·소계에 쓰는 원화 포맷터입니다. */
const currencyFormatter = new Intl.NumberFormat("ko-KR", {
  style: "currency",
  currency: "KRW",
  maximumFractionDigits: 0,
});

/** Toss success/fail redirect 쿼리를 기록하지 않고 한 번만 처리하기 위한 정리 대상입니다. */
const PAYMENT_RETURN_PARAMETERS = [
  "payment",
  "checkoutToken",
  "paymentKey",
  "orderId",
  "amount",
  "code",
  "message",
] as const;

/** `/cart` 본문: variant 장바구니, 주문 생성, Toss redirect 후 서버 승인까지 담당합니다. */
export function CartContent() {
  const { clearCart, items, removeItem, setQuantity, subtotal } = useCart();
  const { copy, locale } = useLocale();
  const { getAccessToken, isAuthenticated, user } = useAuth();
  const [hasAcceptedTerms, setHasAcceptedTerms] = useState(false);
  const [isStartingCheckout, setIsStartingCheckout] = useState(false);
  const [feedback, setFeedback] = useState<CheckoutFeedback>(null);
  const processedPaymentReturnRef = useRef<string | null>(null);

  // Toss redirect 후 access token 메모리가 사라질 수 있으므로, 주문의 짧은 반환 토큰으로만 서버 승인을 요청합니다.
  useEffect(() => {
    const paymentReturn = readPaymentReturn();

    if (
      !paymentReturn ||
      processedPaymentReturnRef.current === paymentReturn.identifier
    ) {
      return;
    }

    processedPaymentReturnRef.current = paymentReturn.identifier;

    if (paymentReturn.kind === "fail") {
      // redirect query를 읽은 effect는 다음 microtask에서만 UI state를 갱신합니다.
      window.queueMicrotask(() =>
        setFeedback({ kind: "error", message: copy.paymentFailed }),
      );
      removePaymentReturnParameters();
      return;
    }

    if (paymentReturn.kind === "invalid") {
      window.queueMicrotask(() =>
        setFeedback({ kind: "error", message: copy.checkoutRequestFailed }),
      );
      removePaymentReturnParameters();
      return;
    }

    window.queueMicrotask(() =>
      setFeedback({ kind: "info", message: copy.paymentConfirming }),
    );

    let isCurrent = true;

    void (async () => {
      try {
        const checkoutApi = createCheckoutApiClientFromEnvironment({
          // confirmation endpoint는 token을 읽지 않지만, 같은 API 계약을 재사용합니다.
          authorizationTokenProvider: { getAccessToken },
        });
        const result = await checkoutApi.confirmPayment(paymentReturn);

        if (!isCurrent) {
          return;
        }

        if (result.status === "PAID") {
          clearCart();
          setFeedback({ kind: "success", message: copy.paymentComplete });
        } else {
          setFeedback({ kind: "info", message: copy.paymentPending });
        }
      } catch (error) {
        if (!isCurrent) {
          return;
        }

        setFeedback({
          kind: "error",
          message:
            error instanceof CheckoutApiRequestError && error.status >= 500
              ? `결제 결과 확인이 필요합니다. 다시 결제하지 말고 주문번호 ${paymentReturn.orderId}로 관리자에게 확인해 주세요.`
              : error instanceof CheckoutClientUnavailableError
                ? copy.checkoutSetupRequired
                : copy.checkoutRequestFailed,
        });
      } finally {
        if (isCurrent) {
          removePaymentReturnParameters();
        }
      }
    })();

    return () => {
      isCurrent = false;
    };
  }, [clearCart, copy, getAccessToken]);

  /** 로그인·동의·공개 설정을 확인한 뒤 서버 주문을 만든 후에만 Toss V2 결제창을 요청합니다. */
  const handleCheckout = async () => {
    if (!isAuthenticated) {
      setFeedback({
        kind: "error",
        message: copy.checkoutSignInRequired,
        signInLink: true,
      });
      return;
    }

    try {
      setIsStartingCheckout(true);
      setFeedback({ kind: "info", message: copy.checkoutPreparing });

      const checkoutApi = createCheckoutApiClientFromEnvironment({
        authorizationTokenProvider: { getAccessToken },
      });
      const session = await checkoutApi.createSession({
        lines: items.map(({ id, quantity, selectedSize }) => ({
          productId: id,
          quantity,
          selectedSize,
        })),
      });
      const tossConfig = getTossPaymentsClientConfig();

      await requestTossPayment({
        config: tossConfig,
        session,
        origin: window.location.origin,
        customerEmail: user?.email,
      });
    } catch (error) {
      if (error instanceof CheckoutAuthorizationRequiredError) {
        setFeedback({
          kind: "error",
          message: copy.checkoutSignInRequired,
          signInLink: true,
        });
      } else if (
        error instanceof CheckoutClientUnavailableError ||
        error instanceof TossPaymentsClientUnavailableError
      ) {
        setFeedback({ kind: "error", message: copy.checkoutSetupRequired });
      } else if (error instanceof CheckoutApiRequestError && error.status === 401) {
        setFeedback({
          kind: "error",
          message: copy.checkoutSignInRequired,
          signInLink: true,
        });
      } else if (error instanceof CheckoutApiRequestError && error.status === 409) {
        setFeedback({
          kind: "error",
          message:
            "상품 정보 또는 판매 가능 재고가 변경되었습니다. 기존 장바구니 상품을 삭제하고 최신 상품 페이지에서 다시 선택해 주세요.",
        });
      } else {
        setFeedback({ kind: "error", message: copy.checkoutRequestFailed });
      }
    } finally {
      setIsStartingCheckout(false);
    }
  };

  if (items.length === 0) {
    return (
      <div className={styles.emptyState}>
        <CheckoutFeedbackMessage accountLabel={copy.account} feedback={feedback} />
        <p>{copy.emptyCart}</p>
        <Link className={styles.continueLink} href="/">
          {copy.continueShopping}
        </Link>
      </div>
    );
  }

  return (
    <div className={styles.layout}>
      <CheckoutFeedbackMessage accountLabel={copy.account} feedback={feedback} />

      {/* 담은 상품 라인: 썸네일·이름·선택 옵션·가격·수량 스테퍼·삭제 */}
      <ul className={styles.lines}>
        {items.map((item) => {
          const displayName = getLocalizedProductName(item, locale);

          return (
            <li className={styles.line} key={item.lineId}>
              <div className={styles.thumbnail}>
                <Image alt={displayName} fill sizes="84px" src={item.image} />
              </div>
              <div className={styles.lineDetails}>
                <h2>{displayName}</h2>
                <small>
                  {copy.productSize}: {item.selectedSize}
                </small>
                <span>{currencyFormatter.format(item.price)}</span>
              </div>
              <div
                className={styles.quantity}
                aria-label={`${copy.quantity} ${displayName}`}
              >
                <button
                  aria-label={`${displayName} 수량 감소`}
                  onClick={() => setQuantity(item.lineId, item.quantity - 1)}
                  type="button"
                >
                  −
                </button>
                <span aria-live="polite">{item.quantity}</span>
                <button
                  aria-label={`${displayName} 수량 증가`}
                  onClick={() => setQuantity(item.lineId, item.quantity + 1)}
                  type="button"
                >
                  +
                </button>
              </div>
              <button
                aria-label={`${displayName} ${copy.remove}`}
                className={styles.removeButton}
                onClick={() => removeItem(item.lineId)}
                type="button"
              >
                ×
              </button>
            </li>
          );
        })}
      </ul>

      <div className={styles.cartActions}>
        <button type="button">{copy.updateCart}</button>
        <Link href="/">{copy.continueShopping}</Link>
      </div>

      <div className={styles.subtotal}>
        <strong>{copy.subtotal}</strong>
        <strong>{currencyFormatter.format(subtotal)}</strong>
      </div>

      <label className={styles.instructions}>
        <span>{copy.sellerInstructions}</span>
        <textarea />
      </label>

      <label className={styles.terms}>
        <input
          checked={hasAcceptedTerms}
          onChange={(event) => setHasAcceptedTerms(event.target.checked)}
          type="checkbox"
        />
        <span>{copy.agreeToTerms}</span>
      </label>

      <button
        className={styles.checkoutButton}
        disabled={!hasAcceptedTerms || isStartingCheckout}
        onClick={() => void handleCheckout()}
        type="button"
      >
        {isStartingCheckout ? copy.checkoutPreparing : copy.checkout}
      </button>
    </div>
  );
}

/** 결제 준비·성공·실패 상태를 Cart 본문과 빈 상태에서 같은 방식으로 알립니다. */
function CheckoutFeedbackMessage({
  accountLabel,
  feedback,
}: Readonly<{ accountLabel: string; feedback: CheckoutFeedback }>) {
  if (!feedback) {
    return null;
  }

  return (
    <p
      className={
        feedback.kind === "error"
          ? styles.checkoutFeedbackError
          : feedback.kind === "success"
            ? styles.checkoutFeedbackSuccess
            : styles.checkoutFeedbackInfo
      }
      role={feedback.kind === "error" ? "alert" : "status"}
    >
      {feedback.message}
      {feedback.kind === "error" && feedback.signInLink ? (
        <>
          {" "}
          <Link href="/login" onClick={() => rememberAuthReturnPath("/cart")}>
            {accountLabel}
          </Link>
        </>
      ) : null}
    </p>
  );
}

/** Cart route에 붙은 Toss redirect query를 종류별로 검증합니다. */
function readPaymentReturn():
  | Readonly<{ kind: "fail"; identifier: string }>
  | Readonly<{
      kind: "success";
      identifier: string;
      paymentKey: string;
      orderId: string;
      amount: number;
      checkoutReturnToken: string;
    }>
  | Readonly<{ kind: "invalid"; identifier: string }>
  | null {
  const parameters = new URLSearchParams(window.location.search);
  const kind = parameters.get("payment");

  if (!kind) {
    return null;
  }

  const identifier = window.location.search;

  if (kind === "fail") {
    return { kind, identifier };
  }

  const paymentKey = parameters.get("paymentKey")?.trim();
  const orderId = parameters.get("orderId")?.trim();
  const checkoutReturnToken = parameters.get("checkoutToken")?.trim();
  const amount = Number(parameters.get("amount"));

  if (
    kind !== "success" ||
    !paymentKey ||
    !orderId ||
    !checkoutReturnToken ||
    checkoutReturnToken.length < 32 ||
    !Number.isSafeInteger(amount) ||
    amount < 1
  ) {
    return { kind: "invalid", identifier };
  }

  return { kind, identifier, paymentKey, orderId, amount, checkoutReturnToken };
}

/** paymentKey·반환 토큰이 주소·브라우저 기록에 계속 남지 않게 confirmation 완료 뒤 제거합니다. */
function removePaymentReturnParameters() {
  const url = new URL(window.location.href);

  for (const parameter of PAYMENT_RETURN_PARAMETERS) {
    url.searchParams.delete(parameter);
  }

  window.history.replaceState(
    window.history.state,
    "",
    `${url.pathname}${url.search}${url.hash}`,
  );
}
