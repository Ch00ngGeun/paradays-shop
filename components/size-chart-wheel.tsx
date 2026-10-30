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
      className={styles.diagram}
      role="img"
      viewBox="20 0 320 500"
    >
      <g className={styles.outline}>
        {/* 바닥에 닿는 면은 평평하고, 양옆 가장자리는 비스듬히 깎였습니다. */}
        <path d="M 140 110 H 240 Q 248 110 252 118 L 260 150 V 390 L 252 422 Q 248 430 240 430 H 140 Q 132 430 128 422 L 120 390 V 150 L 128 118 Q 132 110 140 110 Z" />
        <path d="M 140 110 V 430 M 240 110 V 430" />
      </g>
      <g>
        {/* 폭을 재는 기준선: 바깥 가장자리와 바닥 닿는 면의 끝 */}
        <path
          className={styles.guide}
          d="M 120 50 V 146 M 260 50 V 146 M 140 86 V 108 M 240 86 V 108 M 120 394 V 468 M 260 394 V 468"
        />
        {/* W 전체 폭(위·아래), T 바닥 닿는 폭(위) */}
        <SizeChartArrow x1={120} y1={56} x2={260} y2={56} />
        <SizeChartArrow x1={140} y1={92} x2={240} y2={92} />
        <SizeChartArrow x1={120} y1={462} x2={260} y2={462} />
        {/* 지름: 바닥 닿는 면 위 끝부터 아래 끝까지 */}
        <path className={styles.guide} d="M 78 110 H 138 M 78 430 H 138" />
        <SizeChartArrow x1={84} y1={110} x2={84} y2={430} />
      </g>
      <SizeChartValue kind={kind} value={values.width} x={190} y={38} />
      <SizeChartValue kind={kind} value={values.contactWidth} x={190} y={76} />
      <SizeChartValue kind={kind} value={values.width} x={190} y={482} />
      <SizeChartValue kind={kind} rotate={-90} value={values.diameter} x={62} y={270} />
    </svg>
  );
}
