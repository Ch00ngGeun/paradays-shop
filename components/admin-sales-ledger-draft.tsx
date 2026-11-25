// 역할: 실제 매출 원장의 판매 전표 편집기. 상품 줄·수량·금액·결제 구분을 입력해 초안을 저장하고, 재고 반영 미리보기와 보류 초안 폐기(사유 입력)를 요청합니다.
"use client";
import type { Dispatch, SetStateAction } from "react";
import type { AdminCatalogListItem } from "@/lib/admin-ui/types";
import type { Locale } from "@/types/store";
import {
  type SaleEntry,
  type SalesCommand,
} from "@/lib/commerce/admin-sales-api-client";
import styles from "./admin-sales-ledger.module.css";
import { AdminNotice } from "./admin-status";
import {
  type Draft,
  type Row,
  initialTime,
  lineSum,
  methodLabels,
  methodOrder,
  money,
  today,
} from "./admin-sales-ledger-model";

export function SalesDraftEditor({
  isKorean,
  locale,
  products,
  day,
  draft,
  search,
  setSearch,
  setManualAmount,
  voidReason,
  setVoidReason,
  setObservedNow,
  selected,
  locked,
  open,
  run,
  updateDraft,
  updateRows,
  draftValid,
  unmatched,
  mismatched,
  unsaved,
  results,
}: Readonly<{
  isKorean: boolean;
  locale: Locale;
  products: readonly AdminCatalogListItem[];
  day: string;
  draft: Draft;
  search: string;
  setSearch: Dispatch<SetStateAction<string>>;
  setManualAmount: Dispatch<SetStateAction<boolean>>;
  voidReason: string;
  setVoidReason: Dispatch<SetStateAction<string>>;
  setObservedNow: Dispatch<SetStateAction<number>>;
  selected: SaleEntry | undefined;
  locked: boolean;
  open: boolean;
  run: (targetDay: string, command: SalesCommand, retry?: boolean) => Promise<void>;
  updateDraft: (patch: Partial<Draft>) => void;
  updateRows: (lines: Row[]) => void;
  draftValid: boolean;
  unmatched: boolean;
  mismatched: boolean;
  unsaved: boolean;
  results: readonly AdminCatalogListItem[];
}>) {
  return (
    <section
      className={styles.block}
      aria-label={isKorean ? "판매 전표 편집" : "Edit sales slip"}
    >
      <h3>
        {draft.expectedVersion
          ? isKorean
            ? "작성 중 전표 수정"
            : "Edit draft slip"
          : isKorean
            ? "새 판매 전표"
            : "New sales slip"}
      </h3>
      <p className={styles.muted}>
        {isKorean
          ? `전표 번호 ${draft.entryId} · 저장은 작성 중 상태이며 재고를 바꾸지 않습니다.`
          : `Slip number ${draft.entryId} · Saving keeps it as a draft and does not change stock.`}
      </p>
      <form
        onSubmit={(e) => {
          e.preventDefault();
          if (!draftValid) return;
          void run(day, {
            action: "save",
            ...draft,
            soldAt: `${draft.soldAt}+09:00`,
            amount: Number(draft.amount),
            lines: draft.lines.map((l) => ({
              ...l,
              quantity: Number(l.quantity),
              unitAmount: Number(l.unitAmount),
            })),
          });
        }}
      >
        <fieldset disabled={locked || !open} className={styles.fieldset}>
          <div className={styles.fields}>
            <label>
              {isKorean ? "판매일시 (한국 시간)" : "Sale date and time (Korea time)"}
              <input
                type="datetime-local"
                value={draft.soldAt}
                min={`${day}T00:00`}
                max={day === today() ? initialTime(day) : `${day}T23:59`}
                required
                onChange={(e) => {
                  setObservedNow(Date.now());
                  updateDraft({ soldAt: e.target.value });
                }}
              />
            </label>
            <label>
              {isKorean ? "결제 구분" : "Payment method"}
              <select
                value={draft.method}
                onChange={(e) =>
                  updateDraft({ method: e.target.value as Draft["method"] })
                }
              >
                {methodOrder.map((method) => (
                  <option key={method} value={method}>
                    {methodLabels[locale][method]}
                  </option>
                ))}
              </select>
            </label>
            <label>
              {isKorean ? "전표 참조번호" : "Slip reference number"}
              <input
                value={draft.reference}
                maxLength={64}
                required
                placeholder="CARD-001 / CASH-001 / TRANSFER-001"
                onChange={(e) => updateDraft({ reference: e.target.value })}
              />
            </label>
            <label>
              {isKorean ? "전표 금액" : "Slip amount"}
              <input
                type="number"
                min="1"
                max="100000000"
                step="1"
                required
                value={draft.amount}
                onChange={(e) => {
                  setManualAmount(true);
                  updateDraft({ amount: e.target.value });
                }}
              />
            </label>
            <label className={styles.wide}>
              {isKorean ? "메모" : "Memo"}
              <textarea
                value={draft.memo}
                maxLength={300}
                onChange={(e) => updateDraft({ memo: e.target.value })}
              />
            </label>
          </div>
          <div className={styles.matching}>
            <label>
              {isKorean ? "상품 이름 검색" : "Search product name"}
              <input
                value={search}
                onChange={(e) => setSearch(e.target.value)}
                placeholder={isKorean ? "상품명을 입력하세요" : "Enter a product name"}
              />
            </label>
            <div className={styles.searchResults}>
              {results.map((p) => (
                <button
                  type="button"
                  key={p.id}
                  disabled={draft.lines.length >= 20}
                  onClick={() => {
                    const options = p.sizes
                      .split(",")
                      .map((s) => s.trim())
                      .filter(Boolean);
                    updateRows([
                      ...draft.lines,
                      {
                        productId: p.id,
                        // 원장 서버는 제어 문자를 거부하므로 두 줄 상품명은 한 줄로 바꿉니다.
                        name: p.name.replace(/\s+/g, " ").trim(),
                        option: options.length === 1 ? options[0] : "",
                        quantity: "1",
                        unitAmount: String(p.price),
                      },
                    ]);
                    setSearch("");
                  }}
                >
                  {p.name} {isKorean ? "연결" : "link"}
                </button>
              ))}
            </div>
            <button
              type="button"
              disabled={draft.lines.length >= 20}
              onClick={() =>
                updateRows([
                  ...draft.lines,
                  {
                    productId: null,
                    name: "",
                    option: "",
                    quantity: "1",
                    unitAmount: "0",
                  },
                ])
              }
            >
              {isKorean ? "미매칭 줄 추가" : "Add unmatched line"}
            </button>
          </div>
          <div className={styles.lines}>
            {draft.lines.map((l, index) => {
              const p = products.find((p) => p.id === l.productId);
              return (
                <div className={styles.line} key={index}>
                  <strong>
                    {index + 1} ·{" "}
                    {l.productId
                      ? isKorean
                        ? "상품 연결됨"
                        : "Product linked"
                      : isKorean
                        ? "미매칭 · 재고 반영 불가"
                        : "Unmatched · Cannot update stock"}
                  </strong>
                  <label>
                    {isKorean
                      ? `${index + 1}번 상품명`
                      : `Line ${index + 1} product name`}
                    <input
                      value={l.name}
                      maxLength={160}
                      readOnly={!!l.productId}
                      onChange={(e) =>
                        updateRows(
                          draft.lines.map((r, n) =>
                            n === index ? { ...r, name: e.target.value } : r,
                          ),
                        )
                      }
                    />
                  </label>
                  <label>
                    {isKorean ? `${index + 1}번 옵션` : `Line ${index + 1} option`}
                    {p ? (
                      <select
                        value={l.option}
                        onChange={(e) =>
                          updateRows(
                            draft.lines.map((r, n) =>
                              n === index ? { ...r, option: e.target.value } : r,
                            ),
                          )
                        }
                      >
                        <option value="">
                          {isKorean ? "옵션 선택" : "Select option"}
                        </option>
                        {p.sizes
                          .split(",")
                          .map((s) => s.trim())
                          .filter(Boolean)
                          .map((s) => (
                            <option key={s} value={s}>
                              {s}
                            </option>
                          ))}
                      </select>
                    ) : (
                      <input
                        value={l.option}
                        maxLength={50}
                        onChange={(e) =>
                          updateRows(
                            draft.lines.map((r, n) =>
                              n === index ? { ...r, option: e.target.value } : r,
                            ),
                          )
                        }
                      />
                    )}
                  </label>
                  <label>
                    {isKorean ? `${index + 1}번 수량` : `Line ${index + 1} quantity`}
                    <input
                      type="number"
                      value={l.quantity}
                      min="1"
                      max="10000"
                      step="1"
                      required
                      onChange={(e) =>
                        updateRows(
                          draft.lines.map((r, n) =>
                            n === index ? { ...r, quantity: e.target.value } : r,
                          ),
                        )
                      }
                    />
                  </label>
                  <label>
                    {isKorean ? `${index + 1}번 단가` : `Line ${index + 1} unit price`}
                    <input
                      type="number"
                      value={l.unitAmount}
                      min="0"
                      max="100000000"
                      step="1"
                      required
                      onChange={(e) =>
                        updateRows(
                          draft.lines.map((r, n) =>
                            n === index ? { ...r, unitAmount: e.target.value } : r,
                          ),
                        )
                      }
                    />
                  </label>
                  <button
                    type="button"
                    aria-label={
                      isKorean ? `${index + 1}번 줄 삭제` : `Delete line ${index + 1}`
                    }
                    onClick={() =>
                      updateRows(draft.lines.filter((_, n) => n !== index))
                    }
                  >
                    {isKorean ? "줄 삭제" : "Delete line"}
                  </button>
                </div>
              );
            })}
          </div>
          <p>
            {isKorean ? "상품 줄 합계" : "Line total"}{" "}
            {money(lineSum(draft.lines), locale)}{" "}
            <button
              type="button"
              disabled={!draft.lines.length}
              onClick={() => {
                setManualAmount(false);
                updateDraft({ amount: String(lineSum(draft.lines)) });
              }}
            >
              {isKorean
                ? "줄 합계를 전표 금액에 적용"
                : "Apply line total to slip amount"}
            </button>
          </p>
          {unmatched ? (
            <AdminNotice status="warning" locale={locale}>
              {isKorean
                ? "미매칭 상품·옵션이 있습니다. 초안 보관은 가능하며 재고 반영 전 연결해야 합니다."
                : "There are unmatched products or options. You can save the draft, but link them before updating stock."}
            </AdminNotice>
          ) : null}
          {mismatched ? (
            <AdminNotice status="warning" locale={locale}>
              {isKorean
                ? "상품 줄 합계와 전표 금액이 다릅니다. 초안 보관은 가능하며 재고 반영 전 대조해야 합니다."
                : "The line total differs from the slip amount. You can save the draft, but reconcile them before updating stock."}
            </AdminNotice>
          ) : null}
          <button type="submit" disabled={!draftValid}>
            {isKorean ? "초안 저장" : "Save draft"}
          </button>
        </fieldset>
      </form>
      {selected?.status === "DRAFT" ? (
        <>
          <p>
            {unsaved
              ? isKorean
                ? "수정 내용을 초안 저장한 뒤 재고 미리보기를 요청해 주세요."
                : "Save your changes as a draft, then request the stock preview."
              : isKorean
                ? "저장된 초안의 상품·수량을 다시 확인해 주세요."
                : "Check the saved draft's products and quantities again."}
          </p>
          <button
            type="button"
            disabled={locked || !open || unsaved || unmatched || mismatched}
            onClick={() =>
              void run(day, {
                action: "preview",
                entryId: selected.entryId,
                version: selected.version,
              })
            }
          >
            {isKorean ? "재고 반영 미리보기" : "Preview stock changes"}
          </button>
          <div className={styles.actions}>
            <label>
              {isKorean ? "보류 전표 폐기 사유" : "Reason for voiding the held slip"}
              <input
                required
                value={voidReason}
                maxLength={300}
                disabled={locked || !open}
                onChange={(e) => setVoidReason(e.target.value)}
              />
            </label>
            <button
              type="button"
              disabled={locked || !open || !voidReason.trim()}
              onClick={() =>
                void run(day, {
                  action: "void",
                  entryId: selected.entryId,
                  version: selected.version,
                  reason: voidReason.trim(),
                })
              }
            >
              {isKorean ? "초안 폐기" : "Void draft"}
            </button>
          </div>
        </>
      ) : null}
    </section>
  );
}
