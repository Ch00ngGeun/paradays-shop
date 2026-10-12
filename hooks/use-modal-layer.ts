// 역할: portal modal이 열렸을 때 배경을 inert 처리하고 body scroll을 잠가 보조기술·키보드 초점을 보호합니다.
"use client";

import { useEffect, useMemo } from "react";

/**
 * body 바로 아래에 독립 layer를 만들고, 활성 중 나머지 body children을 inert 처리합니다.
 * modal이 app shell 밖으로 portal되므로 background와 dialog 자신을 함께 inert 처리하지 않습니다.
 */
export function useModalLayer(isActive: boolean) {
  const layer = useMemo(() => {
    if (typeof document === "undefined") {
      return null;
    }

    const element = document.createElement("div");
    element.dataset.modalLayer = "true";

    return element;
  }, []);

  useEffect(() => {
    if (!isActive || !layer) {
      return;
    }

    document.body.append(layer);
    const backgroundElements = Array.from(document.body.children).filter(
      (element): element is HTMLElement =>
        element instanceof HTMLElement && element !== layer,
    );
    const previousInertStates = backgroundElements.map((element) => ({
      element,
      inert: element.inert,
    }));
    const previousBodyOverflow = document.body.style.overflow;

    for (const { element } of previousInertStates) {
      element.inert = true;
    }

    document.body.style.overflow = "hidden";

    return () => {
      document.body.style.overflow = previousBodyOverflow;

      for (const { element, inert } of previousInertStates) {
        element.inert = inert;
      }

      layer.remove();
    };
  }, [isActive, layer]);

  return isActive ? layer : null;
}
