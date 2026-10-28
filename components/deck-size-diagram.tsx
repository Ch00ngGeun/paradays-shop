// 역할: 데크 상세사이즈(인치)를 nose·tail·width·length·wheelbase 도면에 숫자로 그리고 cm 환산값을 함께 표시합니다.
import type { DeckSpec } from "@/types/store";

import styles from "./deck-size-diagram.module.css";

/** 인치를 cm로 바꿔 소수 첫째 자리까지 표시합니다. 25.4mm 단위로 반올림해 부동소수 오차를 피합니다. */
export function formatDeckCm(inches: number) {
  return `${(Math.round(inches * 25.4) / 10).toFixed(1)}cm`;
}

export function formatDeckInches(inches: number) {
  return `${inches}"`;
}

type DiagramLabelProps = Readonly<{
  inches: number;
  x: number;
  y: number;
  rotate?: number;
}>;

/** 인치 값 옆에 더 작고 옅은 cm 환산값을 붙입니다. */
function DiagramLabel({ inches, x, y, rotate }: DiagramLabelProps) {
  return (
    <text
      className={styles.label}
      textAnchor="middle"
      dominantBaseline="middle"
      transform={`translate(${x} ${y})${rotate ? ` rotate(${rotate})` : ""}`}
    >
      {formatDeckInches(inches)}
      <tspan className={styles.cm} dx="4">
        ({formatDeckCm(inches)})
      </tspan>
    </text>
  );
}

/** 1번 시안처럼 세로 데크 윤곽과 치수 괄호를 고정 비율로 그립니다. 숫자만 상품별로 바뀝니다. */
export function DeckSizeDiagram({ spec }: Readonly<{ spec: DeckSpec }>) {
  const description = (["nose", "tail", "width", "length", "wheelbase"] as const)
    .map(
      (field) =>
        `${field} ${formatDeckInches(spec[field])} (${formatDeckCm(spec[field])})`,
    )
    .join(", ");

  return (
    <svg
      aria-label={description}
      className={styles.diagram}
      role="img"
      viewBox="0 0 360 620"
    >
      <g className={styles.outline}>
        <rect height="540" rx="70" width="140" x="110" y="40" />
        {[180, 210, 410, 440].map((y) =>
          [165, 195].map((x) => (
            <rect height="5" key={`${x}-${y}`} width="5" x={x - 2.5} y={y - 2.5} />
          )),
        )}
        {/* length: 왼쪽 큰 괄호 */}
        <path d="M 80 40 H 70 V 580 H 80" />
        {/* width: 데크 가운데 양방향 화살표 */}
        <path d="M 112 330 H 248 M 122 323 L 112 330 L 122 337 M 238 323 L 248 330 L 238 337" />
        {/* nose·wheelbase·tail: 오른쪽 괄호 */}
        <path d="M 270 40 H 280 V 160 H 270" />
        <path d="M 270 180 H 280 V 440 H 270" />
        <path d="M 270 460 H 280 V 580 H 270" />
      </g>
      {/* 앞뒤 구분: 윤곽 위·아래 끝 바로 바깥 */}
      <text
        className={styles.label}
        dominantBaseline="middle"
        textAnchor="middle"
        x="180"
        y="20"
      >
        nose
      </text>
      <text
        className={styles.label}
        dominantBaseline="middle"
        textAnchor="middle"
        x="180"
        y="600"
      >
        tail
      </text>
      <DiagramLabel inches={spec.length} rotate={-90} x={45} y={310} />
      <DiagramLabel inches={spec.width} x={180} y={310} />
      <DiagramLabel inches={spec.nose} rotate={90} x={305} y={100} />
      <DiagramLabel inches={spec.wheelbase} rotate={90} x={305} y={310} />
      <DiagramLabel inches={spec.tail} rotate={90} x={305} y={520} />
    </svg>
  );
}
