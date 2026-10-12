// 역할: 승인된 PARADAYS 워드마크 로고를 헤더 슬롯에 렌더링합니다.
import Image from "next/image";

import styles from "./logo-placeholder.module.css";

type LogoPlaceholderProps = {
  /** true면 좁은 헤더/컴팩트 슬롯용 작은 로고 */
  compact?: boolean;
};

/**
 * 브랜드 로고 이미지.
 * 홈 링크 래퍼는 Header에서 감싸며, 이 컴포넌트는 마크 자체만 그립니다.
 */
export function LogoPlaceholder({ compact = false }: LogoPlaceholderProps) {
  return (
    <Image
      className={compact ? styles.compact : styles.mark}
      src="/brand/paradays-logo.jpg"
      alt="PARADAYS"
      width={compact ? 140 : 220}
      height={compact ? 22 : 34}
      priority
    />
  );
}
