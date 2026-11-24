"use client";
import adminInventorySectionStyles from "./admin-inventory-section.module.css";
import adminProductSectionStyles from "./admin-product-section.module.css";
import adminSharedStyles from "./admin-shared.module.css";
import { useLocale } from "@/contexts/locale-context";
import type { AdminCatalogListItem } from "@/lib/admin-ui/types";
import { useRef, useState } from "react";
import styles from "./admin-dashboard.module.css";
import { AdminHelpButton } from "./admin-help-button";
import { AdminProductImage } from "./admin-product-image";

export function StockStepper({
  canUpdateStock,
  disabled = false,
  onCommit,
  onReload,
  product,
}: Readonly<{
  canUpdateStock: boolean;
  disabled?: boolean;
  onCommit: (
    stock: number,
    expected: Readonly<{ version: number; stock: number }>,
  ) => Promise<AdminCatalogListItem | null>;
  onReload: () => Promise<readonly AdminCatalogListItem[] | null>;
  product: AdminCatalogListItem;
}>) {
  const { locale } = useLocale();
  const isKorean = locale === "ko";
  const [snapshot, setSnapshot] = useState({
    stock: product.stock,
    version: product.version,
  });
  const [draft, setDraft] = useState(String(product.stock));
  const [reviewRequired, setReviewRequired] = useState(false);
  const [saving, setSaving] = useState(false);
  const [reloading, setReloading] = useState(false);
  const [lastSaved, setLastSaved] = useState<"remote" | "local" | null>(null);
  const committingRef = useRef(false);
  const remote = canUpdateStock && product.version > 0;
  const stale =
    snapshot.version !== product.version || snapshot.stock !== product.stock;
  const parsed = /^\d+$/.test(draft) ? Number(draft) : NaN;
  const valid = Number.isInteger(parsed) && parsed >= 0 && parsed <= 1_000_000;
  const changed = valid && parsed !== snapshot.stock;
  const locked = disabled || saving || reloading;
  const delta = valid ? parsed - snapshot.stock : null;
  const statusLabel = saving
    ? isKorean
      ? "저장 중"
      : "Saving"
    : stale || reviewRequired
      ? isKorean
        ? "최신 재고 확인 필요"
        : "Check latest stock"
      : lastSaved === "remote"
        ? isKorean
          ? "저장 완료"
          : "Saved"
        : lastSaved === "local"
          ? isKorean
            ? "임시 변경 · 서버 미저장"
            : "Temporary change · Not saved to server"
          : isKorean
            ? "미리보기 · 아직 미반영"
            : "Preview · Not applied yet";

  const updateDraft = (value: string) => {
    setDraft(value);
    setLastSaved(null);
  };
  const handleUseLatest = async () => {
    if (locked) return;
    setReloading(true);
    try {
      const latest = remote
        ? (await onReload())?.find((item) => item.id === product.id)
        : product;
      if (!latest) {
        setReviewRequired(true);
        return;
      }
      setSnapshot({ stock: latest.stock, version: latest.version });
      setDraft(String(latest.stock));
      setReviewRequired(false);
      setLastSaved(null);
    } finally {
      setReloading(false);
    }
  };
  const commitDraft = async () => {
    if (locked || committingRef.current || stale || reviewRequired || !changed) return;
    const sign = delta! >= 0 ? "+" : "";
    if (
      !window.confirm(
        isKorean
          ? `${product.name}\n현재 ${snapshot.stock}개 → 변경 후 ${parsed}개 (${sign}${delta}개)\n${remote ? "서버 재고" : "이 화면의 임시 수량"}을 변경할까요?`
          : `${product.name}\nNow ${snapshot.stock} → after change ${parsed} (${sign}${delta})\nChange ${remote ? "the server stock" : "the temporary quantity on this screen"}?`,
      )
    )
      return;
    committingRef.current = true;
    setSaving(true);
    try {
      const updated = await onCommit(parsed, snapshot);
      if (!updated) {
        setReviewRequired(true);
        return;
      }
      setSnapshot({ stock: updated.stock, version: updated.version });
      setDraft(String(updated.stock));
      setReviewRequired(false);
      setLastSaved(remote ? "remote" : "local");
    } finally {
      committingRef.current = false;
      setSaving(false);
    }
  };

  return (
    <aside
      className={styles.inventoryAdjustment}
      aria-label={isKorean ? "재고 조정" : "Adjust stock"}
      aria-busy={locked}
    >
      <div className={adminInventorySectionStyles.inventoryAdjustmentHeader}>
        <h2 id="inventory-adjustment-title" tabIndex={-1} data-product-id={product.id}>
          {isKorean ? "재고 조정" : "Adjust stock"}
        </h2>
        <span className={adminProductSectionStyles.productSaveState} role="status">
          {statusLabel}
        </span>
      </div>
      <div className={styles.inventorySelectedProduct}>
        <AdminProductImage alt="" compact src={product.imageUrl} />
        <div>
          <strong>{product.name}</strong>
          <span>
            {product.brand} · {product.sizes || (isKorean ? "옵션 없음" : "No options")}
          </span>
          <span>
            {product.version < 1
              ? isKorean
                ? "로컬 초안"
                : "Local draft"
              : product.isVisible
                ? isKorean
                  ? "공개"
                  : "Public"
                : isKorean
                  ? "비공개"
                  : "Private"}
          </span>
        </div>
      </div>
      {!remote ? (
        <p className={adminProductSectionStyles.productStorageNote}>
          {isKorean
            ? "이 화면에서만 수량을 변경합니다. 서버 재고에는 반영되지 않습니다."
            : "Changes the quantity on this screen only. Server stock is not updated."}
        </p>
      ) : null}
      <div className={adminSharedStyles.titleWithHelp}>
        <label
          className={adminInventorySectionStyles.inventoryQuantityLabel}
          htmlFor="inventory-next-stock"
        >
          {isKorean ? "변경 후 재고 수량" : "Stock after change"}
        </label>
        <span className={adminSharedStyles.fieldHelp}>
          <AdminHelpButton
            locale={locale}
            target={isKorean ? "변경 후 재고 수량" : "Stock after change"}
          >
            <p>
              {isKorean
                ? "0~1,000,000개까지 입력할 수 있습니다. 확인 전에는 수량이 변경되지 않습니다."
                : "Enter 0–1,000,000. The quantity does not change until you confirm."}
            </p>
          </AdminHelpButton>
        </span>
      </div>
      <div className={styles.stockStepper}>
        <button
          aria-label={isKorean ? "재고 1개 감소" : "Decrease stock by 1"}
          className={styles.stockStepButton}
          disabled={locked || !valid || parsed <= 0}
          onClick={() => updateDraft(String(parsed - 1))}
          type="button"
        >
          −
        </button>
        <input
          data-admin-guide="inventory.quantity"
          id="inventory-next-stock"
          aria-describedby="inventory-input-hint inventory-draft-error"
          aria-invalid={!valid}
          className={styles.stockStepInput}
          disabled={locked}
          inputMode="numeric"
          onChange={(event) => updateDraft(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === "Enter") event.preventDefault();
          }}
          required
          value={draft}
        />
        <button
          aria-label={isKorean ? "재고 1개 증가" : "Increase stock by 1"}
          className={styles.stockStepButton}
          disabled={locked || !valid || parsed >= 1_000_000}
          onClick={() => updateDraft(String(parsed + 1))}
          type="button"
        >
          ＋
        </button>
      </div>
      {/* Still the input's description; seen on screen through the help button and the error. */}
      <p className="srOnly" id="inventory-input-hint">
        {isKorean
          ? "0~1,000,000개 · 확인 전에는 수량이 변경되지 않습니다."
          : "0–1,000,000 · The quantity does not change until you confirm."}
      </p>
      <p
        className={styles.inventoryDraftError}
        id="inventory-draft-error"
        role={!valid ? "alert" : undefined}
      >
        {!valid
          ? isKorean
            ? "0~1,000,000 사이의 정수를 입력해 주세요. 입력값은 자동으로 바꾸지 않습니다."
            : "Enter a whole number from 0 to 1,000,000. Your input is not changed automatically."
          : ""}
      </p>
      {stale || reviewRequired ? (
        <p className={styles.inventoryDraftError} role="alert">
          {stale
            ? isKorean
              ? `최신 재고는 ${product.stock}개입니다. 입력 내용은 보존했습니다.`
              : `The latest stock is ${product.stock}. Your input is kept.`
            : isKorean
              ? "변경 결과를 다시 확인해야 합니다."
              : "Check the change result again."}{" "}
          {isKorean
            ? "최신 재고를 조회한 뒤 다시 시작해 주세요."
            : "Load the latest stock, then start again."}
        </p>
      ) : null}
      <div
        className={adminInventorySectionStyles.inventoryImpact}
        aria-label={isKorean ? "재고 변경 미리보기" : "Stock change preview"}
        role="group"
      >
        <div>
          <span>{isKorean ? "현재" : "Now"}</span>
          <strong>{isKorean ? `${snapshot.stock}개` : snapshot.stock}</strong>
        </div>
        <div>
          <span>{isKorean ? "변경 수량" : "Change"}</span>
          <strong>
            {delta === null
              ? "—"
              : `${delta >= 0 ? "+" : ""}${delta}${isKorean ? "개" : ""}`}
          </strong>
          <span aria-hidden="true">→</span>
        </div>
        <div>
          <span>{isKorean ? "변경 후" : "After"}</span>
          <strong>{valid ? `${parsed}${isKorean ? "개" : ""}` : "—"}</strong>
        </div>
      </div>
      <button
        className={styles.primaryButton}
        data-admin-guide="inventory.save"
        disabled={locked || stale || reviewRequired || !changed}
        onClick={() => void commitDraft()}
        type="button"
      >
        {saving
          ? isKorean
            ? "저장 중…"
            : "Saving…"
          : isKorean
            ? "재고 변경 내용 확인"
            : "Review stock change"}
      </button>
      <button
        className={styles.secondaryButton}
        disabled={locked}
        onClick={() => void handleUseLatest()}
        type="button"
      >
        {reloading
          ? isKorean
            ? "최신 재고 확인 중…"
            : "Checking latest stock…"
          : isKorean
            ? "최신 재고로 다시 시작"
            : "Restart with latest stock"}
      </button>
      {!changed && valid && !stale && !reviewRequired ? (
        <p className={adminInventorySectionStyles.inventoryInputHint}>
          {isKorean ? "변경할 수량을 입력해 주세요." : "Enter the quantity to change."}
        </p>
      ) : null}
    </aside>
  );
}
