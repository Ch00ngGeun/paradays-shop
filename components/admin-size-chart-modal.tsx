// 역할: 관리자가 의류·휠 상세사이즈를 도면 종류별로 기본값 또는 사이즈 옵션별로 입력·미리보기하고 저장하게 합니다.
// 데크 상세사이즈 모달과 같은 구조·문구 규칙을 따릅니다.
"use client";

import { useId, useRef, useState, type FormEvent } from "react";
import { createPortal } from "react-dom";

import { useFocusTrap } from "@/hooks/use-focus-trap";
import { useModalLayer } from "@/hooks/use-modal-layer";
import {
  validateProductOptionName,
  type ProductOptionNameResult,
} from "@/lib/admin-ui/product-form";
import {
  SIZE_CHART_KIND_INFO,
  formatSizeChartValue,
  parseSizeChartInputs,
  parseSizeChartValue,
  sizeChartKindsFor,
  type SizeChartKind,
  type SizeChartValues,
} from "@/lib/size-chart";
import type { Locale } from "@/types/store";

import deckStyles from "./admin-deck-spec-modal.module.css";
import { deckSpecFailureMessage, optionNameError } from "./admin-deck-spec-modal";
import styles from "./admin-size-chart-modal.module.css";
import { AdminHelpButton } from "./admin-help-button";
import { SizeChartBottom } from "./size-chart-bottom";
import { SizeChartTop } from "./size-chart-top";
import { SizeChartWheel } from "./size-chart-wheel";

type Inputs = Readonly<Record<string, string>>;

function isInvalid(kind: SizeChartKind, value: string) {
  return value.trim() !== "" && parseSizeChartValue(kind, value) === null;
}

/**
 * 저장할 값과 바뀐 옵션 이름, 저장 가능 여부를 계산합니다(데크 모달과 같은 규칙).
 * 바뀌지 않은 이름은 다시 검사하지 않고, 이름이 바뀌면 칸을 모두 비운 채 이름만 저장할 수 있습니다.
 */
export function getSizeChartSaveState(
  kind: SizeChartKind,
  inputs: Inputs,
  option?: Readonly<{ size: string; name: string; otherOptions: readonly string[] }>,
) {
  const values = parseSizeChartInputs(kind, inputs);
  const nameResult: ProductOptionNameResult | null =
    !option || option.name.trim() === option.size
      ? null
      : validateProductOptionName(option.name, option.otherOptions);
  const sizeName = nameResult?.ok ? nameResult.name : undefined;
  const allEmpty = SIZE_CHART_KIND_INFO[kind].fields.every(
    ({ key }) => !(inputs[key] ?? "").trim(),
  );
  const ready =
    nameResult?.ok !== false &&
    (values !== null || (sizeName !== undefined && allEmpty));
  return { values, nameResult, sizeName, ready };
}

/** 범위 안내. 의류는 cm 300까지, 휠은 mm 100까지 소수 1자리입니다. */
export function sizeChartRangeText(kind: SizeChartKind, isKorean: boolean) {
  const { unit } = SIZE_CHART_KIND_INFO[kind];
  const max = unit === "cm" ? 300 : 100;
  return isKorean
    ? `0 초과 ${max} 이하의 ${unit}로, 소수 1자리까지 입력해 주세요.`
    : `Enter ${unit} above 0 and up to ${max}, with up to 1 decimal.`;
}

/** 도면 종류를 바꾸기 전에 보여 줄 확인 문구. */
export function sizeChartKindChangeText(next: SizeChartKind, isKorean: boolean) {
  const label = SIZE_CHART_KIND_INFO[next].label[isKorean ? "ko" : "en"];
  return isKorean
    ? `도면 종류를 '${label}'(으)로 바꾸면 기본값과 옵션별로 입력한 상세사이즈가 모두 지워집니다.`
    : `Switching the drawing to '${label}' deletes the default and every option's size chart.`;
}

function SizeChartPreview({
  kind,
  values,
  locale,
}: Readonly<{ kind: SizeChartKind; values: SizeChartValues; locale: Locale }>) {
  if (kind === "wheel") return <SizeChartWheel locale={locale} values={values} />;
  if (kind === "shortSleeve" || kind === "raglanLongSleeve")
    return <SizeChartTop kind={kind} locale={locale} values={values} />;
  return <SizeChartBottom kind={kind} locale={locale} values={values} />;
}

type AdminSizeChartFormProps = Readonly<{
  /** 상품 카테고리. 고를 수 있는 도면 종류를 정합니다. */
  category: string;
  /** 지금 상품이 쓰는 도면 종류. */
  kind: SizeChartKind;
  initialValues?: SizeChartValues;
  /** 저장 대상 사이즈 옵션. 없으면 상품 공통 기본값입니다. */
  size?: string;
  /** 있으면 size 옵션의 이름 칸을 보여 줍니다. 이름을 바꾸는 옵션을 뺀 저장된 옵션 목록입니다. */
  otherOptions?: readonly string[];
  onCancel: () => void;
  /** sizeName은 옵션 이름이 실제로 바뀐 저장에만 넘깁니다. */
  onSave: (
    values: SizeChartValues | null,
    size?: string,
    sizeName?: string,
  ) => Promise<void>;
  /** 확인을 받은 도면 종류 변경. 성공하면 caller가 새 kind로 다시 그립니다. */
  onChangeKind: (kind: SizeChartKind) => Promise<void>;
  onBusyChange?: (busy: boolean) => void;
  locale?: Locale;
  notice?: string;
  describeError?: (error: unknown) => string | undefined;
}>;

function toInputs(kind: SizeChartKind, values?: SizeChartValues): Inputs {
  return Object.fromEntries(
    SIZE_CHART_KIND_INFO[kind].fields.map(({ key }) => [
      key,
      values && Object.hasOwn(values, key) ? String(values[key]) : "",
    ]),
  );
}

/** 모달 본문. 저장 성공 시 caller가 모달을 닫고, 실패하면 입력값을 그대로 두고 오류를 보여 줍니다. */
export function AdminSizeChartForm({
  category,
  kind,
  initialValues,
  size,
  otherOptions,
  onCancel,
  onSave,
  onChangeKind,
  onBusyChange,
  locale = "ko",
  notice,
  describeError,
}: AdminSizeChartFormProps) {
  const isKorean = locale === "ko";
  const info = SIZE_CHART_KIND_INFO[kind];
  const [inputs, setInputs] = useState(() => toInputs(kind, initialValues));
  const [saving, setSaving] = useState(false);
  const [failure, setFailure] = useState<string | null>(null);
  const [pendingKind, setPendingKind] = useState<SizeChartKind | null>(null);
  const rangeErrorId = useId();
  const nameNoteId = useId();
  const kindNoteId = useId();
  const nameEditable = size !== undefined && otherOptions !== undefined;
  const [name, setName] = useState(size ?? "");
  const { values, nameResult, sizeName, ready } = getSizeChartSaveState(
    kind,
    inputs,
    nameEditable ? { size, name, otherOptions } : undefined,
  );
  const kinds = sizeChartKindsFor(category);
  const canSave = ready && !saving && pendingKind === null;
  // Why the drawing cannot be switched here, if it cannot.
  const kindNote =
    size !== undefined
      ? isKorean
        ? "옵션은 상품의 도면 종류를 따릅니다. 종류는 기본값 화면에서 바꿀 수 있습니다."
        : "Options follow the product's drawing. Change it from the default screen."
      : kinds.length < 2
        ? isKorean
          ? "이 카테고리는 도면 종류가 하나뿐입니다."
          : "This category has only one drawing."
        : undefined;

  // Shared by saving values and changing the drawing: one busy state and one failure line.
  const run = async (action: () => Promise<void>) => {
    setSaving(true);
    onBusyChange?.(true);
    setFailure(null);
    try {
      await action();
    } catch (error) {
      setFailure(deckSpecFailureMessage(error, describeError, isKorean));
      setSaving(false);
    } finally {
      onBusyChange?.(false);
    }
  };

  const handleSubmit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    // The portal still bubbles React events into the product form, which must not save too.
    event.stopPropagation();
    if (canSave) void run(() => onSave(values, size, sizeName));
  };

  return (
    <form className={styles.form} noValidate onSubmit={handleSubmit}>
      <div className={styles.kind}>
        <label className={deckStyles.field}>
          <span className={deckStyles.fieldName}>
            {isKorean ? "도면 종류" : "Drawing"}
          </span>
          <select
            aria-describedby={kindNote ? kindNoteId : undefined}
            // Options follow the product's drawing; only the default screen switches it.
            disabled={saving || kindNote !== undefined}
            name="sizeChartKind"
            onChange={(event) => {
              const next = event.target.value as SizeChartKind;
              setPendingKind(next === kind ? null : next);
            }}
            value={pendingKind ?? kind}
          >
            {kinds.map((option) => (
              <option key={option} value={option}>
                {SIZE_CHART_KIND_INFO[option].label[locale]}
              </option>
            ))}
          </select>
        </label>
        {kindNote ? (
          <p className={deckStyles.hint} id={kindNoteId}>
            {kindNote}
          </p>
        ) : null}
      </div>
      {pendingKind ? (
        <div className={styles.confirm} role="alert">
          <p>{sizeChartKindChangeText(pendingKind, isKorean)}</p>
          <div className={styles.confirmActions}>
            <button
              className={styles.confirmChange}
              disabled={saving}
              onClick={() => void run(() => onChangeKind(pendingKind))}
              type="button"
            >
              {isKorean ? "바꾸고 지우기" : "Switch and delete"}
            </button>
            <button
              disabled={saving}
              onClick={() => setPendingKind(null)}
              type="button"
            >
              {isKorean ? "그대로 두기" : "Keep it"}
            </button>
          </div>
        </div>
      ) : null}

      <div className={deckStyles.fields}>
        {notice ? <p className={deckStyles.hint}>{notice}</p> : null}
        {nameEditable ? (
          <label className={deckStyles.field}>
            <span className={deckStyles.fieldName}>
              {isKorean ? "옵션 이름" : "Option name"}
            </span>
            <span className={deckStyles.inputRow}>
              <input
                aria-describedby={nameResult ? nameNoteId : undefined}
                aria-invalid={nameResult?.ok === false || undefined}
                disabled={saving}
                name="optionName"
                onChange={(event) => setName(event.target.value)}
                value={name}
              />
            </span>
          </label>
        ) : null}
        {nameResult ? (
          <p
            className={nameResult.ok ? deckStyles.hint : deckStyles.error}
            id={nameNoteId}
          >
            {nameResult.ok
              ? isKorean
                ? "저장하면 옵션 이름과 상세사이즈가 함께 바뀝니다. 예전 이름으로 적힌 매출 초안은 옵션을 다시 골라 저장해야 반영할 수 있고, 이미 반영된 매출은 '입고·검수 완료' 확인 없이 취소한 뒤 재고 수정에서 수량을 맞춰야 합니다."
                : "Saving changes the option name and its size chart together. Sales drafts with the old name need the option picked again and saved before posting; reverse already posted sales without the received-and-inspected check, then fix the quantity in Stock editing."
              : optionNameError(nameResult.reason, isKorean)}
          </p>
        ) : null}
        {info.fields.map(({ key, label }) => {
          const value = inputs[key] ?? "";
          const parsed = parseSizeChartValue(kind, value);
          const invalid = isInvalid(kind, value);
          // Clothes show the inch conversion beside the cm input; wheels stay in mm.
          const inches =
            parsed !== null && info.unit === "cm"
              ? formatSizeChartValue(kind, parsed).split(" ")[1]
              : "";
          return (
            <label className={deckStyles.field} key={key}>
              <span className={deckStyles.fieldName}>{label[locale]}</span>
              <span className={deckStyles.inputRow}>
                <input
                  aria-describedby={invalid ? rangeErrorId : undefined}
                  aria-invalid={invalid || undefined}
                  disabled={saving}
                  inputMode="decimal"
                  name={key}
                  onChange={(event) =>
                    setInputs((current) => ({ ...current, [key]: event.target.value }))
                  }
                  value={value}
                />
                <span aria-hidden="true">{info.unit}</span>
                <span className={deckStyles.cm}>{inches}</span>
              </span>
            </label>
          );
        })}
        {/* The range shows again as an error only when a value is out of it. */}
        {info.fields.some(({ key }) => isInvalid(kind, inputs[key] ?? "")) ? (
          <p className={deckStyles.error} id={rangeErrorId}>
            {sizeChartRangeText(kind, isKorean)}
          </p>
        ) : null}
        <div className={deckStyles.hint}>
          <AdminHelpButton
            locale={locale}
            target={isKorean ? "상세사이즈 입력" : "Size chart input"}
          >
            <p>
              {info.unit === "cm"
                ? isKorean
                  ? "cm로 입력하면 인치는 자동으로 계산됩니다."
                  : "Enter cm; inches are calculated automatically."
                : isKorean
                  ? "mm로 입력합니다."
                  : "Enter mm."}
            </p>
            <p>{sizeChartRangeText(kind, isKorean)}</p>
          </AdminHelpButton>
        </div>
        {size !== undefined && !initialValues ? (
          <p className={deckStyles.hint}>
            {isKorean
              ? "이 옵션은 지금 기본값을 표시합니다. 저장하면 이 옵션에만 적용됩니다."
              : "This option shows the default now. Saving applies to this option only."}
          </p>
        ) : null}
      </div>

      <div className={deckStyles.preview}>
        {values ? (
          <SizeChartPreview kind={kind} locale={locale} values={values} />
        ) : (
          <p className={deckStyles.previewEmpty}>
            {isKorean
              ? `${info.fields.length}칸을 모두 입력하면 도면 미리보기가 나타납니다.`
              : `Fill in all ${info.fields.length} fields to see the diagram preview.`}
          </p>
        )}
      </div>

      {failure ? (
        <p className={deckStyles.error} role="alert">
          {failure}
        </p>
      ) : null}

      <div className={deckStyles.actions}>
        {initialValues ? (
          <button
            className={deckStyles.deleteButton}
            disabled={saving || pendingKind !== null}
            onClick={() => void run(() => onSave(null, size))}
            type="button"
          >
            {isKorean ? "삭제" : "Delete"}
          </button>
        ) : null}
        <button
          className={deckStyles.cancelButton}
          disabled={saving}
          onClick={onCancel}
          type="button"
        >
          {isKorean ? "취소" : "Cancel"}
        </button>
        <button className={deckStyles.saveButton} disabled={!canSave} type="submit">
          {saving ? (isKorean ? "저장 중…" : "Saving…") : isKorean ? "저장" : "Save"}
        </button>
      </div>
    </form>
  );
}

type AdminSizeChartModalProps = AdminSizeChartFormProps &
  Readonly<{ isOpen: boolean; productName: string }>;

/** body 아래 독립 layer에 띄우고 배경을 inert 처리합니다. 저장 중이 아닐 때 ESC·취소로만 닫습니다. */
export function AdminSizeChartModal({
  isOpen,
  productName,
  ...form
}: AdminSizeChartModalProps) {
  const layer = useModalLayer(isOpen);
  const busyRef = useRef(false);
  const titleId = useId();
  const dialogRef = useFocusTrap(isOpen, () => {
    if (!busyRef.current) form.onCancel();
  });

  if (!layer) return null;

  return createPortal(
    <div className={deckStyles.overlay}>
      <section
        aria-labelledby={titleId}
        aria-modal="true"
        className={styles.dialog}
        ref={dialogRef}
        role="dialog"
        tabIndex={-1}
      >
        <h2 className={deckStyles.title} id={titleId}>
          {form.locale === "en" ? "Size chart" : "상세사이즈"} · {productName}
          {form.size === undefined ? "" : ` · ${form.size}`}
        </h2>
        {/* A new drawing has other fields, so the form starts over with it. */}
        <AdminSizeChartForm
          key={form.kind}
          {...form}
          onBusyChange={(busy) => {
            busyRef.current = busy;
          }}
        />
      </section>
    </div>,
    layer,
  );
}
