// 역할: PARADAYS 스토어프론트의 제품 중심 홈 라우트를 렌더링합니다.
import { ProductGrid } from "@/components/product-grid";

import styles from "./page.module.css";

/** `/` 홈: 카탈로그 그리드만 노출하는 진입 페이지 */
export default function HomePage() {
  return (
    <section className={styles.catalog} aria-label="PARADAYS 상품 목록">
      <ProductGrid />
    </section>
  );
}
