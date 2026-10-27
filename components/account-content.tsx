// 역할: Cognito 인증 상태에 따라 회원가입·로그인, 프로필 관리, 본인 주문 내역을 보여주는 계정 화면을 제공합니다.
"use client";

import Link from "next/link";
import {
  FormEvent,
  useEffect,
  useMemo,
  useRef,
  useState,
  type MouseEvent,
  type RefObject,
} from "react";

import { useAuth } from "@/contexts/auth-context";
import { useLocale } from "@/contexts/locale-context";
import { useFocusTrap } from "@/hooks/use-focus-trap";
import {
  createMemberApiClientFromEnvironment,
  type MemberOrderSummary,
  type MemberProfile,
} from "@/lib/commerce/member-api-client";
import { rememberAuthReturnPath } from "@/lib/auth/return-path";

import styles from "./account-content.module.css";

/** 계정 API의 읽기·쓰기 상태를 화면 메시지로 구분합니다. */
type AccountFeedback =
  | Readonly<{ kind: "error"; message: string }>
  | Readonly<{ kind: "success"; message: string }>
  | null;

/** 주문 금액을 현재 스토어의 원화 표기와 동일하게 표시합니다. */
const currencyFormatter = new Intl.NumberFormat("ko-KR", {
  style: "currency",
  currency: "KRW",
  maximumFractionDigits: 0,
});

/** `/account` 본문: Hosted UI 액션과 API Gateway profile·order 조회를 조합합니다. */
export function AccountContent() {
  const { copy } = useLocale();
  const {
    error,
    getAccessToken,
    isAuthenticated,
    isAvailable,
    setUserDisplayName,
    signOut,
    status,
    user,
  } = useAuth();
  const [profile, setProfile] = useState<MemberProfile | null>(null);
  const [orders, setOrders] = useState<MemberOrderSummary[]>([]);
  const [isLoadingData, setIsLoadingData] = useState(false);
  const [isSaving, setIsSaving] = useState(false);
  const [isEditing, setIsEditing] = useState(false);
  const [showSavedModal, setShowSavedModal] = useState(false);
  const [feedback, setFeedback] = useState<AccountFeedback>(null);
  const [formKey, setFormKey] = useState(0);
  const isEditingRef = useRef(false);

  useEffect(() => {
    isEditingRef.current = isEditing;
  }, [isEditing]);

  const memberApi = useMemo(() => {
    if (!isAuthenticated) {
      return null;
    }

    try {
      return createMemberApiClientFromEnvironment({
        authorizationTokenProvider: { getAccessToken },
      });
    } catch {
      return null;
    }
  }, [getAccessToken, isAuthenticated]);

  useEffect(() => {
    if (!memberApi || !user) {
      return;
    }

    const userSub = user.sub;
    const userEmail = user.email;
    const userDisplayName = user.displayName;
    let isCurrent = true;

    window.queueMicrotask(() => {
      if (!isCurrent) {
        return;
      }

      setIsLoadingData(true);
      setProfile(
        (current) =>
          current ?? {
            userSub,
            marketingConsent: false,
            ...(userEmail ? { email: userEmail } : {}),
            ...(userDisplayName ? { displayName: userDisplayName } : {}),
          },
      );
    });

    void (async () => {
      const errors: string[] = [];

      try {
        const nextProfile = await memberApi.getProfile();
        if (isCurrent) {
          setProfile(nextProfile);
          setUserDisplayName(nextProfile.displayName);
          // 편집 중이 아닐 때만 폼을 리셋해, 수정 모드 입력을 덮어쓰지 않습니다.
          if (!isEditingRef.current) {
            setFormKey((current) => current + 1);
          }
        }
      } catch {
        errors.push("profile");
      }

      try {
        const nextOrders = await memberApi.listOrders();
        if (isCurrent) {
          setOrders(nextOrders);
        }
      } catch {
        errors.push("orders");
      }

      if (!isCurrent) {
        return;
      }

      if (errors.length === 2) {
        setFeedback({ kind: "error", message: copy.accountRequestFailed });
      } else if (errors.includes("profile")) {
        setFeedback({ kind: "error", message: copy.accountProfileLoadFailed });
      } else if (errors.includes("orders")) {
        setFeedback({ kind: "error", message: copy.accountOrdersLoadFailed });
      } else {
        setFeedback(null);
      }

      setIsLoadingData(false);
    })();

    return () => {
      isCurrent = false;
    };
    // user 객체 전체가 아니라 sub 기준으로만 다시 불러와, 표시 이름 동기화로 폼이 리셋되지 않게 합니다.
    // eslint-disable-next-line react-hooks/exhaustive-deps -- intentional: user.sub / memberApi
  }, [
    copy.accountOrdersLoadFailed,
    copy.accountProfileLoadFailed,
    copy.accountRequestFailed,
    memberApi,
    setUserDisplayName,
    user?.sub,
  ]);

  const handleCancelEdit = () => {
    setIsEditing(false);
    setFeedback(null);
    setFormKey((current) => current + 1);
  };

  const handleStartEdit = () => {
    setFeedback(null);
    // 같은 클릭이 submit 버튼으로 이어지지 않도록 다음 틱에 편집 모드로 전환합니다.
    window.setTimeout(() => {
      setIsEditing(true);
    }, 0);
  };

  /** 폼에서 허용된 profile 필드만 API에 전송하고, 성공 응답을 새 기본값으로 반영합니다. */
  const handleProfileSubmit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();

    if (!isEditing) {
      return;
    }

    if (!memberApi) {
      setFeedback({ kind: "error", message: copy.accountUnavailable });
      return;
    }

    const formData = new FormData(event.currentTarget);
    const displayName = String(formData.get("displayName") ?? "").trim();
    const phoneNumber = String(formData.get("phoneNumber") ?? "").trim();

    try {
      setIsSaving(true);
      const updatedProfile = await memberApi.updateProfile({
        ...(displayName ? { displayName } : {}),
        ...(phoneNumber ? { phoneNumber } : {}),
        marketingConsent: formData.get("marketingConsent") === "on",
      });

      setProfile(updatedProfile);
      setUserDisplayName(updatedProfile.displayName);
      setIsEditing(false);
      setFeedback(null);
      setShowSavedModal(true);
      setFormKey((current) => current + 1);
    } catch {
      setFeedback({ kind: "error", message: copy.accountRequestFailed });
    } finally {
      setIsSaving(false);
    }
  };

  const handleSaveClick = (event: MouseEvent<HTMLButtonElement>) => {
    event.preventDefault();
    const form = event.currentTarget.form;

    if (!form || !isEditing) {
      return;
    }

    form.requestSubmit();
  };

  if (!isAvailable) {
    return <AccountMessage message={copy.accountUnavailable} />;
  }

  if (status === "initializing") {
    return <AccountMessage message={copy.accountLoading} />;
  }

  if (!isAuthenticated || !user) {
    return (
      <section className={styles.guest} aria-labelledby="account-title">
        <h1 id="account-title">{copy.accountTitle}</h1>
        {error ? <p className={styles.feedbackError}>{error.message}</p> : null}
        {feedback?.kind === "error" ? (
          <p className={styles.feedbackError}>{feedback.message}</p>
        ) : null}
        <div className={styles.authenticationActions}>
          <Link href="/login" onClick={() => rememberAuthReturnPath("/account")}>
            {copy.signIn}
          </Link>
          <Link href="/signup" onClick={() => rememberAuthReturnPath("/account")}>
            {copy.signUp}
          </Link>
        </div>
      </section>
    );
  }

  return (
    <section className={styles.account} aria-labelledby="account-title">
      <div className={styles.titleRow}>
        <div>
          <h1 id="account-title">{copy.accountTitle}</h1>
          <p>{user.email ?? user.username}</p>
        </div>
        <button onClick={() => signOut()} type="button">
          {copy.signOut}
        </button>
      </div>

      {feedback ? (
        <p
          className={
            feedback.kind === "error" ? styles.feedbackError : styles.feedbackSuccess
          }
          role={feedback.kind === "error" ? "alert" : "status"}
        >
          {feedback.message}
        </p>
      ) : null}

      <form
        className={styles.profileForm}
        key={formKey}
        onSubmit={(event) => void handleProfileSubmit(event)}
      >
        <label>
          <span>{copy.displayName}</span>
          <input
            defaultValue={profile?.displayName ?? user.displayName ?? ""}
            disabled={!isEditing}
            name="displayName"
            readOnly={!isEditing}
          />
        </label>
        <label>
          <span>{copy.phoneNumber}</span>
          <input
            defaultValue={profile?.phoneNumber ?? ""}
            disabled={!isEditing}
            name="phoneNumber"
            readOnly={!isEditing}
            type="tel"
          />
        </label>
        <label className={styles.marketingConsent}>
          <input
            defaultChecked={profile?.marketingConsent ?? false}
            disabled={!isEditing}
            name="marketingConsent"
            type="checkbox"
          />
          <span>{copy.marketingConsent}</span>
        </label>

        <div className={styles.profileActions}>
          {isEditing ? (
            <>
              <button
                disabled={isSaving || !memberApi}
                onClick={handleSaveClick}
                type="button"
              >
                {copy.saveChanges}
              </button>
              <button
                className={styles.secondaryAction}
                disabled={isSaving}
                onClick={handleCancelEdit}
                type="button"
              >
                {copy.cancelEdit}
              </button>
            </>
          ) : (
            <button disabled={!memberApi} onClick={handleStartEdit} type="button">
              {copy.editProfile}
            </button>
          )}
        </div>
      </form>

      <section className={styles.orders} aria-labelledby="orders-title">
        <h2 id="orders-title">{copy.orders}</h2>
        {isLoadingData ? <p>{copy.accountLoading}</p> : null}
        {!isLoadingData && orders.length === 0 ? <p>{copy.noOrders}</p> : null}
        <ul>
          {orders.map((order) => (
            <li key={order.orderId}>
              <div>
                <strong>{order.orderName}</strong>
                <span>{order.status}</span>
              </div>
              <time dateTime={order.createdAt}>{formatOrderDate(order.createdAt)}</time>
              <strong>{currencyFormatter.format(order.total)}</strong>
            </li>
          ))}
        </ul>
      </section>

      <ProfileSavedModal
        message={copy.profileUpdatedModal}
        onClose={() => setShowSavedModal(false)}
        open={showSavedModal}
      />
    </section>
  );
}

function ProfileSavedModal({
  open,
  message,
  onClose,
}: Readonly<{
  open: boolean;
  message: string;
  onClose: () => void;
}>) {
  const { copy } = useLocale();
  const dialogRef = useFocusTrap(open, onClose);
  const titleRef = useRef<HTMLHeadingElement | null>(null);

  useEffect(() => {
    if (open) {
      titleRef.current?.focus();
    }
  }, [open]);

  if (!open) {
    return null;
  }

  return (
    <div className={styles.modalOverlay}>
      <button
        aria-label={copy.close}
        className={styles.modalScrim}
        onClick={onClose}
        type="button"
      />
      <div
        aria-labelledby="profile-saved-title"
        aria-modal="true"
        className={styles.modalDialog}
        ref={dialogRef as RefObject<HTMLDivElement | null>}
        role="dialog"
      >
        <h2 id="profile-saved-title" ref={titleRef} tabIndex={-1}>
          {message}
        </h2>
        <button onClick={onClose} type="button">
          {copy.close}
        </button>
      </div>
    </div>
  );
}

/** Cognito 또는 API 구성이 준비되지 않은 상태를 같은 레이아웃으로 보여줍니다. */
function AccountMessage({ message }: Readonly<{ message: string }>) {
  return (
    <section className={styles.guest} aria-live="polite">
      <p>{message}</p>
    </section>
  );
}

/** 주문 생성 시각이 없거나 잘못된 값이어도 계정 화면 렌더링을 중단하지 않습니다. */
function formatOrderDate(value: string) {
  const date = new Date(value);

  return Number.isNaN(date.getTime())
    ? value
    : new Intl.DateTimeFormat("ko-KR", { dateStyle: "medium" }).format(date);
}
