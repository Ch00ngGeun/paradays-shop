// 역할: 스크롤 방향에 따라 고정 헤더를 숨기거나 다시 보이게 합니다.
"use client";

import { useEffect, useState } from "react";

/** 미세 스크롤·트랙패드 떨림을 무시하는 최소 이동량(px) */
const SCROLL_DELTA_THRESHOLD = 6;
/** 이 높이 이하에서는 항상 헤더를 노출합니다. */
const TOP_REVEAL_OFFSET = 8;

/**
 * 아래로 스크롤하면 헤더를 숨기고, 살짝만 올려도 다시 나타나게 합니다.
 * 맨 위(scrollY ≈ 0)로 돌아갈 필요는 없습니다.
 * forceVisible이 true이면(메뉴·검색 오버레이 등) 항상 보입니다.
 */
export function useHeaderScroll(forceVisible = false) {
  const [isHidden, setIsHidden] = useState(false);

  useEffect(() => {
    if (forceVisible) {
      // 메뉴·검색을 여는 렌더와 effect 동기 state 갱신이 충돌하지 않게 다음 frame에서 노출합니다.
      const revealFrame = window.requestAnimationFrame(() => setIsHidden(false));

      return () => window.cancelAnimationFrame(revealFrame);
    }

    let lastScrollY = window.scrollY;
    let ticking = false;

    const updateVisibility = () => {
      const currentScrollY = Math.max(0, window.scrollY);
      const delta = currentScrollY - lastScrollY;

      if (currentScrollY <= TOP_REVEAL_OFFSET) {
        setIsHidden(false);
      } else if (delta > SCROLL_DELTA_THRESHOLD) {
        setIsHidden(true);
      } else if (delta < -SCROLL_DELTA_THRESHOLD) {
        setIsHidden(false);
      }

      lastScrollY = currentScrollY;
      ticking = false;
    };

    const handleScroll = () => {
      if (ticking) {
        return;
      }

      ticking = true;
      window.requestAnimationFrame(updateVisibility);
    };

    window.addEventListener("scroll", handleScroll, { passive: true });
    return () => window.removeEventListener("scroll", handleScroll);
  }, [forceVisible]);

  return isHidden;
}
