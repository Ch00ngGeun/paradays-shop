"use client";
import {
  useCallback,
  useLayoutEffect,
  useRef,
  useState,
  type RefObject,
  type TextareaHTMLAttributes,
} from "react";
import styles from "./admin-dashboard.module.css";

/**
 * 상품명은 최대 2줄입니다. 빈 줄은 줄바꿈 하나로 합치고, 3번째 줄부터는 지우지 않고 2번째 줄 뒤에 공백으로 이어 붙입니다.
 * 커서 위치는 커서 앞부분에 같은 처리를 한 길이로 옮깁니다.
 */
export function limitProductNameLines(value: string) {
  const [first, second, ...extra] = value
    .replace(/\r\n?/g, "\n")
    .replace(/\n{2,}/g, "\n")
    .split("\n");
  // Empty extra lines (such as a trailing break) are dropped without adding a space.
  const joined = extra.filter(Boolean);
  if (second === undefined) return { value: first, merged: false };
  return {
    value: [first, [second, ...joined].join(" ")].join("\n"),
    merged: joined.length > 0,
  };
}

/** 자동 높이를 지원하지 않는 브라우저에서 상품명 상자 높이를 내용에 맞춥니다. */
export function fitProductNameInput(input: HTMLTextAreaElement) {
  input.style.height = "auto";
  input.style.height = `${input.scrollHeight + input.offsetHeight - input.clientHeight}px`;
}

export type GrowingLineInputProps = Omit<
  TextareaHTMLAttributes<HTMLTextAreaElement>,
  "onChange" | "rows" | "value"
> & {
  value: string;
  onValueChange: (value: string) => void;
  inputRef?: RefObject<HTMLTextAreaElement | null>;
};

/**
 * 한 줄 값이지만 길면 줄이 접히며 늘어나 입력 중에 잘리지 않는 칸입니다.
 * Enter는 기존 한 줄 칸처럼 폼을 제출하고, 붙여넣은 줄바꿈은 공백으로 바꿉니다(길이가 같아 커서도 그대로).
 */
export function GrowingLineInput({
  value,
  onValueChange,
  inputRef,
  className,
  ...props
}: GrowingLineInputProps) {
  const ownRef = useRef<HTMLTextAreaElement | null>(null);
  const observerRef = useRef<ResizeObserver | null>(null);
  const caretRef = useRef<number | null>(null);
  const [caretTick, setCaretTick] = useState(0);
  const attach = useCallback(
    (input: HTMLTextAreaElement | null) => {
      ownRef.current = input;
      if (inputRef) inputRef.current = input;
      observerRef.current?.disconnect();
      observerRef.current = null;
      if (!input || CSS.supports("field-sizing", "content")) return;
      fitProductNameInput(input);
      let width = input.clientWidth;
      observerRef.current = new ResizeObserver(() => {
        if (input.clientWidth === width) return;
        width = input.clientWidth;
        fitProductNameInput(input);
      });
      observerRef.current.observe(input);
    },
    [inputRef],
  );
  useLayoutEffect(() => {
    const input = ownRef.current;
    if (!input) return;
    if (!CSS.supports("field-sizing", "content")) fitProductNameInput(input);
    const caret = caretRef.current;
    caretRef.current = null;
    if (caret !== null && document.activeElement === input)
      input.setSelectionRange(caret, caret);
  }, [value, caretTick]);
  return (
    <textarea
      {...props}
      className={
        className ? `${styles.growingInput} ${className}` : styles.growingInput
      }
      onChange={(event) => {
        const input = event.target;
        const single = input.value.replace(/[\r\n]/g, " ");
        if (single !== input.value) {
          caretRef.current = input.selectionStart;
          setCaretTick((tick) => tick + 1);
        }
        onValueChange(single);
      }}
      onKeyDown={(event) => {
        if (event.key !== "Enter" || event.nativeEvent.isComposing) return;
        event.preventDefault();
        // Like a one-line input's implicit submission: only through the form's first submit button,
        // and nothing at all while that button is disabled (for example, the form is incomplete).
        const form = event.currentTarget.form;
        const submitter = Array.from(form?.elements ?? []).find(
          (element): element is HTMLButtonElement | HTMLInputElement =>
            (element instanceof HTMLButtonElement && element.type === "submit") ||
            (element instanceof HTMLInputElement &&
              (element.type === "submit" || element.type === "image")),
        );
        if (form && submitter && !submitter.matches(":disabled"))
          form.requestSubmit(submitter);
      }}
      ref={attach}
      rows={1}
      value={value}
    />
  );
}

/** 관리자 검색은 줄바꿈·연속 공백을 공백 하나로 보고 비교합니다. */
export function normalizeSearchText(value: string) {
  return value.replace(/\s+/g, " ").trim().toLowerCase();
}
