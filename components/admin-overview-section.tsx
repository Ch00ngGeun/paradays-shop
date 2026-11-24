"use client";
import adminSharedStyles from "./admin-shared.module.css";
import { useLocale } from "@/contexts/locale-context";
import { adminGuideSteps } from "@/lib/admin-ui/admin-guides";
import { type AdminSection } from "@/lib/admin-ui/navigation";
import type { AdminOverviewMetrics } from "@/lib/admin-ui/types";
import { useEffect, useMemo, useState } from "react";
import styles from "./admin-dashboard.module.css";
import { AdminGuideButton } from "./admin-guide";
import { AdminHelpButton } from "./admin-help-button";
import { AdminMenuIcon, sectionShortLabels } from "./admin-navigation";
import {
  localizedText,
  MetricCard,
  OperationActivity,
  operationIconTone,
  operationStatusLabels,
  QuickAction,
} from "./admin-shared";
import { AdminNotice } from "./admin-status";
import { AdminStepper, type AdminStep } from "./admin-stepper";

export function OverviewSection({
  activities,
  canResumeActivity,
  loadOverviewMetrics,
  onOpenActivity,
  onGoTo,
  onOpenCreate,
}: Readonly<{
  activities: readonly OperationActivity[];
  canResumeActivity: (activity: OperationActivity) => boolean;
  loadOverviewMetrics?: () => Promise<AdminOverviewMetrics>;
  onOpenActivity: (activity: OperationActivity) => void;
  onGoTo: (section: AdminSection) => void;
  onOpenCreate: () => void;
}>) {
  const { copy, locale } = useLocale();
  const [showAllActivities, setShowAllActivities] = useState(false);
  const isKorean = locale === "ko";
  const [metrics, setMetrics] = useState<AdminOverviewMetrics | null>(null);
  const [metricsState, setMetricsState] = useState<
    "loading" | "ready" | "unavailable" | "error"
  >(loadOverviewMetrics ? "loading" : "unavailable");

  useEffect(() => {
    if (!loadOverviewMetrics) {
      // eslint-disable-next-line react-hooks/set-state-in-effect -- resets when the loader is removed; isCurrent guards async results.
      setMetrics(null);
      setMetricsState("unavailable");
      return;
    }

    let isCurrent = true;
    setMetricsState("loading");

    void loadOverviewMetrics()
      .then((nextMetrics) => {
        if (!isCurrent) {
          return;
        }

        setMetrics(nextMetrics);
        setMetricsState("ready");
      })
      .catch(() => {
        if (!isCurrent) {
          return;
        }

        setMetrics(null);
        setMetricsState("error");
      });

    return () => {
      isCurrent = false;
    };
  }, [loadOverviewMetrics]);

  const formatCount = (value: number | undefined) =>
    metricsState === "loading" ? "…" : value === undefined ? "—" : String(value);
  const revenueFormatter = useMemo(
    () =>
      new Intl.NumberFormat(locale === "ko" ? "ko-KR" : "en-US", {
        style: "currency",
        currency: "KRW",
        maximumFractionDigits: 0,
      }),
    [locale],
  );
  const formatRevenue = (value: number | undefined) =>
    metricsState === "loading"
      ? "…"
      : value === undefined
        ? "—"
        : revenueFormatter.format(value);
  const metricNote = (value: number | undefined, readyNote: string) => {
    if (metricsState === "loading") {
      return copy.adminOverviewMetricLoading;
    }

    if (metricsState === "unavailable") {
      return copy.adminOverviewApiUnavailable;
    }
    if (metricsState === "error") {
      return isKorean
        ? "지표 조회 실패 · 연결·권한 확인 필요"
        : "Metrics request failed · Check connection and permissions";
    }

    return value === undefined ? copy.adminOverviewAggregationPending : readyNote;
  };
  const overviewDescription =
    metricsState === "ready"
      ? copy.adminOverviewLiveDescription.replace("{asOf}", metrics?.asOf ?? "—")
      : metricsState === "loading"
        ? copy.adminOverviewLoadingDescription
        : metricsState === "error"
          ? isKorean
            ? "운영 지표를 불러오지 못했습니다. 연결과 관리자 권한을 확인해 주세요."
            : "Could not load operational metrics. Check the connection and administrator permissions."
          : copy.adminOverviewUnavailableDescription;
  const metricAsOf = metrics?.asOf ? new Date(metrics.asOf) : null;
  const formattedAsOf =
    metricsState === "ready" && metricAsOf && Number.isFinite(metricAsOf.getTime())
      ? new Intl.DateTimeFormat(isKorean ? "ko-KR" : "en-US", {
          timeZone: "Asia/Seoul",
          dateStyle: "medium",
          timeStyle: "short",
        }).format(metricAsOf)
      : null;

  const lowStockReady =
    metricsState === "ready" && metrics?.lowStockCount !== undefined;
  const homeSteps: AdminStep[] = [
    {
      label: isKorean ? "운영 지표 조회" : "Load metrics",
      state:
        metricsState === "ready"
          ? "complete"
          : metricsState === "unavailable"
            ? "unavailable"
            : "current",
    },
    {
      label: isKorean ? "재고 확인" : "Check stock",
      state: !lowStockReady
        ? "upcoming"
        : (metrics?.lowStockCount ?? 0) > 0
          ? "current"
          : "complete",
    },
    {
      // 일마감 결과는 홈에서 조회하지 않으므로 완료로 표시하지 않습니다.
      label: isKorean ? "매출·일마감" : "Sales & day close",
      state: lowStockReady && metrics?.lowStockCount === 0 ? "current" : "upcoming",
    },
  ];
  return (
    <div className={`${styles.sectionStack} ${styles.overviewStack}`}>
      <AdminStepper
        className={styles.screenStepper}
        label={isKorean ? "홈 작업 흐름" : "Home workflow"}
        locale={locale}
        steps={homeSteps}
      />
      <header className={styles.overviewHeader}>
        <div>
          <h2>{copy.adminOverviewTitle}</h2>
          <p
            className={adminSharedStyles.overviewTimestamp}
            role={metricsState === "error" ? "alert" : "status"}
          >
            {formattedAsOf
              ? `${isKorean ? "집계 기준" : "As of"} ${formattedAsOf} · KST`
              : overviewDescription}
          </p>
        </div>
        {/* Pushed to the end so "New product" stays a direct child with its header styles. */}
        <span className={adminSharedStyles.pushEnd}>
          <AdminGuideButton locale={locale} steps={adminGuideSteps("home", locale)} />
        </span>
        <button className={styles.secondaryButton} onClick={onOpenCreate} type="button">
          <span aria-hidden="true">＋</span> {isKorean ? "새 상품" : "New product"}
        </button>
      </header>
      <div
        className={styles.overviewMetricGrid}
        aria-busy={metricsState === "loading"}
        data-admin-guide="home.metrics"
      >
        <MetricCard
          icon="sales"
          label={copy.adminOverviewTodayRevenue}
          value={formatRevenue(metrics?.todayPaidRevenue)}
          note={metricNote(
            metrics?.todayPaidRevenue,
            isKorean
              ? "오늘 온라인 결제완료 주문 · KST"
              : "Today's paid online orders · KST",
          )}
        />
        <MetricCard
          icon="overview"
          label={copy.adminOverviewTodayOrders}
          value={formatCount(metrics?.todayOrderCount)}
          note={metricNote(metrics?.todayOrderCount, copy.adminOverviewTodayOrdersNote)}
        />
        <MetricCard
          icon="inventory"
          label={copy.adminOverviewItemsSold}
          value={formatCount(metrics?.todaySoldItemCount)}
          note={metricNote(
            metrics?.todaySoldItemCount,
            copy.adminOverviewItemsSoldNote,
          )}
        />
      </div>
      <section className={styles.overviewTasks} aria-labelledby="quick-actions-title">
        <h2 id="quick-actions-title">
          {isKorean ? "운영 바로가기" : "Operations shortcuts"}
        </h2>
        <div className={adminSharedStyles.overviewTaskList}>
          <QuickAction
            icon="ocr"
            label={isKorean ? "입고 검토" : "Intake review"}
            note={
              isKorean
                ? "이미지에서 상품과 수량 확인"
                : "Review products and quantities from an image"
            }
            actionLabel={isKorean ? "입고 검토 시작" : "Start intake review"}
            primary
            onClick={() => onGoTo("ocr")}
          />
          <QuickAction
            guide="home.lowStock"
            icon="inventory"
            label={copy.adminOverviewLowStock}
            value={formatCount(metrics?.lowStockCount)}
            note={metricNote(
              metrics?.lowStockCount,
              copy.adminOverviewLowStockNote.replace(
                "{threshold}",
                String(metrics?.lowStockThreshold ?? 5),
              ),
            )}
            actionLabel={isKorean ? "재고 확인" : "Check stock"}
            needsAttention={
              metricsState === "ready" && (metrics?.lowStockCount ?? 0) > 0
            }
            onClick={() => onGoTo("inventory")}
          />
          <QuickAction
            guide="home.sales"
            icon="sales"
            label={isKorean ? "매출·일마감" : "Sales & day close"}
            note={
              isKorean
                ? "판매 전표와 하루 매출 대조"
                : "Review sales entries and reconcile the day"
            }
            actionLabel={isKorean ? "매출·마감 확인" : "Review sales & close"}
            onClick={() => onGoTo("sales")}
          />
        </div>
      </section>
      <section
        className={adminSharedStyles.recentOperations}
        aria-labelledby="recent-operations-title"
      >
        <header>
          <div className={adminSharedStyles.titleWithHelp}>
            <h2 id="recent-operations-title">
              {isKorean ? "최근 운영 기록" : "Recent activity"}
            </h2>
            <span className={adminSharedStyles.fieldHelp}>
              <AdminHelpButton
                locale={locale}
                target={isKorean ? "최근 운영 기록" : "Recent activity"}
              >
                <p>
                  {isKorean
                    ? "이번 관리자 화면에서 수행한 작업별 최근 상태만 표시합니다(최대 12개). 새로고침하면 초기화되며, 서버 전체 운영 이력이 아닙니다."
                    : "Shows only the latest status of each task done on this admin screen (up to 12). It resets on refresh and is not the full server activity history."}
                </p>
              </AdminHelpButton>
            </span>
          </div>
          {activities.length > 5 ? (
            <button
              aria-expanded={showAllActivities}
              className={styles.secondaryButton}
              onClick={() => setShowAllActivities((current) => !current)}
              type="button"
            >
              {showAllActivities
                ? isKorean
                  ? "최근 5건"
                  : "Latest 5"
                : isKorean
                  ? "전체보기"
                  : "Show all"}
            </button>
          ) : null}
        </header>
        {activities.length === 0 ? (
          <p className={adminSharedStyles.operationEmpty}>
            {isKorean
              ? "아직 이 화면에서 수행한 작업이 없습니다."
              : "No tasks done on this screen yet."}
          </p>
        ) : (
          <ul className={adminSharedStyles.operationList}>
            {activities.slice(0, showAllActivities ? 12 : 5).map((activity) => {
              const resume = canResumeActivity(activity);
              if (activity.status === "attention") {
                return (
                  <li data-status={activity.status} key={activity.key}>
                    <AdminNotice
                      locale={locale}
                      status="attention"
                      title={
                        isKorean
                          ? `${sectionShortLabels[locale][activity.section]} 작업`
                          : `${sectionShortLabels[locale][activity.section]} task`
                      }
                    >
                      <time dateTime={new Date(activity.at).toISOString()}>
                        {new Intl.DateTimeFormat(isKorean ? "ko-KR" : "en-US", {
                          timeZone: "Asia/Seoul",
                          hour: "2-digit",
                          minute: "2-digit",
                          hour12: false,
                        }).format(activity.at)}{" "}
                        KST
                      </time>
                      <p>{localizedText(activity.detail, locale)}</p>
                      {activity.editorId && !resume ? (
                        <small>
                          {isKorean
                            ? "편집 초안은 더 이상 열려 있지 않습니다. 상품 목록에서 확인하세요."
                            : "The edit draft is no longer open. Check the product list."}
                        </small>
                      ) : null}
                      <button
                        className={styles.secondaryButton}
                        onClick={() => onOpenActivity(activity)}
                        type="button"
                      >
                        {resume
                          ? isKorean
                            ? "이어서 수정"
                            : "Continue editing"
                          : isKorean
                            ? "메뉴 보기"
                            : "Open menu"}
                        <span className={adminSharedStyles.srOnly}>
                          {" "}
                          · {sectionShortLabels[locale][activity.section]}
                        </span>
                      </button>
                    </AdminNotice>
                  </li>
                );
              }
              return (
                <li
                  className={styles.operationRow}
                  data-status={activity.status}
                  key={activity.key}
                >
                  <time dateTime={new Date(activity.at).toISOString()}>
                    {new Intl.DateTimeFormat(isKorean ? "ko-KR" : "en-US", {
                      timeZone: "Asia/Seoul",
                      hour: "2-digit",
                      minute: "2-digit",
                      hour12: false,
                    }).format(activity.at)}
                    <small>KST</small>
                  </time>
                  <div
                    className={styles.operationIcon}
                    data-tone={operationIconTone[activity.section]}
                  >
                    <AdminMenuIcon section={activity.section} />
                  </div>
                  <div className={adminSharedStyles.operationDescription}>
                    <strong>
                      {sectionShortLabels[locale][activity.section]}{" "}
                      {isKorean ? "작업" : "task"}
                    </strong>
                    <span className={styles.operationStatus}>
                      {operationStatusLabels[locale][activity.status]}
                    </span>
                    <p>{localizedText(activity.detail, locale)}</p>
                    {activity.editorId && !resume ? (
                      <small>
                        {isKorean
                          ? "편집 초안은 더 이상 열려 있지 않습니다. 상품 목록에서 확인하세요."
                          : "The edit draft is no longer open. Check the product list."}
                      </small>
                    ) : null}
                  </div>
                  <button
                    className={styles.secondaryButton}
                    onClick={() => onOpenActivity(activity)}
                    type="button"
                  >
                    {resume
                      ? isKorean
                        ? "이어서 수정"
                        : "Continue editing"
                      : isKorean
                        ? "메뉴 보기"
                        : "Open menu"}
                    <span className={adminSharedStyles.srOnly}>
                      {" "}
                      · {sectionShortLabels[locale][activity.section]}
                    </span>
                  </button>
                </li>
              );
            })}
          </ul>
        )}
      </section>
      <div className={styles.overviewSecondaryGrid}>
        <MetricCard
          icon="members"
          label={copy.adminOverviewNewMembers}
          value={formatCount(metrics?.todayNewMemberCount)}
          note={metricNote(
            metrics?.todayNewMemberCount,
            copy.adminOverviewNewMembersNote,
          )}
        />
        <MetricCard
          icon="coupons"
          label={isKorean ? "등록 쿠폰" : "Registered coupons"}
          value={formatCount(metrics?.activeCouponCount)}
          note={metricNote(
            metrics?.activeCouponCount,
            copy.adminOverviewIssuedCouponsNote,
          )}
        />
        <MetricCard
          icon="marketing"
          label={copy.adminOverviewMarketingAudience}
          value={formatCount(metrics?.marketingConsentCount)}
          note={metricNote(
            metrics?.marketingConsentCount,
            copy.adminOverviewMarketingAudienceNote,
          )}
        />
      </div>
      <details className={adminSharedStyles.overviewHelp}>
        <summary>{isKorean ? "집계 기준·개인정보 안내" : "Metrics & privacy"}</summary>
        <p>
          {isKorean
            ? "오늘 주문은 오늘(KST) 생성된 주문 건수로 결제 여부와 무관합니다. 오늘 매출과 판매 수량은 현재 결제완료(PAID) 상태이며 오늘(KST) 결제된 온라인 주문 기준입니다. 오프라인을 포함한 매출은 매출·일마감에서 확인하세요. 등록 쿠폰에는 초안과 일시중지 쿠폰도 포함됩니다. 제공되지 않은 지표는 0이 아닌 집계 준비 중으로 표시합니다."
            : "Today's orders count orders created today (KST), regardless of payment status. Revenue and units cover online orders currently PAID and paid today (KST). Open Sales & day close for totals including offline sales. Registered coupons include drafts and paused coupons. Unavailable metrics are not shown as zero."}
        </p>
        <p>
          {isKorean
            ? "회원 정보와 수신 동의는 관리자 권한을 확인한 API에서만 조회합니다. 마케팅 대상은 수신 동의 프로필 집계이며 채널별 발송 가능 수신자 수가 아닙니다."
            : "Member information and consent are loaded only through the administrator-authorized API. The marketing audience counts opted-in profiles, not recipients verified for delivery on each channel."}
        </p>
      </details>
    </div>
  );
}
