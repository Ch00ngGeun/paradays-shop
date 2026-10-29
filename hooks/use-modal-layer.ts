// 역할: portal modal이 열렸을 때 배경을 inert 처리하고 body scroll을 잠가 보조기술·키보드 초점을 보호합니다.
"use client";

import { useEffect, useMemo } from "react";

type LayerElement = { inert: boolean; remove(): void };
type LayerBody<E extends LayerElement> = {
  /** body 바로 아래의 요소들(layer 포함) */
  elements(): readonly E[];
  append(element: E): void;
  getOverflow(): string;
  setOverflow(value: string): void;
};

/**
 * 열린 modal layer를 쌓아 관리합니다. 맨 위 layer만 조작할 수 있고 아래 layer와 배경은 inert입니다.
 * 첫 layer가 열릴 때의 원래 상태만 저장하고, 마지막 layer가 닫힐 때만 복원하므로 닫히는 순서와 무관합니다.
 */
export function createModalLayerStack<E extends LayerElement>(body: LayerBody<E>) {
  const open: E[] = [];
  let original: { inert: Map<E, boolean>; overflow: string } | null = null;

  const apply = () => {
    const top = open.at(-1);
    for (const element of body.elements()) {
      // Layers are created and removed here, so only the page's own elements need their state kept.
      if (original && !open.includes(element) && !original.inert.has(element))
        original.inert.set(element, element.inert);
      element.inert = element !== top;
    }
    body.setOverflow("hidden");
  };

  return {
    open(layer: E) {
      if (open.length === 0)
        original = { inert: new Map(), overflow: body.getOverflow() };
      body.append(layer);
      open.push(layer);
      apply();
    },
    close(layer: E) {
      const index = open.indexOf(layer);
      if (index === -1) return;
      open.splice(index, 1);
      layer.remove();
      if (open.length > 0) {
        apply();
        return;
      }
      for (const [element, inert] of original?.inert ?? []) element.inert = inert;
      body.setOverflow(original?.overflow ?? "");
      original = null;
    },
  };
}

let pageLayers: ReturnType<typeof createModalLayerStack<HTMLElement>> | null = null;

function documentLayers() {
  pageLayers ??= createModalLayerStack<HTMLElement>({
    elements: () =>
      Array.from(document.body.children).filter(
        (element): element is HTMLElement => element instanceof HTMLElement,
      ),
    append: (element) => document.body.append(element),
    getOverflow: () => document.body.style.overflow,
    setOverflow: (value) => {
      document.body.style.overflow = value;
    },
  });
  return pageLayers;
}

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

    const layers = documentLayers();
    layers.open(layer);

    return () => layers.close(layer);
  }, [isActive, layer]);

  return isActive ? layer : null;
}
