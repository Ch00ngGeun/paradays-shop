// 역할: 관리자가 데크 상세사이즈(인치)를 기본값 또는 사이즈 옵션별로 입력·미리보기하고, 모달의 저장 버튼으로 서버에 즉시 저장하게 합니다.
"use client";

import { useId, useRef, useState, type FormEvent } from "react";
import { createPortal } from "react-dom";

import { useFocusTrap } from "@/hooks/use-focus-trap";
import { useModalLayer } from "@/hooks/use-modal-layer";
import {
  validateProductOptionName,
  type ProductOptionNameResult,
} from "@/lib/admin-ui/product-form";
import type { DeckSpec, Locale } from "@/types/store";

import styles from "./admin-deck-spec-modal.module.css";
import { AdminHelpButton } from "./admin-help-button";
import { DeckSizeDiagram, formatDeckCm } from "./deck-size-diagram";

const DECK_SPEC_FIELDS = ["nose", "tail", "width", "length", "wheelbase"] as const;

type DeckSpecField = (typeof DECK_SPEC_FIELDS)[number];
type DeckSpecInputs = Readonly<Record<DeckSpecField, string>>;

/**
 * 0 초과 100 이하, 소수 4자리(1/16인치 = 0.0625)까지만 허용합니다.
 * 이 범위의 값은 String()이 지수 표기로 바꾸지 않아 저장 후 다시 열어도 같은 입력값이 됩니다.
 */
export function parseDeckInches(value: string): number | null {
  const trimmed = value.trim();

  if (!/^\d+(?:\.\d{1,4})?$/.test(trimmed)) {
    return null;
  }

  const inches = Number(trimmed);

  return inches > 0 && inches <= 100 ? inches : null;
}

/** 비어 있지 않은데 허용 범위·형식이 아닌 칸입니다. */
function isInvalidInches(value: string) {
  return value.trim() !== "" && parseDeckInches(value) === null;
}

/**
 * 저장할 상세사이즈를 만듭니다. 빈 칸은 null이고, 잘못된 칸이 있거나 숫자가 하나도 없으면 null입니다.
 * 모든 칸이 빈 저장은 값이 아니라 삭제 요청이라 저장 가능 여부에서 따로 판단합니다.
 */
export function parseDeckSpecInputs(inputs: DeckSpecInputs): DeckSpec | null {
  const values = DECK_SPEC_FIELDS.map((field) =>
    inputs[field].trim() ? parseDeckInches(inputs[field]) : null,
  );

  if (
    DECK_SPEC_FIELDS.some((field) => isInvalidInches(inputs[field])) ||
    values.every((value) => value === null)
  ) {
    return null;
  }

  const [nose, tail, width, length, wheelbase] = values;

  return { nose, tail, width, length, wheelbase };
}

/**
 * 저장할 상세사이즈와 바뀐 옵션 이름, 저장 가능 여부를 계산합니다.
 * 바뀌지 않은 이름은 다시 검사하지 않아 예전 규칙으로 저장된 옵션도 상세사이즈를 저장할 수 있습니다.
 * 빈 칸은 null로 저장하고, 5칸을 모두 비우면 이름만 바꾸거나(이름 변경 시) 기존 값을 지웁니다.
 * 모든 칸이 비었고 지울 값도 바꿀 이름도 없으면 저장할 것이 없습니다.
 */
export function getDeckSpecSaveState(
  inputs: DeckSpecInputs,
  option?: Readonly<{ size: string; name: string; otherOptions: readonly string[] }>,
  hasSavedSpec = false,
) {
  const spec = parseDeckSpecInputs(inputs);
  const nameResult: ProductOptionNameResult | null =
    !option || option.name.trim() === option.size
      ? null
      : validateProductOptionName(option.name, option.otherOptions);
  const sizeName = nameResult?.ok ? nameResult.name : undefined;
  const allEmpty = DECK_SPEC_FIELDS.every((field) => !inputs[field].trim());
  const ready =
    nameResult?.ok !== false &&
    (spec !== null || (allEmpty && (sizeName !== undefined || hasSavedSpec)));
  return { spec, nameResult, sizeName, ready };
}

/** 저장된 값을 입력칸으로 되돌립니다. 비운 칸(null)은 "null" 글자가 아니라 빈 칸입니다. */
function toInputs(spec?: DeckSpec): DeckSpecInputs {
  const input = (value: number | null | undefined) =>
    value === null || value === undefined ? "" : String(value);
  return {
    nose: input(spec?.nose),
    tail: input(spec?.tail),
    width: input(spec?.width),
    length: input(spec?.length),
    wheelbase: input(spec?.wheelbase),
  };
}

type AdminDeckSpecFormProps = Readonly<{
  initialSpec?: DeckSpec;
  /** 저장 대상 사이즈 옵션. 없으면 상품 공통 기본값입니다. */
  size?: string;
  /** 있으면 size 옵션의 이름 칸을 보여 줍니다. 이름을 바꾸는 옵션을 뺀 저장된 옵션 목록입니다. */
  otherOptions?: readonly string[];
  onCancel: () => void;
  /** sizeName은 옵션 이름이 실제로 바뀐 저장에만 넘깁니다. */
  onSave: (spec: DeckSpec | null, size?: string, sizeName?: string) => Promise<void>;
  /** 저장 중 여부를 모달에 알려 ESC로 닫히지 않게 합니다. */
  onBusyChange?: (busy: boolean) => void;
  /** 단위 테스트가 provider 없이 렌더하므로 언어는 prop으로 받습니다. */
  locale?: Locale;
  /** 폼 맨 위에 보여 줄 안내. 이름을 바꿀 수 없는 이유 등 caller가 아는 사정을 모달 안에서 알립니다. */
  notice?: string;
  /** 저장 실패 원인을 caller가 아는 문구로 바꿉니다. 없거나 undefined면 일반 실패 문구를 씁니다. */
  describeError?: (error: unknown) => string | undefined;
}>;

/** caller가 아는 실패 원인이 있으면 그 문구를, 없으면 입력값 보존을 알리는 일반 문구를 씁니다. */
export function deckSpecFailureMessage(
  error: unknown,
  describeError: ((error: unknown) => string | undefined) | undefined,
  isKorean: boolean,
) {
  let described: string | undefined;
  try {
    described = describeError?.(error);
  } catch {
    // A failing description must not leave the form stuck in its saving state.
    described = undefined;
  }
  return (
    described ??
    (isKorean
      ? "저장하지 못했습니다. 입력값은 그대로 두었으니 다시 저장해 주세요."
      : "Could not save. Your input is kept, so save again.")
  );
}

/** 모달 본문. 저장 성공 시 caller가 모달을 닫고, 실패하면 입력값을 그대로 두고 오류를 보여 줍니다. */
export function AdminDeckSpecForm({
  initialSpec,
  size,
  otherOptions,
  onCancel,
  onSave,
  onBusyChange,
  locale = "ko",
  notice,
  describeError,
}: AdminDeckSpecFormProps) {
  const isKorean = locale === "ko";
  const [inputs, setInputs] = useState(() => toInputs(initialSpec));
  const [saving, setSaving] = useState(false);
  const [failure, setFailure] = useState<string | null>(null);
  const rangeErrorId = useId();
  const nameEditable = size !== undefined && otherOptions !== undefined;
  const [name, setName] = useState(size ?? "");
  const { spec, nameResult, sizeName, ready } = getDeckSpecSaveState(
    inputs,
    nameEditable ? { size, name, otherOptions } : undefined,
    Boolean(initialSpec),
  );
  const canSave = ready && !saving;

  const submit = async (next: DeckSpec | null, nextName?: string) => {
    setSaving(true);
    onBusyChange?.(true);
    setFailure(null);

    try {
      await onSave(next, size, nextName);
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

    if (canSave) {
      void submit(spec, sizeName);
    }
  };

  return (
    <form className={styles.form} noValidate onSubmit={handleSubmit}>
      <div className={styles.fields}>
        {notice ? <p className={styles.hint}>{notice}</p> : null}
        {nameEditable ? (
          <label className={styles.field}>
            <span className={styles.fieldName}>
              {isKorean ? "옵션 이름" : "Option name"}
            </span>
            <span className={styles.inputRow}>
              <input
                aria-describedby={
                  nameResult ? "admin-deck-spec-option-name-note" : undefined
                }
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
            className={nameResult.ok ? styles.hint : styles.error}
            id="admin-deck-spec-option-name-note"
          >
            {nameResult.ok
              ? isKorean
                ? "저장하면 옵션 이름과 상세사이즈가 함께 바뀝니다. 예전 이름으로 적힌 매출 초안은 옵션을 다시 골라 저장해야 반영할 수 있고, 이미 반영된 매출은 '입고·검수 완료' 확인 없이 취소한 뒤 재고 수정에서 수량을 맞춰야 합니다."
                : "Saving changes the option name and its size chart together. Sales drafts with the old name need the option picked again and saved before posting; reverse already posted sales without the received-and-inspected check, then fix the quantity in Stock editing."
              : optionNameError(nameResult.reason, isKorean)}
          </p>
        ) : null}
        {DECK_SPEC_FIELDS.map((field) => {
          const inches = parseDeckInches(inputs[field]);
          const invalid = isInvalidInches(inputs[field]);

          return (
            <label className={styles.field} key={field}>
              <span className={styles.fieldName}>{field}</span>
              <span className={styles.inputRow}>
                <input
                  aria-describedby={invalid ? rangeErrorId : undefined}
                  aria-invalid={invalid || undefined}
                  disabled={saving}
                  inputMode="decimal"
                  name={field}
                  onChange={(event) =>
                    setInputs((current) => ({
                      ...current,
                      [field]: event.target.value,
                    }))
                  }
                  value={inputs[field]}
                />
                <span aria-hidden="true">&quot;</span>
                <span className={styles.cm}>
                  {inches === null ? "" : `(${formatDeckCm(inches)})`}
                </span>
              </span>
            </label>
          );
        })}
        {/* The range shows again as an error only when a value is out of it. */}
        {DECK_SPEC_FIELDS.some((field) => isInvalidInches(inputs[field])) ? (
          <p className={styles.error} id={rangeErrorId}>
            {isKorean
              ? "0 초과 100 이하의 인치로, 소수 4자리까지 입력해 주세요."
              : "Enter inches above 0 and up to 100, with up to 4 decimals."}
          </p>
        ) : null}
        <div className={styles.hint}>
          <AdminHelpButton
            locale={locale}
            target={isKorean ? "상세사이즈 입력" : "Size chart input"}
          >
            <p>
              {isKorean
                ? "인치로 입력하면 cm는 자동으로 계산됩니다."
                : "Enter inches; cm is calculated automatically."}
            </p>
            <p>
              {isKorean
                ? "0 초과 100 이하, 소수 4자리(1/16인치 = 0.0625)까지 입력할 수 있습니다."
                : "Above 0 and up to 100, with up to 4 decimals (1/16 inch = 0.0625)."}
            </p>
          </AdminHelpButton>
        </div>
        {size !== undefined && !initialSpec ? (
          <p className={styles.hint}>
            {isKorean
              ? "이 옵션은 지금 기본값을 표시합니다. 저장하면 이 옵션에만 적용됩니다."
              : "This option shows the default now. Saving applies to this option only."}
          </p>
        ) : null}
      </div>

      <div className={styles.preview}>
        {spec ? (
          <DeckSizeDiagram spec={spec} />
        ) : (
          <p className={styles.previewEmpty}>
            {isKorean
              ? "값을 1개 이상 입력하면 도면 미리보기가 나타납니다."
              : "Enter at least one value to see the diagram preview."}
          </p>
        )}
      </div>

      {failure ? (
        <p className={styles.error} role="alert">
          {failure}
        </p>
      ) : null}

      <div className={styles.actions}>
        {initialSpec ? (
          <button
            className={styles.deleteButton}
            disabled={saving}
            onClick={() => void submit(null)}
            type="button"
          >
            {isKorean ? "삭제" : "Delete"}
          </button>
        ) : null}
        <button
          className={styles.cancelButton}
          disabled={saving}
          onClick={onCancel}
          type="button"
        >
          {isKorean ? "취소" : "Cancel"}
        </button>
        <button className={styles.saveButton} disabled={!canSave} type="submit">
          {saving ? (isKorean ? "저장 중…" : "Saving…") : isKorean ? "저장" : "Save"}
        </button>
      </div>
    </form>
  );
}

export function optionNameError(
  reason: Extract<ProductOptionNameResult, { ok: false }>["reason"],
  isKorean: boolean,
) {
  switch (reason) {
    case "empty-option":
      return isKorean ? "옵션 이름을 입력해 주세요." : "Enter an option name.";
    case "multiple-options":
      return isKorean
        ? "쉼표나 줄바꿈 없이 옵션 하나의 이름만 입력해 주세요."
        : "Enter one option name without commas or line breaks.";
    case "option-too-long":
      return isKorean
        ? "옵션 이름은 50자 이하로 입력해 주세요."
        : "Use 50 characters or fewer for the option name.";
    case "reserved-option":
      return isKorean
        ? "이 이름은 옵션 이름으로 쓸 수 없습니다."
        : "This name cannot be used for an option.";
    case "duplicate-option":
      return isKorean
        ? "이미 있는 옵션 이름입니다."
        : "This option name already exists.";
  }
}

type AdminDeckSpecModalProps = AdminDeckSpecFormProps &
  Readonly<{
    isOpen: boolean;
    productName: string;
  }>;

/** body 아래 독립 layer에 띄우고 배경을 inert 처리합니다. 배경 클릭으로는 닫지 않고, 저장 중이 아닐 때 ESC·취소로만 닫습니다. */
export function AdminDeckSpecModal({
  isOpen,
  productName,
  initialSpec,
  size,
  otherOptions,
  onCancel,
  onSave,
  locale = "ko",
  notice,
  describeError,
}: AdminDeckSpecModalProps) {
  const layer = useModalLayer(isOpen);
  const busyRef = useRef(false);
  const dialogRef = useFocusTrap(isOpen, () => {
    if (!busyRef.current) {
      onCancel();
    }
  });

  const setBusy = (busy: boolean) => {
    busyRef.current = busy;
  };

  if (!layer) {
    return null;
  }

  return createPortal(
    <div className={styles.overlay}>
      <section
        aria-labelledby="admin-deck-spec-title"
        aria-modal="true"
        className={styles.dialog}
        ref={dialogRef}
        role="dialog"
        tabIndex={-1}
      >
        <h2 className={styles.title} id="admin-deck-spec-title">
          {locale === "ko" ? "상세사이즈" : "Size chart"} · {productName}
          {size === undefined ? "" : ` · ${size}`}
        </h2>
        {/* 칩에서 연 옵션 모달이면 size와 이름 칸용 otherOptions가 있고, 없으면 기본값 모달입니다. */}
        <AdminDeckSpecForm
          describeError={describeError}
          initialSpec={initialSpec}
          locale={locale}
          notice={notice}
          onBusyChange={setBusy}
          onCancel={onCancel}
          onSave={onSave}
          otherOptions={otherOptions}
          size={size}
        />
      </section>
    </div>,
    layer,
  );
}
