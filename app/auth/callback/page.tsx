// 역할: Cognito Hosted UI Authorization Code + PKCE redirect가 돌아오는 정적 callback 라우트입니다.
"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useEffect } from "react";

import { useAuth } from "@/contexts/auth-context";
import { useLocale } from "@/contexts/locale-context";
import { consumeAuthReturnPath } from "@/lib/auth/return-path";

import styles from "./page.module.css";

/** Cognito callback 결과는 Root AuthProvider가 처리하고, 이 페이지는 진행·오류 상태만 안전하게 보여줍니다. */
export default function AuthCallbackPage() {
  const { error, status, user } = useAuth();
  const { copy } = useLocale();
  const router = useRouter();
  const isAdmin = Boolean(user?.groups.includes("admin"));

  useEffect(() => {
    if (status !== "authenticated") {
      return;
    }

    // 로그인 직전 페이지(상품상세·장바구니 등)로 즉시 복귀합니다.
    router.replace(consumeAuthReturnPath("/"));
  }, [router, status]);

  if (status === "authenticated") {
    return (
      <section className={styles.callback} aria-live="polite">
        <p>{isAdmin ? copy.authCompleteAdmin : copy.authComplete}</p>
        <p>{copy.accountLoading}</p>
      </section>
    );
  }

  if (status === "anonymous" || status === "unavailable") {
    return (
      <section className={styles.callback}>
        <p>{error?.message ?? copy.accountUnavailable}</p>
        <Link href="/login">{copy.authNavLogin}</Link>
      </section>
    );
  }

  return (
    <section className={styles.callback} aria-live="polite">
      <p>{copy.accountLoading}</p>
    </section>
  );
}
