// 역할: 하의 상세사이즈(긴바지·반바지)를 도면에 그리고, 측정 위치마다 값(cm·인치)을 표시합니다.
import type { SizeChartValues } from "@/lib/size-chart";
import type { Locale } from "@/types/store";

import styles from "./size-chart-diagram.module.css";
import { SizeChartArrow, SizeChartValue, sizeChartDescription } from "./size-chart-top";

type BottomKind = "longPants" | "shorts";

/** 긴바지(참고 56): 총장·허리단면·엉덩이단면·허벅지단면·밑위·밑단단면. */
function LongPants({ values }: Readonly<{ values: SizeChartValues }>) {
  const kind = "longPants";
  return (
    <>
      <g className={styles.outline}>
        <path d="M 200 60 H 360 L 362 82 Q 370 120 368 165 L 362 410 L 292 412 L 281 196 H 279 L 268 412 L 198 410 L 192 165 Q 190 120 198 82 Z" />
        {/* 허리 밴드·단추·앞여밈 */}
        <path d="M 198 82 H 362 M 280 82 V 186 M 292 90 V 166 Q 292 182 281 190" />
        <circle cx="290" cy="71" r="4" />
        {/* 앞주머니 */}
        <path d="M 204 96 Q 230 98 234 120 L 196 122 M 356 96 Q 330 98 326 120 L 364 122" />
      </g>
      <g>
        {/* 1 총장: 허리 위부터 밑단까지 바깥선 */}
        <SizeChartArrow x1={150} y1={60} x2={150} y2={410} />
        {/* 2 허리단면 */}
        <SizeChartArrow x1={200} y1={40} x2={360} y2={40} />
        {/* 3 엉덩이단면 */}
        <SizeChartArrow x1={193} y1={184} x2={367} y2={184} />
        {/* 4 허벅지단면: 밑위 바로 아래 한쪽 다리 */}
        <SizeChartArrow x1={284} y1={228} x2={366} y2={228} />
        {/* 인접한 두 치수는 지시선으로 값을 벌려 어느 측정선인지 구분합니다. */}
        <path
          className={styles.measure}
          d="M 367 184 H 380 L 390 166 M 366 228 H 380 L 390 272"
        />
        {/* 5 밑위: 허리 위부터 가랑이까지 */}
        <SizeChartArrow x1={268} y1={60} x2={268} y2={194} />
        {/* 6 밑단단면 */}
        <SizeChartArrow x1={198} y1={440} x2={268} y2={440} />
      </g>
      <SizeChartValue kind={kind} rotate={-90} value={values.length} x={128} y={235} />
      <SizeChartValue kind={kind} value={values.waist} x={280} y={22} />
      <SizeChartValue anchor="start" kind={kind} value={values.hip} x={390} y={166} />
      <SizeChartValue anchor="start" kind={kind} value={values.thigh} x={390} y={272} />
      <SizeChartValue kind={kind} rotate={-90} value={values.rise} x={250} y={142} />
      <SizeChartValue kind={kind} value={values.hem} x={233} y={462} />
    </>
  );
}

/** 반바지(참고 54): 긴바지와 같은 항목을 짧은 다리에 표시합니다. */
function Shorts({ values }: Readonly<{ values: SizeChartValues }>) {
  const kind = "shorts";
  return (
    <>
      <g className={styles.outline}>
        <path d="M 200 70 H 360 L 362 96 L 384 380 L 290 384 L 281 292 H 279 L 270 384 L 176 380 L 198 96 Z" />
        <path d="M 198 96 H 362 M 280 96 V 270 M 294 104 V 252 Q 294 270 281 278" />
        <circle cx="292" cy="83" r="4" />
        <path d="M 206 110 Q 230 112 234 134 L 196 136 M 354 110 Q 330 112 326 134 L 364 136" />
      </g>
      <g>
        <SizeChartArrow x1={140} y1={70} x2={140} y2={380} />
        <SizeChartArrow x1={200} y1={46} x2={360} y2={46} />
        <SizeChartArrow x1={189} y1={220} x2={371} y2={220} />
        <SizeChartArrow x1={284} y1={304} x2={377} y2={304} />
        <SizeChartArrow x1={268} y1={70} x2={268} y2={290} />
        <SizeChartArrow x1={176} y1={412} x2={270} y2={412} />
      </g>
      <SizeChartValue kind={kind} rotate={-90} value={values.length} x={118} y={225} />
      <SizeChartValue kind={kind} value={values.waist} x={280} y={28} />
      <SizeChartValue anchor="start" kind={kind} value={values.hip} x={394} y={220} />
      <SizeChartValue anchor="start" kind={kind} value={values.thigh} x={398} y={304} />
      <SizeChartValue kind={kind} rotate={-90} value={values.rise} x={250} y={150} />
      <SizeChartValue kind={kind} value={values.hem} x={223} y={434} />
    </>
  );
}

/** 하의 도면. 윤곽과 화살표는 고정이고 값만 상품마다 바뀝니다. */
export function SizeChartBottom({
  kind,
  values,
  locale,
}: Readonly<{ kind: BottomKind; values: SizeChartValues; locale: Locale }>) {
  return (
    <svg
      aria-label={sizeChartDescription(kind, values, locale)}
      className={`${styles.diagram} ${styles.readable}`}
      role="img"
      viewBox="90 0 510 520"
    >
      {kind === "longPants" ? (
        <LongPants values={values} />
      ) : (
        <Shorts values={values} />
      )}
    </svg>
  );
}
