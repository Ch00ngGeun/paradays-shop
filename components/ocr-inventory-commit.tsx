// 역할: 입고 OCR 검토본을 실제 재고에 반영하는 패널. 재고 상품을 불러와 행마다 기존 상품 입고·신규 등록을 정하고, 반영 계획을 확인받아 한 번만 실행하며 결과를 표로 보여 줍니다.
"use client";

import { useState, useSyncExternalStore } from "react";
import { useLocale } from "@/contexts/locale-context";
import type { Locale } from "@/types/store";
import type {
  AdminCatalogListItem,
  AdminDashboardActions,
  AdminOcrRecognitionResult,
} from "@/lib/admin-ui/types";
import { OcrInventoryPlanError } from "@/lib/admin-ui/ocr-inventory-commit";
import {
  buildOcrIntakePlan,
  executeOcrIntakePlan,
  type OcrIntakePlan,
  type OcrIntakeSelection,
} from "@/lib/admin-ui/ocr-inventory-commit-intake";
import styles from "./admin-dashboard.module.css";
import inventoryStyles from "./ocr-inventory-commit.module.css";
import { newProduct, OcrInventoryRow, type RowDraft } from "./ocr-inventory-commit-row";

export type OcrInventoryAttempt = Readonly<{
  plan: OcrIntakePlan;
  status: "running" | "complete" | "stopped";
  result?: Awaited<ReturnType<typeof executeOcrIntakePlan>>;
}>;

/** 워크스페이스가 가진 하나의 시도 기록이라, 패널이 언마운트돼도 남고 다시 붙은 패널에 알립니다. */
export class OcrInventoryAttemptStore {
  private readonly records = new Map<string, OcrInventoryAttempt>();
  private readonly listeners = new Set<() => void>();
  get = (jobId: string) => this.records.get(jobId);
  has = (jobId: string) => this.records.has(jobId);
  set = (jobId: string, attempt: OcrInventoryAttempt) => {
    this.records.set(jobId, attempt);
    for (const listener of this.listeners) listener();
  };
  subscribe = (listener: () => void) => {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  };
}

type Notice = string | Readonly<Record<Locale, string>>;

/** OCR 검토본 저장은 상품을 바꾸지 않으며, 입고 반영은 별도 확인 단계입니다. */
export function OcrInventoryCommitPanel({
  job,
  actions,
  attempts,
  onProductUpdated,
  onBusyChange,
}: Readonly<{
  job: AdminOcrRecognitionResult;
  actions?: AdminDashboardActions;
  attempts: OcrInventoryAttemptStore;
  onProductUpdated: (product: AdminCatalogListItem) => void;
  onBusyChange: (busy: boolean) => void;
}>) {
  const [products, setProducts] = useState<readonly AdminCatalogListItem[]>([]);
  const [loaded, setLoaded] = useState(false);
  const [drafts, setDrafts] = useState<Readonly<Record<string, RowDraft>>>(() =>
    Object.fromEntries(
      job.rows.map((row) => [
        row.id,
        {
          kind: "existing",
          productId: "",
          referenceProductId: "",
          sku: "",
          name: row.productName,
          brandName: row.brand,
          option: row.option,
          price: "",
          category: "",
          confirmed: false,
        },
      ]),
    ),
  );
  const [plan, setPlan] = useState<OcrIntakePlan | null>(null);
  const [confirmed, setConfirmed] = useState(false);
  const [loading, setLoading] = useState(false);
  const [notice, setNotice] = useState<Notice>("");
  const { locale } = useLocale();
  const isKorean = locale === "ko";
  const attempt = useSyncExternalStore(
    attempts.subscribe,
    () => attempts.get(job.jobId),
    () => undefined,
  );
  const locked = Boolean(attempt || attempts.has(job.jobId));
  const available = Boolean(actions?.listCatalogProducts && actions?.applyOcrIntake);

  const changeDraft = (id: string, patch: Partial<RowDraft>) => {
    setDrafts((current) => ({
      ...current,
      [id]: { ...current[id], ...patch, confirmed: false },
    }));
    setPlan(null);
    setConfirmed(false);
    setNotice("");
  };
  const loadProducts = async (preview: boolean) => {
    if (!actions?.listCatalogProducts || loading || locked) return;
    setLoading(true);
    setPlan(null);
    setConfirmed(false);
    setNotice("");
    try {
      const current = await actions.listCatalogProducts();
      setProducts(current);
      setLoaded(true);
      if (preview) {
        const selection: OcrIntakeSelection = Object.fromEntries(
          job.rows.map((row) => {
            const draft = drafts[row.id];
            return [
              row.id,
              draft.kind === "existing"
                ? {
                    kind: "existing",
                    productId: draft.productId,
                    confirmed: draft.confirmed,
                  }
                : {
                    kind: "new",
                    product: newProduct(draft),
                    confirmed: draft.confirmed,
                  },
            ];
          }),
        );
        setPlan(
          buildOcrIntakePlan(
            {
              job,
              products: current,
              selection,
              references: Object.fromEntries(
                job.rows.map((row) => [
                  row.id,
                  {
                    productId: drafts[row.id].referenceProductId,
                    sku: drafts[row.id].sku,
                  },
                ]),
              ),
            },
            locale,
          ),
        );
      } else {
        setDrafts((existing) =>
          Object.fromEntries(
            Object.entries(existing).map(([id, draft]) => [
              id,
              { ...draft, confirmed: false },
            ]),
          ),
        );
        if (!current.length)
          setNotice({
            ko: "등록된 상품이 없습니다. 신규 등록을 선택하고 가격·카테고리를 입력해 주세요.",
            en: "There are no registered products. Choose new registration and enter a price and category.",
          });
      }
    } catch (error) {
      setNotice(
        error instanceof OcrInventoryPlanError
          ? error.message
          : {
              ko: "입고 반영을 준비하지 못했습니다. 상품 목록과 관리자 권한을 확인해 주세요.",
              en: "Could not prepare the receipt. Check the product list and admin permissions.",
            },
      );
    } finally {
      setLoading(false);
    }
  };
  const commit = async () => {
    // 워크스페이스 시도 기록을 동기로 먼저 확인해, 해시 계산이나 쓰기 전에 중복 클릭·재마운트를 막습니다.
    if (!plan || !confirmed || !actions?.applyOcrIntake || attempts.has(job.jobId))
      return;
    attempts.set(job.jobId, { plan, status: "running" });
    onBusyChange(true);
    try {
      const result = await executeOcrIntakePlan(
        plan,
        {
          applyOcrIntake: actions.applyOcrIntake,
          onProductUpdated,
        },
        locale,
      );
      attempts.set(job.jobId, { plan, status: result.status, result });
    } catch {
      attempts.set(job.jobId, { plan, status: "stopped" });
    } finally {
      onBusyChange(false);
    }
  };

  const displayedPlan = attempt?.plan ?? plan;
  const existingCount =
    displayedPlan?.items.filter((item) => item.kind === "existing").length ?? 0;
  const newCount =
    displayedPlan?.items.filter((item) => item.kind === "new").length ?? 0;
  return (
    <section
      className={`${styles.ocrSecurity} ${inventoryStyles.panel}`}
      aria-label={isKorean ? "재고 반영" : "Apply to stock"}
    >
      <h3>{isKorean ? "재고 반영" : "Apply to stock"}</h3>
      <p>
        {isKorean
          ? "검토초안은 저장됐습니다. 아래에서 기존 상품은 현재 재고에 입고 수량을 더하고, 없는 상품은 가격·카테고리를 입력해 비공개 초안으로 등록합니다. 상품 등록과 실제 재고 변경은 별도 확인 후에만 실행합니다."
          : "The review draft is saved. Below, received quantities are added to existing products' current stock, and missing products are registered as private drafts after you enter a price and category. Product registration and actual stock changes run only after a separate confirmation."}
      </p>
      <p>
        {isKorean
          ? "재고는 상품 단위입니다. 같은 기존 상품의 행은 수량을 합산하며 옵션별 재고로 나뉘지 않습니다. 이 단계는 PC 초안 저장과 달리 운영 상품의 실제 재고를 변경합니다."
          : "Stock is per product. Rows for the same existing product are summed and not split into per-option stock. Unlike saving the PC draft, this step changes the actual stock of live products."}
      </p>
      <details>
        <summary>
          {isKorean ? "상품 중복 판정 기준" : "Duplicate product rules"}
        </summary>
        <p>
          {isKorean
            ? "상품 ID는 정확히, SKU는 앞뒤 공백·한글 조합만 정리한 뒤 대소문자를 구분해 비교합니다. 이름·브랜드·옵션은 한글 조합(NFC), 앞뒤·반복 공백, 대소문자만 정리합니다. 한글 단어 사이 공백·구두점은 유지하며 오타를 추측하지 않습니다. 후보가 하나여도 자동 연결하지 않습니다."
            : "Product IDs are compared exactly. SKUs are compared case-sensitively after trimming spaces and normalizing Hangul composition. Names, brands and options are normalized only for Hangul composition (NFC), leading, trailing and repeated spaces, and letter case. Spaces and punctuation between Hangul words are kept, and typos are not guessed. Even a single candidate is never linked automatically."}
        </p>
      </details>
      {!available ? (
        <p role="alert">
          {isKorean
            ? "입고 저장 API가 연결되지 않았습니다. 실제 상품·재고는 변경하지 않습니다."
            : "The receiving save API is not connected. Actual products and stock are not changed."}
        </p>
      ) : null}
      {!locked ? (
        <>
          <button
            className={styles.secondaryButton}
            disabled={!available || loading}
            onClick={() => void loadProducts(false)}
            type="button"
          >
            {isKorean ? "재고 상품 불러오기" : "Load stock products"}
          </button>
          <div className={inventoryStyles.rows}>
            {job.rows.map((row, index) => (
              <OcrInventoryRow
                key={row.id}
                row={row}
                index={index}
                products={products}
                loaded={loaded}
                drafts={drafts}
                setDrafts={setDrafts}
                setPlan={setPlan}
                setConfirmed={setConfirmed}
                loading={loading}
                locale={locale}
                isKorean={isKorean}
                available={available}
                changeDraft={changeDraft}
              />
            ))}
          </div>
          <button
            className={styles.secondaryButton}
            disabled={!available || loading || !loaded}
            onClick={() => void loadProducts(true)}
            type="button"
          >
            {loading
              ? isKorean
                ? "상품 확인 중…"
                : "Checking products…"
              : isKorean
                ? "재고 반영 미리보기"
                : "Preview stock changes"}
          </button>
        </>
      ) : null}
      {notice ? (
        <p className={styles.noticeError} role="alert">
          {typeof notice === "string" ? notice : notice[locale]}
        </p>
      ) : null}
      {displayedPlan ? (
        <>
          <p>
            {isKorean
              ? `입고 추가 ${existingCount}건 · 신규 비공개 등록 ${newCount}건. 기존 재고를 수량으로 덮어쓰지 않습니다.`
              : `Add stock ${existingCount} · New private products ${newCount}. Existing stock is not overwritten by the quantity.`}
          </p>
          <div className={styles.ocrTableWrap}>
            <table className={inventoryStyles.table}>
              <caption>
                {isKorean
                  ? "실제 상품 등록·재고 변경 미리보기"
                  : "Preview of actual product registration and stock changes"}
              </caption>
              <thead>
                <tr>
                  <th>{isKorean ? "상품 / 작업" : "Product / Action"}</th>
                  <th>{isKorean ? "현재 재고" : "Current stock"}</th>
                  <th>{isKorean ? "입고 수량" : "Received"}</th>
                  <th>{isKorean ? "반영 재고" : "Resulting stock"}</th>
                  <th>{isKorean ? "상태" : "Status"}</th>
                </tr>
              </thead>
              <tbody>
                {displayedPlan.items.map((item) => {
                  const result = attempt?.result?.items.find(
                    (entry) => entry.itemId === item.itemId,
                  );
                  const [ko, en] = !attempt
                    ? ["확인 대기", "Awaiting confirmation"]
                    : result?.status === "applied"
                      ? result.replayed
                        ? [
                            "이미 반영됨 · 목록 새로 확인",
                            "Already applied · Reload the list",
                          ]
                        : ["반영 완료", "Applied"]
                      : result?.status === "failed"
                        ? ["실패 · 반영 안 됨", "Failed · Not applied"]
                        : result?.status === "uncertain"
                          ? [
                              "응답 불명확 · 상품·재고 확인 필요",
                              "Unclear response · Check products and stock",
                            ]
                          : result?.status === "pending"
                            ? ["미반영", "Not applied"]
                            : attempt.status === "running"
                              ? ["처리 중", "Processing"]
                              : ["상품·재고 확인 필요", "Check products and stock"];
                  const label = isKorean ? ko : en;
                  return (
                    <tr key={item.itemId}>
                      <td>
                        {item.productName}
                        <small>
                          {item.kind === "new"
                            ? isKorean
                              ? `신규 · 비공개 초안 · ${item.product.price.toLocaleString("ko-KR")}원 · ${item.product.category}`
                              : `New · Private draft · KRW ${item.product.price.toLocaleString("en-US")} · ${item.product.category}`
                            : isKorean
                              ? `기존 상품 · 입고 추가 · ${item.sku || item.productId}`
                              : `Existing product · Add stock · ${item.sku || item.productId}`}
                        </small>
                        {result?.productId ? (
                          <small>
                            {isKorean ? "상품 ID" : "Product ID"}: {result.productId}
                          </small>
                        ) : null}
                      </td>
                      <td>{item.beforeStock}</td>
                      <td>{item.quantity}</td>
                      <td>{item.nextStock}</td>
                      <td>
                        {label}
                        {result?.message ? <small>{result.message}</small> : null}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
          {!locked ? (
            <label className={inventoryStyles.confirm}>
              <input
                type="checkbox"
                checked={confirmed}
                onChange={(event) => setConfirmed(event.target.checked)}
              />
              {isKorean
                ? "실제 상품 등록·재고 변경 내용을 확인했습니다"
                : "I checked the actual product registration and stock changes"}
            </label>
          ) : null}
          <button
            className={styles.primaryButton}
            disabled={!confirmed || locked || loading}
            onClick={() => void commit()}
            type="button"
          >
            {attempt?.status === "running"
              ? isKorean
                ? "입고 반영 중…"
                : "Applying receipt…"
              : isKorean
                ? "확인한 입고 반영"
                : "Apply confirmed receipt"}
          </button>
        </>
      ) : null}
      {attempt ? (
        <p
          role={attempt.status === "stopped" ? "alert" : "status"}
          className={
            attempt.status === "complete" ? styles.noticeSuccess : styles.noticeError
          }
        >
          {attempt.status === "complete"
            ? isKorean
              ? "입고 반영이 완료됐습니다. 상품·재고 목록을 다시 불러와 최신 값을 확인하세요. 신규 상품은 비공개 초안입니다. 이 검토본은 다시 반영하지 않습니다."
              : "The receipt is applied. Reload the product and stock list to check the latest values. New products are private drafts. This review will not be applied again."
            : attempt.status === "running"
              ? isKorean
                ? "확인한 입고를 반영 중입니다. 화면을 닫지 마세요."
                : "Applying the confirmed receipt. Do not close this screen."
              : isKorean
                ? "입고 반영이 중단됐습니다. 완료·미반영·응답 불명확 상태와 실제 상품·재고를 확인하세요. 자동 재시도하지 않습니다."
                : "The receipt stopped. Check the applied, not applied and unclear items and the actual products and stock. It is not retried automatically."}
        </p>
      ) : null}
      <p>
        {isKorean
          ? "이 작업 화면은 같은 검토본의 재반영을 잠급니다. 서버도 검토본과 행별 작업 키로 중복 저장을 방지합니다. 새로고침·다시 인식하기 전에는 실제 상품·재고 목록에서 반영 여부를 확인해 주세요."
          : "This screen locks the same review from being applied again. The server also prevents duplicate saves with the review and per-row operation keys. Before refreshing or recognizing again, check in the actual product and stock list whether it was applied."}
      </p>
    </section>
  );
}
