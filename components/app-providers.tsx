// 역할: 모든 라우트에 공유 인증·로케일·테마·장바구니 클라이언트 프로바이더를 감쌉니다.
"use client";

import type { ReactNode } from "react";

import { AuthProvider } from "@/contexts/auth-context";
import { CartProvider } from "@/contexts/cart-context";
import { CatalogFilterProvider } from "@/contexts/catalog-filter-context";
import { LocaleProvider } from "@/contexts/locale-context";
import { ThemeProvider } from "@/contexts/theme-context";

/**
 * 루트 레이아웃에서 쓰는 클라이언트 프로바이더 묶음.
 * AuthProvider를 가장 바깥에 두고, LocaleProvider가 장바구니 UI 문구도 현재 언어를 쓰게 합니다.
 */
export function AppProviders({ children }: { children: ReactNode }) {
  return (
    <AuthProvider>
      <LocaleProvider>
        <ThemeProvider>
          <CatalogFilterProvider>
            <CartProvider>{children}</CartProvider>
          </CatalogFilterProvider>
        </ThemeProvider>
      </LocaleProvider>
    </AuthProvider>
  );
}
