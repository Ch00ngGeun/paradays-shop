// 역할: 관리자 매출·일마감 메뉴의 진입 화면. 관리자에게만 연습하기(모의)와 실제 운영 중 하나를 고르게 하고, 실제 원장 머리말(SalesLedgerHeader)을 제공합니다.
"use client";
import { useState, type RefObject } from "react";
import { useAuth } from "@/contexts/auth-context";
import type { AdminCatalogListItem } from "@/lib/admin-ui/types";
import type { Locale } from "@/types/store";
import styles from "./admin-sales-ledger.module.css";
import { adminGuideSteps } from "@/lib/admin-ui/admin-guides";
import { AdminGuideButton } from "./admin-guide";
import { AdminHelpButton } from "./admin-help-button";
import { AdminSalesSimulationPanel } from "./admin-sales-simulation";
import { AdminNotice } from "./admin-status";
import { ActualSalesLedgerPanel } from "./admin-sales-ledger-actual";
import type { Attempt } from "./admin-sales-ledger-model";

/** 대시보드가 메뉴를 바꿔도 숨김 상태로 마운트를 유지해, 결과 미확인 요청이 사라지지 않게 합니다. */
export function AdminSalesLedgerPanel({
  products,
  locale = "ko",
}: Readonly<{ products: readonly AdminCatalogListItem[]; locale?: Locale }>) {
  const { isAuthenticated, status, user } = useAuth();
  if (status !== "authenticated" || !isAuthenticated || !user?.groups.includes("admin"))
    return null;
  return <SalesModeSession key={user.sub} products={products} locale={locale} />;
}
function SalesModeSession({
  products,
  locale,
}: Readonly<{ products: readonly AdminCatalogListItem[]; locale: Locale }>) {
  const isKorean = locale === "ko";
  const [mode, setMode] = useState<"choose" | "real" | "simulation">("choose");
  const [acknowledged, setAcknowledged] = useState(false);
  function chooseMode() {
    setMode("choose");
    setAcknowledged(false);
  }
  if (mode === "simulation")
    return (
      <section
        className={styles.simulationShell}
        aria-label={isKorean ? "모의 매출·일마감" : "Mock sales and daily close"}
      >
        <div className={styles.simulationModeBadge}>
          <span aria-hidden="true">◇</span>{" "}
          {isKorean ? "연습 중 · 실제 변경 없음" : "Practicing · No real changes"}
        </div>
        <AdminSalesSimulationPanel onExit={chooseMode} locale={locale} />
      </section>
    );
  if (mode === "real")
    return (
      <ActualSalesLedgerPanel products={products} onExit={chooseMode} locale={locale} />
    );
  return (
    <section className={styles.panel} aria-labelledby="sales-mode-title">
      <header className={styles.header}>
        <div>
          <h2 id="sales-mode-title">
            {isKorean ? "매출·일마감 모드 선택" : "Choose sales and daily close mode"}
          </h2>
          <p>
            {isKorean
              ? "연습과 실제 운영을 구분해 시작하세요."
              : "Start by choosing practice or real operations."}
          </p>
        </div>
        <AdminGuideButton locale={locale} steps={adminGuideSteps("sales", locale)} />
      </header>
      <div className={styles.modeCards} data-admin-guide="sales.mode">
        <section className={`${styles.block} ${styles.modeCard}`}>
          <span className={styles.simulationModeBadge}>
            <span aria-hidden="true">◇</span>{" "}
            {isKorean ? "실제 변경 없음" : "No real changes"}
          </span>
          <h3>{isKorean ? "연습하기" : "Practice"}</h3>
          <p>
            {isKorean
              ? "가상 상품으로 카드·현금·이체 판매부터 재고 반영·일마감까지 연습합니다."
              : "Practice card, cash and transfer sales through stock updates and daily close with virtual products."}
          </p>
          <label className={styles.check}>
            <input
              type="checkbox"
              checked={acknowledged}
              onChange={(event) => setAcknowledged(event.target.checked)}
            />
            {isKorean
              ? "실제 장부와 재고를 바꾸지 않는 모의 체험임을 확인했습니다"
              : "I confirm this mock practice does not change the real ledger or stock"}
          </label>
          <button
            className={styles.primary}
            type="button"
            disabled={!acknowledged}
            onClick={() => {
              if (acknowledged) setMode("simulation");
            }}
          >
            {isKorean ? "모의 매출·일마감 체험" : "Try mock sales and daily close"}
          </button>
          <details className={styles.inlineHelp}>
            <summary>
              {isKorean ? "연습 데이터 보관 안내" : "Practice data storage"}
            </summary>
            <p>
              {isKorean
                ? "브라우저 메모리의 합성 TEST 상품·전표만 사용합니다. 메뉴 이동 시 유지되며 초기화·종료·새로고침·로그아웃·계정 교체 시 폐기됩니다. 실제 상품·장부·온라인 매출은 조회하거나 변경하지 않습니다."
                : "Uses only synthetic TEST products and slips in browser memory. They persist across menus and are discarded on reset, end, refresh, sign-out or account switch. Real products, ledger and online sales are never read or changed."}
            </p>
          </details>
        </section>
        <section className={`${styles.block} ${styles.modeCard}`}>
          <span className={styles.actualModeBadge}>
            <span aria-hidden="true">●</span>{" "}
            {isKorean ? "실제 장부·재고 변경" : "Changes real ledger and stock"}
          </span>
          <h3>{isKorean ? "실제 운영" : "Real operations"}</h3>
          <AdminNotice status="attention" locale={locale}>
            {isKorean
              ? "판매를 확정하면 실제 재고가 차감됩니다. 연습하려면 ‘연습하기’를 선택하세요."
              : "Posting a sale deducts real stock. To practice, choose ‘Practice’."}
          </AdminNotice>
          <div className={styles.muted}>
            <AdminHelpButton
              locale={locale}
              target={isKorean ? "실제 운영" : "Real operations"}
            >
              <p>
                {isKorean
                  ? "기존 미확정 요청은 실제 운영에서 확인합니다."
                  : "Check earlier unconfirmed requests in real operations."}
              </p>
            </AdminHelpButton>
          </div>
          <button
            aria-label={
              isKorean
                ? "실제 운영 열기 · 실제 매출·일마감 열기"
                : "Open real operations · Open real sales and daily close"
            }
            className={styles.primary}
            type="button"
            onClick={() => setMode("real")}
          >
            {isKorean ? "실제 운영 열기" : "Open real operations"}
          </button>
        </section>
      </div>
    </section>
  );
}
export function SalesLedgerHeader({
  isKorean,
  locale,
  locked,
  busyRef,
  attempt,
  onExit,
}: Readonly<{
  isKorean: boolean;
  locale: Locale;
  locked: boolean;
  busyRef: RefObject<boolean>;
  attempt: Attempt | null;
  onExit: () => void;
}>) {
  return (
    <header className={styles.header}>
      <div>
        <div className={styles.titleRow}>
          <h2 id="sales-ledger-title">
            {isKorean ? "매출·일마감 관리" : "Sales and daily close"}
          </h2>
          <span className={styles.actualModeBadge}>
            <span aria-hidden="true">●</span>{" "}
            {isKorean
              ? "실제 운영 · 장부·재고 변경"
              : "Real operations · Changes ledger and stock"}
          </span>
        </div>
        <p>
          {isKorean
            ? "카드·현금·이체 전표와 하루 매출을 대조합니다. 날짜·시각은 한국 시간입니다."
            : "Reconcile card, cash and transfer slips with the day's sales. Dates and times are in Korea time."}
        </p>
      </div>
      {/* div가 아니라 span이라서 머리말의 글 영역용 grid 규칙(.header > div)이 적용되지 않습니다. */}
      <span>
        <AdminGuideButton locale={locale} steps={adminGuideSteps("sales", locale)} />{" "}
        <button
          type="button"
          disabled={locked}
          onClick={() => {
            if (!busyRef.current && !attempt) onExit();
          }}
        >
          {isKorean ? "모드 선택으로 돌아가기" : "Back to mode selection"}
        </button>
      </span>
    </header>
  );
}
