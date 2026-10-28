"use client";

import { useState, useSyncExternalStore } from "react";
import { useLocale } from "@/contexts/locale-context";
import type { Locale } from "@/types/store";
import type {
  AdminCatalogListItem,
  AdminDashboardActions,
  AdminOcrRecognitionResult,
} from "@/lib/admin-ui/types";
import {
  buildOcrIntakePlan,
  executeOcrIntakePlan,
  OcrInventoryPlanError,
  type OcrIntakePlan,
  type OcrIntakeSelection,
} from "@/lib/admin-ui/ocr-inventory-commit";
import {
  findOcrIntakeMatches,
  getOcrIntakeNewProductValidationMessage,
  OCR_INTAKE_CATEGORIES,
  type OcrIntakeMatch,
  type OcrIntakeNewProduct,
} from "@/lib/admin-ui/ocr-intake-matching";
import styles from "./admin-dashboard.module.css";
import inventoryStyles from "./ocr-inventory-commit.module.css";

export type OcrInventoryAttempt = Readonly<{
  plan: OcrIntakePlan;
  status: "running" | "complete" | "stopped";
  result?: Awaited<ReturnType<typeof executeOcrIntakePlan>>;
}>;

/** One workspace-owned ledger survives panel unmounts and notifies returning panels. */
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

type RowDraft = Readonly<{
  kind: "existing" | "new";
  productId: string;
  referenceProductId: string;
  sku: string;
  name: string;
  brandName: string;
  option: string;
  price: string;
  category: string;
  confirmed: boolean;
}>;

type Notice = string | Readonly<Record<Locale, string>>;

/** Saving an OCR review does not mutate catalog products: intake is a separate confirmation. */
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
    // Synchronous workspace ledger blocks double clicks/remounts before hashing or any write.
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
            {job.rows.map((row, index) => {
              const draft = drafts[row.id];
              const number = index + 1;
              const matches = findOcrIntakeMatches(
                draft.kind === "new"
                  ? {
                      productName: draft.name,
                      brand: draft.brandName,
                      option: draft.option,
                    }
                  : row,
                products,
                { productId: draft.referenceProductId, sku: draft.sku },
              );
              const blockedNew =
                matches.candidates.length > 0 || matches.basis === "unresolved-id";
              const newValidation = getOcrIntakeNewProductValidationMessage(
                newProduct(draft),
                locale,
              );
              const rowReady =
                loaded &&
                (draft.kind === "existing"
                  ? products.some((product) => product.id === draft.productId)
                  : !blockedNew && !newValidation);
              return (
                <fieldset
                  className={inventoryStyles.row}
                  key={row.id}
                  disabled={loading || !available}
                >
                  <legend>
                    {number}. {row.productName} ·{" "}
                    {isKorean ? `입고 ${row.quantity}개` : `Receive ${row.quantity}`}
                  </legend>
                  <p>
                    {isKorean
                      ? `브랜드 ${row.brand || "미확인"} · 옵션 ${row.option || "없음/미확인"}`
                      : `Brand ${row.brand || "Unknown"} · Option ${row.option || "None/Unknown"}`}
                  </p>
                  <div className={inventoryStyles.fields}>
                    <label>
                      {isKorean ? `입고 방식 ${number}` : `Receiving method ${number}`}
                      <select
                        aria-label={
                          isKorean
                            ? `입고 방식 ${number}`
                            : `Receiving method ${number}`
                        }
                        value={draft.kind}
                        onChange={(event) =>
                          changeDraft(row.id, {
                            kind: event.target.value as RowDraft["kind"],
                          })
                        }
                      >
                        <option value="existing">
                          {isKorean
                            ? "기존 상품에 입고 추가"
                            : "Add to an existing product"}
                        </option>
                        <option value="new">
                          {isKorean ? "없는 상품 신규 등록" : "Register a new product"}
                        </option>
                      </select>
                    </label>
                    <label>
                      {isKorean
                        ? `정확한 상품 ID ${number}`
                        : `Exact product ID ${number}`}
                      <input
                        aria-label={
                          isKorean
                            ? `정확한 상품 ID ${number}`
                            : `Exact product ID ${number}`
                        }
                        value={draft.referenceProductId}
                        maxLength={96}
                        onChange={(event) =>
                          changeDraft(row.id, {
                            referenceProductId: event.target.value,
                            productId: "",
                          })
                        }
                        autoComplete="off"
                      />
                    </label>
                    <label>
                      {isKorean ? `정확한 SKU ${number}` : `Exact SKU ${number}`}
                      <input
                        aria-label={
                          isKorean ? `정확한 SKU ${number}` : `Exact SKU ${number}`
                        }
                        value={draft.sku}
                        maxLength={80}
                        onChange={(event) =>
                          changeDraft(row.id, {
                            sku: event.target.value,
                            productId: "",
                          })
                        }
                        autoComplete="off"
                      />
                    </label>
                  </div>
                  {loaded ? (
                    <p role="status">
                      {matchMessage(matches, locale)}
                      {matches.candidates.length
                        ? isKorean
                          ? " · 자동 연결하지 않습니다. 기존 상품을 직접 선택해 주세요."
                          : " · Not linked automatically. Select the existing product yourself."
                        : ""}
                    </p>
                  ) : (
                    <p>
                      {isKorean
                        ? "상품 목록을 먼저 불러와 중복 후보를 확인해 주세요."
                        : "Load the product list first to check duplicate candidates."}
                    </p>
                  )}
                  {draft.kind === "existing" ? (
                    <label>
                      {isKorean ? "반영할 기존 상품" : "Existing product to update"}
                      <select
                        aria-label={
                          isKorean
                            ? `재고 상품 선택 ${number}`
                            : `Stock product ${number}`
                        }
                        disabled={!loaded || products.length === 0}
                        value={draft.productId}
                        onChange={(event) =>
                          changeDraft(row.id, { productId: event.target.value })
                        }
                      >
                        <option value="">
                          {isKorean ? "상품을 선택해 주세요" : "Select a product"}
                        </option>
                        {products.map((product) => (
                          <option key={product.id} value={product.id}>
                            {matches.candidates.some(
                              (candidate) => candidate.id === product.id,
                            )
                              ? isKorean
                                ? "후보 · "
                                : "Candidate · "
                              : ""}
                            {product.name} · {product.sku || product.id} ·{" "}
                            {isKorean ? "재고" : "Stock"} {product.stock}
                          </option>
                        ))}
                      </select>
                    </label>
                  ) : (
                    <>
                      <p>
                        {isKorean
                          ? "신규 · 비공개 초안(DRAFT). 입고 수량이 최초 재고가 되며 자동 공개하지 않습니다. SKU 입력 시 신규 상품에 함께 저장합니다."
                          : "New · Private draft (DRAFT). The received quantity becomes the initial stock and the product is not published automatically. An entered SKU is saved with the new product."}
                      </p>
                      {blockedNew ? (
                        <p role="alert">
                          {isKorean
                            ? "기존 상품 또는 중복 후보가 있어 신규 등록할 수 없습니다."
                            : "An existing product or duplicate candidate exists, so it cannot be registered as new."}
                        </p>
                      ) : null}
                      <div className={inventoryStyles.fields}>
                        <label>
                          {isKorean
                            ? `신규 상품명 ${number}`
                            : `New product name ${number}`}
                          <input
                            aria-label={
                              isKorean
                                ? `신규 상품명 ${number}`
                                : `New product name ${number}`
                            }
                            value={draft.name}
                            maxLength={160}
                            required
                            onChange={(event) =>
                              changeDraft(row.id, { name: event.target.value })
                            }
                          />
                        </label>
                        <label>
                          {isKorean ? `신규 브랜드 ${number}` : `New brand ${number}`}
                          <input
                            aria-label={
                              isKorean ? `신규 브랜드 ${number}` : `New brand ${number}`
                            }
                            value={draft.brandName}
                            maxLength={100}
                            required
                            onChange={(event) =>
                              changeDraft(row.id, { brandName: event.target.value })
                            }
                          />
                        </label>
                        <label>
                          {isKorean ? `신규 옵션 ${number}` : `New option ${number}`}
                          <input
                            aria-label={
                              isKorean ? `신규 옵션 ${number}` : `New option ${number}`
                            }
                            value={draft.option}
                            maxLength={50}
                            onChange={(event) =>
                              changeDraft(row.id, { option: event.target.value })
                            }
                          />
                          <small>
                            {isKorean
                              ? "옵션이 없으면 빈칸. 옵션별 재고는 생성하지 않습니다."
                              : "Leave empty if there is no option. Stock per option is not created."}
                          </small>
                        </label>
                        <label>
                          {isKorean ? `신규 가격 ${number}` : `New price ${number}`}
                          <input
                            aria-label={
                              isKorean ? `신규 가격 ${number}` : `New price ${number}`
                            }
                            value={draft.price}
                            inputMode="numeric"
                            maxLength={9}
                            required
                            onChange={(event) =>
                              changeDraft(row.id, { price: event.target.value })
                            }
                          />
                          <small>
                            {isKorean
                              ? "필수 · 원 단위 정수, 0~100,000,000원"
                              : "Required · Whole KRW, 0–100,000,000"}
                          </small>
                        </label>
                        <label>
                          {isKorean
                            ? `신규 카테고리 ${number}`
                            : `New category ${number}`}
                          <select
                            aria-label={
                              isKorean
                                ? `신규 카테고리 ${number}`
                                : `New category ${number}`
                            }
                            value={draft.category}
                            required
                            onChange={(event) =>
                              changeDraft(row.id, { category: event.target.value })
                            }
                          >
                            <option value="">
                              {isKorean ? "카테고리 선택" : "Select category"}
                            </option>
                            {OCR_INTAKE_CATEGORIES.map((category) => (
                              <option key={category} value={category}>
                                {category}
                              </option>
                            ))}
                          </select>
                        </label>
                      </div>
                      {loaded && !blockedNew && newValidation ? (
                        <small>{newValidation}</small>
                      ) : null}
                    </>
                  )}
                  <label className={inventoryStyles.confirm}>
                    <input
                      type="checkbox"
                      checked={draft.confirmed}
                      disabled={!rowReady}
                      onChange={(event) => {
                        setDrafts((current) => ({
                          ...current,
                          [row.id]: {
                            ...current[row.id],
                            confirmed: event.target.checked,
                          },
                        }));
                        setPlan(null);
                        setConfirmed(false);
                      }}
                    />
                    {isKorean
                      ? `입고 행 ${number} 내용을 확인했습니다`
                      : `I checked receiving row ${number}`}
                  </label>
                </fieldset>
              );
            })}
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

function newProduct(draft: RowDraft): OcrIntakeNewProduct {
  return {
    name: draft.name,
    brandName: draft.brandName,
    option: draft.option,
    price: /^[0-9]{1,9}$/.test(draft.price) ? Number(draft.price) : NaN,
    category: draft.category,
    ...(draft.sku.trim() ? { sku: draft.sku } : {}),
  };
}
function matchMessage(match: OcrIntakeMatch, locale: Locale): string {
  const isKorean = locale === "ko";
  const count = match.candidates.length;
  switch (match.basis) {
    case "product-id":
      return isKorean
        ? `정확한 상품 ID 후보 ${count}개`
        : `${count} exact product ID candidates`;
    case "sku":
      return isKorean ? `정확한 SKU 후보 ${count}개` : `${count} exact SKU candidates`;
    case "composite":
      return isKorean
        ? `이름·브랜드·옵션 일치 후보 ${count}개`
        : `${count} candidates matching name, brand and option`;
    case "possible":
      return isKorean
        ? `정보가 부족한 중복 후보 ${count}개`
        : `${count} possible duplicates with missing details`;
    case "unresolved-id":
      return isKorean
        ? "해당 상품 ID를 찾지 못했습니다. ID를 수정하거나 지워 주세요."
        : "That product ID was not found. Fix or clear the ID.";
    default:
      return isKorean
        ? "일치 후보 없음 · 신규 입력 가능"
        : "No matching candidates · New entry allowed";
  }
}
