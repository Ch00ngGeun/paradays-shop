// 역할: 전역 메타데이터, 스토어프론트 공통 레이아웃, 클라이언트 상태 프로바이더를 제공합니다.
import type { Metadata } from "next";
import type { PropsWithChildren } from "react";

import { AppProviders } from "@/components/app-providers";
import { Header } from "@/components/header";

import "./globals.css";

/** 브라우저 탭 제목·설명·파비콘 메타데이터 */
export const metadata: Metadata = {
  title: "PARADAYS — Skate Shop",
  description: "PARADAYS skateboard goods, apparel, and accessories.",
  icons: {
    icon: "/favicon.svg",
  },
};

/**
 * 정적 HTML은 en으로 고정이라, 저장 언어가 ko면 첫 그리기 전에 본문을 숨겨 영어가 보이지 않게 합니다.
 * LocaleProvider가 ko를 반영한 커밋에서 해제하고, JS가 실패해도 3초 뒤 스스로 해제합니다.
 * 키·속성 이름은 contexts/locale-context.tsx와 같아야 합니다.
 */
const LOCALE_PENDING_STYLE = "html[data-locale-pending] body{visibility:hidden}";
const LOCALE_PENDING_SCRIPT = `(function(){try{if(localStorage.getItem("paradays-locale")!=="ko")return;var r=document.documentElement;r.lang="ko";r.setAttribute("data-locale-pending","");setTimeout(function(){r.removeAttribute("data-locale-pending")},3000)}catch(e){}})()`;

/**
 * 앱 루트 레이아웃.
 * 모든 라우트에 Header와 클라이언트 프로바이더를 감싸고, 페이지 본문은 main에 둡니다.
 */
export default function RootLayout({ children }: Readonly<PropsWithChildren>) {
  return (
    <html data-scroll-behavior="smooth" lang="en" suppressHydrationWarning>
      <head>
        <style>{LOCALE_PENDING_STYLE}</style>
        <script dangerouslySetInnerHTML={{ __html: LOCALE_PENDING_SCRIPT }} />
      </head>
      <body>
        <AppProviders>
          <Header />
          <main>{children}</main>
        </AppProviders>
      </body>
    </html>
  );
}
