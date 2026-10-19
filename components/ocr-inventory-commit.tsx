"use client";

import { useState, useSyncExternalStore } from "react";
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
  const [notice, setNotice] = useState("");
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
          buildOcrIntakePlan({
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
          }),
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
          setNotice(
            "등록된 상품이 없습니다. 신규 등록을 선택하고 가격·카테고리를 입력해 주세요.",
          );
      }
    } catch (error) {
      setNotice(
        error instanceof OcrInventoryPlanError
          ? error.message
          : "입고 반영을 준비하지 못했습니다. 상품 목록과 관리자 권한을 확인해 주세요.",
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
      const result = await executeOcrIntakePlan(plan, {
        applyOcrIntake: actions.applyOcrIntake,
        onProductUpdated,
      });
      attempts.set(job.jobId, { plan, status: result.status, result });
    } catch {
      attempts.set(job.jobId, { plan, status: "stopped" });
    } finally {
      onBusyChange(false);
    }
  };

  const displayedPlan = attempt?.plan ?? plan;
  return (
    <section
      className={`${styles.ocrSecurity} ${inventoryStyles.panel}`}
      aria-label="재고 반영"
    >
      <h3>재고 반영</h3>
      <p>
        검토초안은 저장됐습니다. 아래에서 기존 상품은 현재 재고에 입고 수량을 더하고,
        없는 상품은 가격·카테고리를 입력해 비공개 초안으로 등록합니다. 상품 등록과 실제
        재고 변경은 별도 확인 후에만 실행합니다.
      </p>
      <p>
        재고는 상품 단위입니다. 같은 기존 상품의 행은 수량을 합산하며 옵션별 재고로
        나뉘지 않습니다. 이 단계는 PC 초안 저장과 달리 운영 상품의 실제 재고를
        변경합니다.
      </p>
      <details>
        <summary>상품 중복 판정 기준</summary>
        <p>
          상품 ID는 정확히, SKU는 앞뒤 공백·한글 조합만 정리한 뒤 대소문자를 구분해
          비교합니다. 이름·브랜드·옵션은 한글 조합(NFC), 앞뒤·반복 공백, 대소문자만
          정리합니다. 한글 단어 사이 공백·구두점은 유지하며 오타를 추측하지 않습니다.
          후보가 하나여도 자동 연결하지 않습니다.
        </p>
      </details>
      {!available ? (
        <p role="alert">
          입고 저장 API가 연결되지 않았습니다. 실제 상품·재고는 변경하지 않습니다.
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
            재고 상품 불러오기
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
                    {number}. {row.productName} · 입고 {row.quantity}개
                  </legend>
                  <p>
                    브랜드 {row.brand || "미확인"} · 옵션 {row.option || "없음/미확인"}
                  </p>
                  <div className={inventoryStyles.fields}>
                    <label>
                      입고 방식 {number}
                      <select
                        aria-label={`입고 방식 ${number}`}
                        value={draft.kind}
                        onChange={(event) =>
                          changeDraft(row.id, {
                            kind: event.target.value as RowDraft["kind"],
                          })
                        }
                      >
                        <option value="existing">기존 상품에 입고 추가</option>
                        <option value="new">없는 상품 신규 등록</option>
                      </select>
                    </label>
                    <label>
                      정확한 상품 ID {number}
                      <input
                        aria-label={`정확한 상품 ID ${number}`}
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
                      정확한 SKU {number}
                      <input
                        aria-label={`정확한 SKU ${number}`}
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
                      {matchMessage(matches)}
                      {matches.candidates.length
                        ? " · 자동 연결하지 않습니다. 기존 상품을 직접 선택해 주세요."
                        : ""}
                    </p>
                  ) : (
                    <p>상품 목록을 먼저 불러와 중복 후보를 확인해 주세요.</p>
                  )}
                  {draft.kind === "existing" ? (
                    <label>
                      반영할 기존 상품
                      <select
                        aria-label={`재고 상품 선택 ${number}`}
                        disabled={!loaded || products.length === 0}
                        value={draft.productId}
                        onChange={(event) =>
                          changeDraft(row.id, { productId: event.target.value })
                        }
                      >
                        <option value="">상품을 선택해 주세요</option>
                        {products.map((product) => (
                          <option key={product.id} value={product.id}>
                            {matches.candidates.some(
                              (candidate) => candidate.id === product.id,
                            )
                              ? "후보 · "
                              : ""}
                            {product.name} · {product.sku || product.id} · 재고{" "}
                            {product.stock}
                          </option>
                        ))}
                      </select>
                    </label>
                  ) : (
                    <>
                      <p>
                        신규 · 비공개 초안(DRAFT). 입고 수량이 최초 재고가 되며 자동
                        공개하지 않습니다. SKU 입력 시 신규 상품에 함께 저장합니다.
                      </p>
                      {blockedNew ? (
                        <p role="alert">
                          기존 상품 또는 중복 후보가 있어 신규 등록할 수 없습니다.
                        </p>
                      ) : null}
                      <div className={inventoryStyles.fields}>
                        <label>
                          신규 상품명 {number}
                          <input
                            aria-label={`신규 상품명 ${number}`}
                            value={draft.name}
                            maxLength={160}
                            required
                            onChange={(event) =>
                              changeDraft(row.id, { name: event.target.value })
                            }
                          />
                        </label>
                        <label>
                          신규 브랜드 {number}
                          <input
                            aria-label={`신규 브랜드 ${number}`}
                            value={draft.brandName}
                            maxLength={100}
                            required
                            onChange={(event) =>
                              changeDraft(row.id, { brandName: event.target.value })
                            }
                          />
                        </label>
                        <label>
                          신규 옵션 {number}
                          <input
                            aria-label={`신규 옵션 ${number}`}
                            value={draft.option}
                            maxLength={50}
                            onChange={(event) =>
                              changeDraft(row.id, { option: event.target.value })
                            }
                          />
                          <small>
                            옵션이 없으면 빈칸. 옵션별 재고는 생성하지 않습니다.
                          </small>
                        </label>
                        <label>
                          신규 가격 {number}
                          <input
                            aria-label={`신규 가격 ${number}`}
                            value={draft.price}
                            inputMode="numeric"
                            maxLength={9}
                            required
                            onChange={(event) =>
                              changeDraft(row.id, { price: event.target.value })
                            }
                          />
                          <small>필수 · 원 단위 정수, 0~100,000,000원</small>
                        </label>
                        <label>
                          신규 카테고리 {number}
                          <select
                            aria-label={`신규 카테고리 ${number}`}
                            value={draft.category}
                            required
                            onChange={(event) =>
                              changeDraft(row.id, { category: event.target.value })
                            }
                          >
                            <option value="">카테고리 선택</option>
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
                    입고 행 {number} 내용을 확인했습니다
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
            {loading ? "상품 확인 중…" : "재고 반영 미리보기"}
          </button>
        </>
      ) : null}
      {notice ? (
        <p className={styles.noticeError} role="alert">
          {notice}
        </p>
      ) : null}
      {displayedPlan ? (
        <>
          <p>
            입고 추가{" "}
            {displayedPlan.items.filter((item) => item.kind === "existing").length}건 ·
            신규 비공개 등록{" "}
            {displayedPlan.items.filter((item) => item.kind === "new").length}건. 기존
            재고를 수량으로 덮어쓰지 않습니다.
          </p>
          <div className={styles.ocrTableWrap}>
            <table className={inventoryStyles.table}>
              <caption>실제 상품 등록·재고 변경 미리보기</caption>
              <thead>
                <tr>
                  <th>상품 / 작업</th>
                  <th>현재 재고</th>
                  <th>입고 수량</th>
                  <th>반영 재고</th>
                  <th>상태</th>
                </tr>
              </thead>
              <tbody>
                {displayedPlan.items.map((item) => {
                  const result = attempt?.result?.items.find(
                    (entry) => entry.itemId === item.itemId,
                  );
                  const label = !attempt
                    ? "확인 대기"
                    : result?.status === "applied"
                      ? result.replayed
                        ? "이미 반영됨 · 목록 새로 확인"
                        : "반영 완료"
                      : result?.status === "failed"
                        ? "실패 · 반영 안 됨"
                        : result?.status === "uncertain"
                          ? "응답 불명확 · 상품·재고 확인 필요"
                          : result?.status === "pending"
                            ? "미반영"
                            : attempt.status === "running"
                              ? "처리 중"
                              : "상품·재고 확인 필요";
                  return (
                    <tr key={item.itemId}>
                      <td>
                        {item.productName}
                        <small>
                          {item.kind === "new"
                            ? `신규 · 비공개 초안 · ${item.product.price.toLocaleString("ko-KR")}원 · ${item.product.category}`
                            : `기존 상품 · 입고 추가 · ${item.sku || item.productId}`}
                        </small>
                        {result?.productId ? (
                          <small>상품 ID: {result.productId}</small>
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
              실제 상품 등록·재고 변경 내용을 확인했습니다
            </label>
          ) : null}
          <button
            className={styles.primaryButton}
            disabled={!confirmed || locked || loading}
            onClick={() => void commit()}
            type="button"
          >
            {attempt?.status === "running" ? "입고 반영 중…" : "확인한 입고 반영"}
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
            ? "입고 반영이 완료됐습니다. 상품·재고 목록을 다시 불러와 최신 값을 확인하세요. 신규 상품은 비공개 초안입니다. 이 검토본은 다시 반영하지 않습니다."
            : attempt.status === "running"
              ? "확인한 입고를 반영 중입니다. 화면을 닫지 마세요."
              : "입고 반영이 중단됐습니다. 완료·미반영·응답 불명확 상태와 실제 상품·재고를 확인하세요. 자동 재시도하지 않습니다."}
        </p>
      ) : null}
      <p>
        이 작업 화면은 같은 검토본의 재반영을 잠급니다. 서버도 검토본과 행별 작업 키로
        중복 저장을 방지합니다. 새로고침·다시 인식하기 전에는 실제 상품·재고 목록에서
        반영 여부를 확인해 주세요.
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
function matchMessage(match: OcrIntakeMatch): string {
  switch (match.basis) {
    case "product-id":
      return `정확한 상품 ID 후보 ${match.candidates.length}개`;
    case "sku":
      return `정확한 SKU 후보 ${match.candidates.length}개`;
    case "composite":
      return `이름·브랜드·옵션 일치 후보 ${match.candidates.length}개`;
    case "possible":
      return `정보가 부족한 중복 후보 ${match.candidates.length}개`;
    case "unresolved-id":
      return "해당 상품 ID를 찾지 못했습니다. ID를 수정하거나 지워 주세요.";
    default:
      return "일치 후보 없음 · 신규 입력 가능";
  }
}
