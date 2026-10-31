// 역할: 상의 상세사이즈(반팔·래글런 긴팔)를 도면에 그리고, 측정 위치마다 값(cm·인치)을 표시합니다.
// 값 라벨·양방향 화살표는 하의·휠 도면도 같이 씁니다.
import {
  SIZE_CHART_KIND_INFO,
  formatSizeChartValue,
  type SizeChartKind,
  type SizeChartValues,
} from "@/lib/size-chart";
import type { Locale } from "@/types/store";

import styles from "./size-chart-diagram.module.css";

const HEAD = 7;

/** (fromX, fromY)에서 (x, y)로 향하는 끝에 화살촉을 그리는 path 조각입니다. */
export function arrowHead(x: number, y: number, fromX: number, fromY: number) {
  const angle = Math.atan2(y - fromY, x - fromX);
  const point = (turn: number) =>
    `${(x - HEAD * Math.cos(angle + turn)).toFixed(1)} ${(y - HEAD * Math.sin(angle + turn)).toFixed(1)}`;
  return `M ${point(0.45)} L ${x} ${y} L ${point(-0.45)}`;
}

/** 두 점 사이 양방향 화살표. */
export function SizeChartArrow({
  x1,
  y1,
  x2,
  y2,
}: Readonly<{ x1: number; y1: number; x2: number; y2: number }>) {
  return (
    <path
      className={styles.measure}
      d={`M ${x1} ${y1} L ${x2} ${y2} ${arrowHead(x1, y1, x2, y2)} ${arrowHead(x2, y2, x1, y1)}`}
    />
  );
}

/** 측정값 하나. 좁은 도면은 보조 인치를 다음 줄로 분리할 수 있습니다. */
export function SizeChartValue({
  kind,
  value,
  x,
  y,
  rotate,
  anchor = "middle",
}: Readonly<{
  kind: SizeChartKind;
  value: number | null;
  x: number;
  y: number;
  rotate?: number;
  anchor?: "start" | "middle" | "end";
}>) {
  // A blank field formats as "null" alone, so it gets no smaller inch part.
  const [main, sub] = formatSizeChartValue(kind, value).split(" ");
  const stacked = kind !== "wheel";
  return (
    <text
      className={styles.label}
      dominantBaseline="middle"
      textAnchor={anchor}
      transform={`translate(${x} ${y})${rotate ? ` rotate(${rotate})` : ""}`}
    >
      {main}
      {sub ? (
        <tspan className={styles.sub} {...(stacked ? { x: 0, dy: 30 } : { dx: 4 })}>
          {sub}
        </tspan>
      ) : null}
    </text>
  );
}

/** 화면 낭독용 설명: 도면 종류의 항목 순서대로 "이름 값"을 잇습니다. */
export function sizeChartDescription(
  kind: SizeChartKind,
  values: SizeChartValues,
  locale: Locale,
) {
  const info = SIZE_CHART_KIND_INFO[kind];
  return `${info.label[locale]}: ${info.fields
    .map(
      ({ key, label }) => `${label[locale]} ${formatSizeChartValue(kind, values[key])}`,
    )
    .join(", ")}`;
}

type TopProps = Readonly<{
  kind: "shortSleeve" | "raglanLongSleeve";
  values: SizeChartValues;
  locale: Locale;
}>;

/** 반팔(참고 57): 총장·어깨너비·가슴단면·소매길이·밑단단면·소매통·암홀. */
function ShortSleeve({ values }: Readonly<{ values: SizeChartValues }>) {
  const kind = "shortSleeve";
  return (
    <>
      <g className={styles.outline}>
        <path d="M 238 82 L 190 108 L 122 232 L 162 254 L 200 214 L 200 398 Q 280 410 360 398 L 360 214 L 398 254 L 438 232 L 370 108 L 322 82" />
        {/* 목둘레: 뒤판 위 곡선, 앞판 파인 곡선, 안쪽 시접 */}
        <path d="M 238 82 Q 280 70 322 82 M 238 82 Q 280 126 322 82 M 249 87 Q 280 114 311 87" />
        {/* 어깨에서 겨드랑이까지 진동 솔기 */}
        <path d="M 190 108 Q 207 160 200 214 M 370 108 Q 353 160 360 214" />
      </g>
      <g>
        {/* 1 총장: 목 옆 가장 높은 곳부터 밑단까지 */}
        <path className={styles.guide} d="M 92 76 H 240" />
        <SizeChartArrow x1={92} y1={76} x2={92} y2={402} />
        {/* 2 어깨너비 */}
        <SizeChartArrow x1={190} y1={50} x2={370} y2={50} />
        {/* 3 가슴단면: 겨드랑이 바로 아래 */}
        <SizeChartArrow x1={202} y1={230} x2={358} y2={230} />
        {/* 4 소매길이: 어깨 끝에서 소매 끝까지, 소매 바깥선 옆 */}
        <SizeChartArrow x1={389} y1={97} x2={457} y2={221} />
        {/* 5 밑단단면 */}
        <SizeChartArrow x1={200} y1={432} x2={360} y2={432} />
        {/* 6 소매통: 소매 끝 단면 */}
        <SizeChartArrow x1={446} y1={247} x2={406} y2={269} />
        {/* 7 암홀: 진동 솔기를 따라, 값은 몸판 안에 짧은 지시선으로 */}
        <SizeChartArrow x1={196} y1={114} x2={203} y2={206} />
        <path className={styles.measure} d="M 205 160 H 216" />
      </g>
      <SizeChartValue kind={kind} rotate={-90} value={values.length} x={40} y={240} />
      <SizeChartValue kind={kind} value={values.shoulder} x={280} y={32} />
      <SizeChartValue kind={kind} value={values.chest} x={280} y={252} />
      <SizeChartValue
        kind={kind}
        rotate={61}
        value={values.sleeveLength}
        x={441}
        y={150}
      />
      <SizeChartValue kind={kind} value={values.hem} x={280} y={460} />
      <SizeChartValue
        anchor="start"
        kind={kind}
        value={values.sleeveWidth}
        x={430}
        y={292}
      />
      <SizeChartValue
        anchor="start"
        kind={kind}
        value={values.armhole}
        x={220}
        y={160}
      />
    </>
  );
}

/** 래글런 긴팔(참고 55): 총장·가슴단면·소매부리·화장·밑단단면·암홀(래글런 사선). */
function RaglanLongSleeve({ values }: Readonly<{ values: SizeChartValues }>) {
  const kind = "raglanLongSleeve";
  return (
    <>
      <g className={styles.outline}>
        <path d="M 250 70 C 200 76 152 102 142 170 L 122 372 L 120 402 L 164 404 L 166 374 L 196 200 L 196 398 L 364 398 L 364 200 L 394 374 L 396 404 L 440 402 L 438 372 L 418 170 C 408 102 360 76 310 70" />
        {/* 시보리(소매 끝·밑단)와 앞여밈 */}
        <path d="M 122 372 H 166 M 394 374 H 438 M 196 382 H 364 M 280 100 V 398" />
        {/* 칼라 */}
        <path d="M 250 70 Q 280 58 310 70 M 250 70 L 280 100 L 310 70" />
        {/* 래글런 솔기: 목에서 겨드랑이까지 사선 */}
        <path d="M 254 76 Q 222 132 196 200 M 306 76 Q 338 132 364 200" />
      </g>
      <g>
        {/* 1 총장: 목 뒤 가장 높은 곳부터 밑단까지 */}
        <path className={styles.guide} d="M 92 62 H 280" />
        <SizeChartArrow x1={92} y1={62} x2={92} y2={398} />
        {/* 2 가슴단면 */}
        <SizeChartArrow x1={198} y1={216} x2={362} y2={216} />
        {/* 3 소매부리: 소매 끝 시보리 너비 */}
        <SizeChartArrow x1={396} y1={424} x2={440} y2={424} />
        {/* 4 화장: 목 뒤 중심에서 어깨를 지나 소매 끝까지 */}
        <path
          className={styles.measure}
          d={`M 282 44 C 384 44 452 108 458 190 L 462 400 ${arrowHead(282, 44, 300, 44)} ${arrowHead(462, 400, 461, 380)}`}
        />
        {/* 5 밑단단면 */}
        <SizeChartArrow x1={196} y1={432} x2={364} y2={432} />
        {/* 6 암홀: 래글런 솔기를 따라, 값은 몸판 안에 짧은 지시선으로 */}
        <SizeChartArrow x1={250} y1={84} x2={200} y2={192} />
        <path className={styles.measure} d="M 226 138 H 240" />
      </g>
      <SizeChartValue kind={kind} rotate={-90} value={values.length} x={40} y={232} />
      <SizeChartValue kind={kind} value={values.chest} x={280} y={238} />
      <SizeChartValue anchor="start" kind={kind} value={values.cuff} x={450} y={424} />
      <SizeChartValue
        kind={kind}
        rotate={90}
        value={values.neckToCuff}
        x={486}
        y={262}
      />
      <SizeChartValue kind={kind} value={values.hem} x={280} y={460} />
      <SizeChartValue
        anchor="start"
        kind={kind}
        value={values.armhole}
        x={246}
        y={138}
      />
    </>
  );
}

/** 상의 도면. 윤곽과 화살표는 고정이고 값만 상품마다 바뀝니다. */
export function SizeChartTop({ kind, values, locale }: TopProps) {
  return (
    <svg
      aria-label={sizeChartDescription(kind, values, locale)}
      className={`${styles.diagram} ${styles.readable}`}
      role="img"
      viewBox="10 0 590 520"
    >
      {kind === "shortSleeve" ? (
        <ShortSleeve values={values} />
      ) : (
        <RaglanLongSleeve values={values} />
      )}
    </svg>
  );
}
