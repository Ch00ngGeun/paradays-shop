// 역할: 휠 상세사이즈(지름·W 전체 폭·T 바닥 닿는 폭)를 옆모습 도면에 mm로 표시합니다.
import type { SizeChartValues } from "@/lib/size-chart";
import type { Locale } from "@/types/store";

import styles from "./size-chart-diagram.module.css";
import { SizeChartArrow, SizeChartValue, sizeChartDescription } from "./size-chart-top";

/** 휠(참고 58): 위·아래 W(전체 폭)·위 T(바닥 닿는 폭)에 왼쪽 세로 지름을 더했습니다. */
export function SizeChartWheel({
  values,
  locale,
}: Readonly<{ values: SizeChartValues; locale: Locale }>) {
  const kind = "wheel";
  return (
    <svg
      aria-label={sizeChartDescription(kind, values, locale)}
      className={`${styles.diagram} ${styles.readable}`}
      role="img"
      viewBox="20 0 320 560"
    >
      <g className={styles.outline}>
        {/* 바닥에 닿는 면은 평평하고, 양옆 가장자리는 비스듬히 깎였습니다. */}
        <path d="M 140 150 H 240 Q 248 150 252 158 L 260 190 V 430 L 252 462 Q 248 470 240 470 H 140 Q 132 470 128 462 L 120 430 V 190 L 128 158 Q 132 150 140 150 Z" />
        <path d="M 140 150 V 470 M 240 150 V 470" />
      </g>
      <g>
        {/* 폭을 재는 기준선: 바깥 가장자리와 바닥 닿는 면의 끝 */}
        <path
          className={styles.guide}
          d="M 120 54 V 186 M 260 54 V 186 M 140 122 V 148 M 240 122 V 148 M 120 434 V 508 M 260 434 V 508"
        />
        {/* W 전체 폭(위·아래), T 바닥 닿는 폭(위) */}
        <SizeChartArrow x1={120} y1={60} x2={260} y2={60} />
        <SizeChartArrow x1={140} y1={128} x2={240} y2={128} />
        <SizeChartArrow x1={120} y1={502} x2={260} y2={502} />
        {/* 지름: 바닥 닿는 면 위 끝부터 아래 끝까지 */}
        <path className={styles.guide} d="M 78 150 H 138 M 78 470 H 138" />
        <SizeChartArrow x1={84} y1={150} x2={84} y2={470} />
      </g>
      <SizeChartValue kind={kind} value={values.width} x={190} y={28} />
      <SizeChartValue kind={kind} value={values.contactWidth} x={190} y={96} />
      <SizeChartValue kind={kind} value={values.width} x={190} y={534} />
      <SizeChartValue kind={kind} rotate={-90} value={values.diameter} x={50} y={310} />
    </svg>
  );
}
