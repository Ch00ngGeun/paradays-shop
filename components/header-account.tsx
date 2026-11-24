"use client";

import Link from "next/link";
import { useSearchParams } from "next/navigation";
import { Suspense, useSyncExternalStore } from "react";

import type { useAuth } from "@/contexts/auth-context";
import type { useLocale } from "@/contexts/locale-context";
import { rememberAuthReturnPath } from "@/lib/auth/return-path";
import {
  buildAdminEntryHref,
  getServerStorefrontHashSnapshot,
  getStorefrontHashSnapshot,
  subscribeToStorefrontHash,
} from "@/lib/admin-ui/store-return";

import styles from "./header.module.css";

export function HeaderAccountNav({
  pathname,
  isAuthenticated,
  user,
  copy,
}: Readonly<{
  pathname: string;
  isAuthenticated: boolean;
  user: ReturnType<typeof useAuth>["user"];
  copy: ReturnType<typeof useLocale>["copy"];
}>) {
  return (
    <nav aria-label="Account" className={styles.authNav}>
      {isAuthenticated && user ? (
        <>
          <Link
            aria-current={pathname === "/account" ? "page" : undefined}
            href="/account"
          >
            {copy.myPage}
          </Link>
          <span aria-hidden="true" className={styles.authNavSep}>
            /
          </span>
          <span className={styles.authNavUser}>
            {user.displayName?.trim() || user.email || user.username}
          </span>
          {user.groups.includes("admin") ? (
            <>
              <span aria-hidden="true" className={styles.authNavSep}>
                /
              </span>
              <Suspense
                fallback={
                  <Link href={buildAdminEntryHref(pathname)}>{copy.adminPage}</Link>
                }
              >
                <AdminEntryLink pathname={pathname} label={copy.adminPage} />
              </Suspense>
            </>
          ) : null}
        </>
      ) : (
        <>
          <Link
            aria-current={pathname === "/signup" ? "page" : undefined}
            href="/signup"
            onClick={() => rememberAuthReturnPath()}
          >
            {copy.authNavSign}
          </Link>
          <span aria-hidden="true" className={styles.authNavSep}>
            /
          </span>
          <Link
            aria-current={pathname === "/login" ? "page" : undefined}
            href="/login"
            onClick={() => rememberAuthReturnPath()}
          >
            {copy.authNavLogin}
          </Link>
        </>
      )}
    </nav>
  );
}

/** query 기반 신규 상품도 현재 상세 위치를 갖는 실제 링크로 만들어 새 탭 동작을 유지합니다. */
function AdminEntryLink({
  pathname,
  label,
}: Readonly<{ pathname: string; label: string }>) {
  const searchParams = useSearchParams();
  const hash = useSyncExternalStore(
    subscribeToStorefrontHash,
    getStorefrontHashSnapshot,
    getServerStorefrontHashSnapshot,
  );
  const search = searchParams.toString();
  return (
    <Link href={buildAdminEntryHref(`${pathname}${search ? `?${search}` : ""}${hash}`)}>
      {label}
    </Link>
  );
}
