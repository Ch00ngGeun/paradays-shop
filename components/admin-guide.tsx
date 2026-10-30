// 역할: 화면의 실제 요소 위에 동그라미·밑줄·화살표를 그리고 말풍선으로 할 일을 한 단계씩 짚어 주는 화면 안내입니다.
"use client";

import { useCallback, useEffect, useId, useRef, useState, type RefObject } from "react";
import { createPortal } from "react-dom";

import { useFocusTrap } from "@/hooks/use-focus-trap";
import { useModalLayer } from "@/hooks/use-modal-layer";
import type { Locale } from "@/types/store";

import styles from "./admin-guide.module.css";

/** 안내 한 단계. target은 화면 요소의 data-admin-guide 값입니다. */
export type AdminGuideStep = Readonly<{
  target: string;
  title: string;
  body: string;
  /** 입력칸은 밑줄, 그 밖은 둥근 사각형으로 표시합니다. */
  mark?: "ring" | "underline";
}>;

export type GuideRect = Readonly<{
  left: number;
  top: number;
  width: number;
  height: number;
}>;
type Size = Readonly<{ width: number; height: number }>;

const GAP = 14;
const EDGE = 12;
const RING_PADDING = 6;

/**
 * 말풍선을 대상 아래에 두고, 아래 공간이 모자라면 위에 둡니다. 화면 밖으로 나가지 않게 좌우·상하를 맞추고,
 * 말풍선 가장자리에서 대상 가장자리로 이어지는 화살표 좌표도 돌려줍니다.
 */
export function placeGuideBubble(target: GuideRect, bubble: Size, viewport: Size) {
  const below = target.top + target.height + GAP;
  const above = target.top - GAP - bubble.height;
  const side =
    below + bubble.height <= viewport.height - EDGE || above < EDGE ? "below" : "above";
  const clamp = (value: number, max: number) => Math.max(EDGE, Math.min(value, max));
  const left = clamp(
    target.left + target.width / 2 - bubble.width / 2,
    viewport.width - EDGE - bubble.width,
  );
  const top = clamp(
    side === "below" ? below : above,
    viewport.height - EDGE - bubble.height,
  );
  const targetX = target.left + target.width / 2;
  const fromX = clamp(targetX, left + bubble.width - EDGE);
  return {
    left,
    top,
    side,
    arrow:
      side === "below"
        ? { x1: fromX, y1: top, x2: targetX, y2: target.top + target.height + 2 }
        : { x1: fromX, y1: top + bubble.height, x2: targetX, y2: target.top - 2 },
  } as const;
}

/** 대상 둘레의 둥근 사각형, 또는 입력칸 아래의 밑줄 좌표입니다. */
export function guideMarkShape(
  target: GuideRect,
  mark: AdminGuideStep["mark"] = "ring",
) {
  if (mark === "underline") {
    const y = target.top + target.height + 3;
    return {
      kind: "underline",
      x1: target.left,
      y1: y,
      x2: target.left + target.width,
      y2: y,
    } as const;
  }
  return {
    kind: "ring",
    x: target.left - RING_PADDING,
    y: target.top - RING_PADDING,
    width: target.width + RING_PADDING * 2,
    height: target.height + RING_PADDING * 2,
  } as const;
}

/** from에서 direction 쪽으로 가며 화면에 있는 첫 단계의 번호입니다. 없으면 -1입니다. */
export function nextGuideStep(
  steps: readonly AdminGuideStep[],
  from: number,
  direction: 1 | -1,
  isAvailable: (step: AdminGuideStep) => boolean,
) {
  for (
    let index = from + direction;
    index >= 0 && index < steps.length;
    index += direction
  )
    if (isAvailable(steps[index])) return index;
  return -1;
}

/**
 * Esc는 화면 맨 위 modal layer(body에 가장 나중에 붙은 것)의 대화상자만 닫습니다.
 * 도움말('?')과 화면 안내는 열리면 나머지 화면을 모두 inert로 만들어 서로의 위에 열릴 수 없지만,
 * 어떤 순서로 겹치더라도 맨 위 하나만 닫히도록 DOM 순서로 판단합니다.
 */
export function isTopModalLayer(layer: unknown, bodyChildren: readonly unknown[]) {
  const layers = bodyChildren.filter(
    (child) =>
      typeof child === "object" &&
      child !== null &&
      (child as { dataset?: Record<string, string> }).dataset?.modalLayer === "true",
  );
  return layers.length > 0 && layers.at(-1) === layer;
}

/** 현재 단계의 대상이 사라졌을 때 갈 단계: 뒤쪽 먼저, 없으면 앞쪽, 둘 다 없으면 -1(빈 상태). */
export function recoverGuideStep(
  steps: readonly AdminGuideStep[],
  index: number,
  isAvailable: (step: AdminGuideStep) => boolean,
) {
  const forward = nextGuideStep(steps, index, 1, isAvailable);
  return forward !== -1 ? forward : nextGuideStep(steps, index, -1, isAvailable);
}

export function adminGuideLabels(locale: Locale) {
  return locale === "ko"
    ? {
        open: "화면 도움말",
        visible: "도움말",
        previous: "이전",
        next: "다음",
        done: "완료",
        close: "닫기",
        empty: "이 화면에서 지금 짚어 줄 항목이 없습니다.",
        count: (position: number, total: number) => `${position}/${total}단계`,
      }
    : {
        open: "Screen help",
        visible: "Help",
        previous: "Back",
        next: "Next",
        done: "Done",
        close: "Close",
        empty: "Nothing on this screen to point out right now.",
        count: (position: number, total: number) => `Step ${position} of ${total}`,
      };
}

function findTarget(target: string) {
  return document.querySelector<HTMLElement>(
    `[data-admin-guide="${CSS.escape(target)}"]`,
  );
}

/** 화면에 실제로 보이는 대상만 안내합니다(접혔거나 메뉴 안에 숨으면 크기가 0입니다). */
function isOnScreen(step: AdminGuideStep) {
  const element = findTarget(step.target);
  if (!element) return false;
  const rect = element.getBoundingClientRect();
  return rect.width > 0 && rect.height > 0;
}

/** '? 도움말' 버튼. 누르면 화면 위에 단계별 안내를 띄우고, 닫으면 이 버튼으로 포커스를 돌려줍니다. */
export function AdminGuideButton({
  steps,
  locale,
}: Readonly<{ steps: readonly AdminGuideStep[]; locale: Locale }>) {
  const labels = adminGuideLabels(locale);
  const [open, setOpen] = useState(false);
  const buttonRef = useRef<HTMLButtonElement>(null);
  const wasOpen = useRef(false);
  // Runs after the guide layer is gone, so the background is no longer inert when focus returns.
  useEffect(() => {
    if (wasOpen.current && !open) buttonRef.current?.focus();
    wasOpen.current = open;
  }, [open]);

  return (
    <>
      <button
        aria-haspopup="dialog"
        aria-label={labels.open}
        className={styles.button}
        onClick={() => setOpen(true)}
        ref={buttonRef}
        type="button"
      >
        <span aria-hidden="true" className={styles.mark}>
          ?
        </span>
        <span aria-hidden="true">{labels.visible}</span>
      </button>
      {open ? (
        <GuideOverlay
          labels={labels}
          onClose={() => setOpen(false)}
          owner={buttonRef}
          steps={steps}
        />
      ) : null}
    </>
  );
}

function GuideOverlay({
  steps,
  labels,
  onClose,
  owner,
}: Readonly<{
  steps: readonly AdminGuideStep[];
  labels: ReturnType<typeof adminGuideLabels>;
  onClose: () => void;
  owner: RefObject<HTMLButtonElement | null>;
}>) {
  const layer = useModalLayer(true);
  // Esc is handled below so only the top layer closes; the trap still keeps Tab inside.
  const dialogRef = useFocusTrap(true, () => {});
  const titleId = useId();
  const onCloseRef = useRef(onClose);
  useEffect(() => {
    onCloseRef.current = onClose;
  }, [onClose]);
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== "Escape" || !layer) return;
      if (!isTopModalLayer(layer, Array.from(document.body.children))) return;
      event.preventDefault();
      event.stopPropagation();
      onCloseRef.current();
    };
    window.addEventListener("keydown", onKeyDown, true);
    return () => window.removeEventListener("keydown", onKeyDown, true);
  }, [layer]);
  const [index, setIndex] = useState(() => nextGuideStep(steps, -1, 1, isOnScreen));
  const [rect, setRect] = useState<GuideRect | null>(null);
  const [bubble, setBubble] = useState<Size>({ width: 320, height: 160 });
  const [viewport, setViewport] = useState<Size>(() => ({
    width: window.innerWidth,
    height: window.innerHeight,
  }));
  const step = index >= 0 ? steps[index] : null;
  const available = steps.filter(isOnScreen);
  const position = step ? available.indexOf(step) + 1 : 0;

  const measure = useCallback(() => {
    // The screen that opened the guide was hidden (another menu, browser Back): close with it.
    if (owner.current?.getClientRects().length === 0) return onCloseRef.current();
    setViewport({ width: window.innerWidth, height: window.innerHeight });
    if (!step || !isOnScreen(step)) {
      // The target went away mid-guide, or one appeared while empty: show a visible step, or the empty state.
      const next = recoverGuideStep(steps, index, isOnScreen);
      if (next !== index) setIndex(next);
      return setRect(null);
    }
    const element = step ? findTarget(step.target) : null;
    if (!element) return setRect(null);
    const { left, top, width, height } = element.getBoundingClientRect();
    setRect({ left, top, width, height });
    const box = (dialogRef.current as HTMLElement | null)?.getBoundingClientRect();
    if (box) setBubble({ width: box.width, height: box.height });
  }, [step, steps, index, dialogRef, owner]);

  // Bring the target into view, then follow it through scrolling, resizing and layout changes.
  useEffect(() => {
    const element = step ? findTarget(step.target) : null;
    const reduceMotion = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    element?.scrollIntoView({
      block: "center",
      inline: "nearest",
      behavior: reduceMotion ? "instant" : "smooth",
    });
    let frame = 0;
    const schedule = () => {
      cancelAnimationFrame(frame);
      frame = requestAnimationFrame(measure);
    };
    schedule();
    window.addEventListener("scroll", schedule, true);
    window.addEventListener("resize", schedule);
    const observer = new ResizeObserver(schedule);
    if (element) observer.observe(element);
    observer.observe(document.body);
    // Menus switch by toggling `hidden`, which may not change any observed size.
    const shown = new MutationObserver(schedule);
    shown.observe(document.body, { attributeFilter: ["hidden"], subtree: true });
    return () => {
      shown.disconnect();
      cancelAnimationFrame(frame);
      window.removeEventListener("scroll", schedule, true);
      window.removeEventListener("resize", schedule);
      observer.disconnect();
    };
  }, [step, measure]);

  if (!layer) return null;

  const go = (direction: 1 | -1) => {
    const next = nextGuideStep(steps, index, direction, isOnScreen);
    if (next !== -1) setIndex(next);
    else if (direction === 1) onClose();
  };
  const isLast = step !== null && nextGuideStep(steps, index, 1, isOnScreen) === -1;
  const isFirst = step === null || nextGuideStep(steps, index, -1, isOnScreen) === -1;
  const place = rect ? placeGuideBubble(rect, bubble, viewport) : null;
  const mark = rect && step ? guideMarkShape(rect, step.mark) : null;

  return createPortal(
    <div className={styles.overlay}>
      <svg
        aria-hidden="true"
        className={styles.drawing}
        height={viewport.height}
        width={viewport.width}
      >
        <defs>
          <mask id={`${titleId}-mask`}>
            <rect fill="white" height="100%" width="100%" />
            {mark?.kind === "ring" ? (
              <rect
                fill="black"
                height={mark.height}
                rx="8"
                width={mark.width}
                x={mark.x}
                y={mark.y}
              />
            ) : null}
          </mask>
          <marker
            id={`${titleId}-arrow`}
            markerHeight="8"
            markerWidth="8"
            orient="auto"
            refX="7"
            refY="4"
          >
            <path className={styles.arrowHead} d="M0,0 L8,4 L0,8 Z" />
          </marker>
        </defs>
        <rect
          className={styles.dim}
          height="100%"
          mask={`url(#${titleId}-mask)`}
          width="100%"
        />
        {mark?.kind === "ring" ? (
          <rect
            className={styles.ring}
            height={mark.height}
            rx="8"
            width={mark.width}
            x={mark.x}
            y={mark.y}
          />
        ) : null}
        {mark?.kind === "underline" ? (
          <line
            className={styles.underline}
            x1={mark.x1}
            x2={mark.x2}
            y1={mark.y1}
            y2={mark.y2}
          />
        ) : null}
        {place ? (
          <line
            className={styles.arrow}
            markerEnd={`url(#${titleId}-arrow)`}
            x1={place.arrow.x1}
            x2={place.arrow.x2}
            y1={place.arrow.y1}
            y2={place.arrow.y2}
          />
        ) : null}
      </svg>
      <section
        aria-labelledby={titleId}
        aria-modal="true"
        className={styles.bubble}
        data-centered={place ? undefined : "true"}
        onKeyDown={(event) => {
          if (event.key === "ArrowRight") go(1);
          else if (event.key === "ArrowLeft" && !isFirst) go(-1);
        }}
        ref={dialogRef}
        role="dialog"
        style={place ? { left: place.left, top: place.top } : undefined}
        tabIndex={-1}
      >
        {/* Announces each new step to screen readers while focus stays on the buttons. */}
        <div aria-live="polite" className={styles.content}>
          {step ? (
            <>
              <p className={styles.count}>{labels.count(position, available.length)}</p>
              <h2 className={styles.title} id={titleId}>
                {step.title}
              </h2>
              <p className={styles.body}>{step.body}</p>
            </>
          ) : (
            <h2 className={styles.title} id={titleId}>
              {labels.empty}
            </h2>
          )}
        </div>
        <div className={styles.actions}>
          <button className={styles.secondary} onClick={onClose} type="button">
            {labels.close}
          </button>
          {step ? (
            <>
              <button
                className={styles.secondary}
                disabled={isFirst}
                onClick={() => go(-1)}
                type="button"
              >
                {labels.previous}
              </button>
              <button
                className={styles.primary}
                data-autofocus
                onClick={() => go(1)}
                type="button"
              >
                {isLast ? labels.done : labels.next}
              </button>
            </>
          ) : null}
        </div>
      </section>
    </div>,
    layer,
  );
}
