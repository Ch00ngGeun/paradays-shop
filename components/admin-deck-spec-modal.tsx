// 역할: 관리자가 데크 상세사이즈(인치)를 입력·미리보기하고, 모달의 저장 버튼으로 서버에 즉시 저장하게 합니다.
"use client";

import { useRef, useState, type FormEvent } from "react";
import { createPortal } from "react-dom";

import { useFocusTrap } from "@/hooks/use-focus-trap";
import { useModalLayer } from "@/hooks/use-modal-layer";
import type { DeckSpec } from "@/types/store";

import styles from "./admin-deck-spec-modal.module.css";
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

/** 5칸이 모두 올바를 때만 저장 가능한 상세사이즈를 만듭니다. */
export function parseDeckSpecInputs(inputs: DeckSpecInputs): DeckSpec | null {
  const values = DECK_SPEC_FIELDS.map((field) => parseDeckInches(inputs[field]));

  if (values.some((value) => value === null)) {
    return null;
  }

  const [nose, tail, width, length, wheelbase] = values as number[];

  return { nose, tail, width, length, wheelbase };
}

function toInputs(spec?: DeckSpec): DeckSpecInputs {
  return {
    nose: spec ? String(spec.nose) : "",
    tail: spec ? String(spec.tail) : "",
    width: spec ? String(spec.width) : "",
    length: spec ? String(spec.length) : "",
    wheelbase: spec ? String(spec.wheelbase) : "",
  };
}

type AdminDeckSpecFormProps = Readonly<{
  initialSpec?: DeckSpec;
  onCancel: () => void;
  onSave: (spec: DeckSpec | null) => Promise<void>;
  /** 저장 중 여부를 모달에 알려 ESC로 닫히지 않게 합니다. */
  onBusyChange?: (busy: boolean) => void;
}>;

/** 모달 본문. 저장 성공 시 caller가 모달을 닫고, 실패하면 입력값을 그대로 두고 오류를 보여 줍니다. */
export function AdminDeckSpecForm({
  initialSpec,
  onCancel,
  onSave,
  onBusyChange,
}: AdminDeckSpecFormProps) {
  const [inputs, setInputs] = useState(() => toInputs(initialSpec));
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const spec = parseDeckSpecInputs(inputs);

  const submit = async (next: DeckSpec | null) => {
    setSaving(true);
    onBusyChange?.(true);
    setError(null);

    try {
      await onSave(next);
    } catch {
      setError("저장하지 못했습니다. 입력값은 그대로 두었으니 다시 저장해 주세요.");
      setSaving(false);
    } finally {
      onBusyChange?.(false);
    }
  };

  const handleSubmit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    // The portal still bubbles React events into the product form, which must not save too.
    event.stopPropagation();

    if (spec && !saving) {
      void submit(spec);
    }
  };

  return (
    <form className={styles.form} noValidate onSubmit={handleSubmit}>
      <div className={styles.fields}>
        {DECK_SPEC_FIELDS.map((field) => {
          const inches = parseDeckInches(inputs[field]);
          const invalid = inputs[field].trim() !== "" && inches === null;

          return (
            <label className={styles.field} key={field}>
              <span className={styles.fieldName}>{field}</span>
              <span className={styles.inputRow}>
                <input
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
        <p className={styles.hint}>
          인치로 입력하면 cm는 자동으로 계산됩니다. 0 초과 100 이하.
        </p>
      </div>

      <div className={styles.preview}>
        {spec ? (
          <DeckSizeDiagram spec={spec} />
        ) : (
          <p className={styles.previewEmpty}>
            5칸을 모두 입력하면 도면 미리보기가 나타납니다.
          </p>
        )}
      </div>

      {error ? (
        <p className={styles.error} role="alert">
          {error}
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
            삭제
          </button>
        ) : null}
        <button
          className={styles.cancelButton}
          disabled={saving}
          onClick={onCancel}
          type="button"
        >
          취소
        </button>
        <button className={styles.saveButton} disabled={!spec || saving} type="submit">
          {saving ? "저장 중…" : "저장"}
        </button>
      </div>
    </form>
  );
}

type AdminDeckSpecModalProps = AdminDeckSpecFormProps &
  Readonly<{ isOpen: boolean; productName: string }>;

/** body 아래 독립 layer에 띄우고 배경을 inert 처리합니다. 배경 클릭으로는 닫지 않고, 저장 중이 아닐 때 ESC·취소로만 닫습니다. */
export function AdminDeckSpecModal({
  isOpen,
  productName,
  initialSpec,
  onCancel,
  onSave,
}: AdminDeckSpecModalProps) {
  const layer = useModalLayer(isOpen);
  const busyRef = useRef(false);
  const dialogRef = useFocusTrap(isOpen, () => {
    if (!busyRef.current) {
      onCancel();
    }
  });

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
          상세사이즈 · {productName}
        </h2>
        <AdminDeckSpecForm
          initialSpec={initialSpec}
          onBusyChange={(busy) => {
            busyRef.current = busy;
          }}
          onCancel={onCancel}
          onSave={onSave}
        />
      </section>
    </div>,
    layer,
  );
}
