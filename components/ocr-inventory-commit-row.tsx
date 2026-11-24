"use client";

import type { Dispatch, SetStateAction } from "react";
import type { Locale } from "@/types/store";
import type {
  AdminCatalogListItem,
  AdminOcrRecognitionResult,
} from "@/lib/admin-ui/types";
import type { OcrIntakePlan } from "@/lib/admin-ui/ocr-inventory-commit";
import {
  findOcrIntakeMatches,
  getOcrIntakeNewProductValidationMessage,
  OCR_INTAKE_CATEGORIES,
  type OcrIntakeMatch,
  type OcrIntakeNewProduct,
} from "@/lib/admin-ui/ocr-intake-matching";
import { AdminHelpButton } from "./admin-help-button";
import styles from "./admin-dashboard.module.css";
import inventoryStyles from "./ocr-inventory-commit.module.css";

export type RowDraft = Readonly<{
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

export function OcrInventoryRow({
  row,
  index,
  products,
  loaded,
  drafts,
  setDrafts,
  setPlan,
  setConfirmed,
  loading,
  locale,
  isKorean,
  available,
  changeDraft,
}: Readonly<{
  row: AdminOcrRecognitionResult["rows"][number];
  index: number;
  products: readonly AdminCatalogListItem[];
  loaded: boolean;
  drafts: Readonly<Record<string, RowDraft>>;
  setDrafts: Dispatch<SetStateAction<Readonly<Record<string, RowDraft>>>>;
  setPlan: Dispatch<SetStateAction<OcrIntakePlan | null>>;
  setConfirmed: Dispatch<SetStateAction<boolean>>;
  loading: boolean;
  locale: Locale;
  isKorean: boolean;
  available: boolean;
  changeDraft: (id: string, patch: Partial<RowDraft>) => void;
}>) {
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
  const blockedNew = matches.candidates.length > 0 || matches.basis === "unresolved-id";
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
            aria-label={isKorean ? `입고 방식 ${number}` : `Receiving method ${number}`}
            value={draft.kind}
            onChange={(event) =>
              changeDraft(row.id, {
                kind: event.target.value as RowDraft["kind"],
              })
            }
          >
            <option value="existing">
              {isKorean ? "기존 상품에 입고 추가" : "Add to an existing product"}
            </option>
            <option value="new">
              {isKorean ? "없는 상품 신규 등록" : "Register a new product"}
            </option>
          </select>
        </label>
        <label>
          {isKorean ? `정확한 상품 ID ${number}` : `Exact product ID ${number}`}
          <input
            aria-label={
              isKorean ? `정확한 상품 ID ${number}` : `Exact product ID ${number}`
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
            aria-label={isKorean ? `정확한 SKU ${number}` : `Exact SKU ${number}`}
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
              isKorean ? `재고 상품 선택 ${number}` : `Stock product ${number}`
            }
            disabled={!loaded || products.length === 0}
            value={draft.productId}
            onChange={(event) => changeDraft(row.id, { productId: event.target.value })}
          >
            <option value="">
              {isKorean ? "상품을 선택해 주세요" : "Select a product"}
            </option>
            {products.map((product) => (
              <option key={product.id} value={product.id}>
                {matches.candidates.some((candidate) => candidate.id === product.id)
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
              {isKorean ? `신규 상품명 ${number}` : `New product name ${number}`}
              <input
                aria-label={
                  isKorean ? `신규 상품명 ${number}` : `New product name ${number}`
                }
                value={draft.name}
                maxLength={160}
                required
                onChange={(event) => changeDraft(row.id, { name: event.target.value })}
              />
            </label>
            <label>
              {isKorean ? `신규 브랜드 ${number}` : `New brand ${number}`}
              <input
                aria-label={isKorean ? `신규 브랜드 ${number}` : `New brand ${number}`}
                value={draft.brandName}
                maxLength={100}
                required
                onChange={(event) =>
                  changeDraft(row.id, { brandName: event.target.value })
                }
              />
            </label>
            <div className={styles.helpField}>
              <label>
                {isKorean ? `신규 옵션 ${number}` : `New option ${number}`}
                <input
                  aria-label={isKorean ? `신규 옵션 ${number}` : `New option ${number}`}
                  value={draft.option}
                  maxLength={50}
                  onChange={(event) =>
                    changeDraft(row.id, { option: event.target.value })
                  }
                />
              </label>
              <span className={styles.fieldHelpCorner}>
                <AdminHelpButton
                  locale={locale}
                  target={isKorean ? `신규 옵션 ${number}` : `New option ${number}`}
                >
                  <p>
                    {isKorean
                      ? "옵션이 없으면 빈칸. 옵션별 재고는 생성하지 않습니다."
                      : "Leave empty if there is no option. Stock per option is not created."}
                  </p>
                </AdminHelpButton>
              </span>
            </div>
            <div className={styles.helpField}>
              <label>
                {isKorean ? `신규 가격 ${number}` : `New price ${number}`}
                <input
                  aria-label={isKorean ? `신규 가격 ${number}` : `New price ${number}`}
                  value={draft.price}
                  inputMode="numeric"
                  maxLength={9}
                  required
                  onChange={(event) =>
                    changeDraft(row.id, { price: event.target.value })
                  }
                />
              </label>
              <span className={styles.fieldHelpCorner}>
                <AdminHelpButton
                  locale={locale}
                  target={isKorean ? `신규 가격 ${number}` : `New price ${number}`}
                >
                  <p>
                    {isKorean
                      ? "필수 · 원 단위 정수, 0~100,000,000원"
                      : "Required · Whole KRW, 0–100,000,000"}
                  </p>
                </AdminHelpButton>
              </span>
            </div>
            <label>
              {isKorean ? `신규 카테고리 ${number}` : `New category ${number}`}
              <select
                aria-label={
                  isKorean ? `신규 카테고리 ${number}` : `New category ${number}`
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
}

export function newProduct(draft: RowDraft): OcrIntakeNewProduct {
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
