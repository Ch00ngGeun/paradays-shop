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
 * 앱 루트 레이아웃.
 * 모든 라우트에 Header와 클라이언트 프로바이더를 감싸고, 페이지 본문은 main에 둡니다.
 */
export default function RootLayout({ children }: Readonly<PropsWithChildren>) {
  return (
    <html data-scroll-behavior="smooth" lang="en" suppressHydrationWarning>
      <body>
        <AppProviders>
          <Header />
          <main>{children}</main>
        </AppProviders>
      </body>
    </html>
  );
}
