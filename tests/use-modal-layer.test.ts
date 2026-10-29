import { describe, expect, it } from "vitest";

import { createModalLayerStack } from "@/hooks/use-modal-layer";

type FakeElement = { name: string; inert: boolean; remove(): void };

/** body 바로 아래 요소만 흉내 내는 최소 body. */
function fakeBody(...names: string[]) {
  const children: FakeElement[] = [];
  let overflow = "auto";
  const element = (name: string, inert = false): FakeElement => {
    const item: FakeElement = {
      name,
      inert,
      remove: () => {
        const index = children.indexOf(item);
        if (index !== -1) children.splice(index, 1);
      },
    };
    return item;
  };
  for (const name of names) children.push(element(name, name.startsWith("inert:")));
  return {
    children,
    element,
    overflow: () => overflow,
    body: {
      elements: () => [...children],
      append: (item: FakeElement) => children.push(item),
      getOverflow: () => overflow,
      setOverflow: (value: string) => {
        overflow = value;
      },
    },
  };
}

const states = (children: readonly FakeElement[]) =>
  Object.fromEntries(children.map((item) => [item.name, item.inert]));

describe("modal layer stack", () => {
  it("one layer keeps the page inert and restores it exactly on close", () => {
    const page = fakeBody("app", "inert:already");
    const layers = createModalLayerStack(page.body);
    const modal = page.element("modal");

    layers.open(modal);
    expect(states(page.children)).toEqual({
      app: true,
      "inert:already": true,
      modal: false,
    });
    expect(page.overflow()).toBe("hidden");

    layers.close(modal);
    expect(states(page.children)).toEqual({ app: false, "inert:already": true });
    expect(page.overflow()).toBe("auto");
  });

  it("a layer opened on top makes the lower layer inert and gives it back when closed", () => {
    const page = fakeBody("app");
    const layers = createModalLayerStack(page.body);
    const parent = page.element("parent");
    const help = page.element("help");

    layers.open(parent);
    layers.open(help);
    expect(states(page.children)).toEqual({ app: true, parent: true, help: false });

    layers.close(help);
    expect(states(page.children)).toEqual({ app: true, parent: false });
    expect(page.overflow()).toBe("hidden");

    layers.close(parent);
    expect(states(page.children)).toEqual({ app: false });
    expect(page.overflow()).toBe("auto");
  });

  it("closing the parent before the help on top still leaves the page usable", () => {
    // React runs the parent's cleanup first when both unmount together.
    const page = fakeBody("app");
    const layers = createModalLayerStack(page.body);
    const parent = page.element("parent");
    const help = page.element("help");

    layers.open(parent);
    layers.open(help);
    layers.close(parent);
    expect(states(page.children)).toEqual({ app: true, help: false });

    layers.close(help);
    expect(states(page.children)).toEqual({ app: false });
    expect(page.overflow()).toBe("auto");
  });

  it("a page element added while a modal is open returns to its own state", () => {
    const page = fakeBody("app");
    const layers = createModalLayerStack(page.body);
    const modal = page.element("modal");

    layers.open(modal);
    const toast = page.element("toast");
    page.children.push(toast);
    const help = page.element("help");
    layers.open(help);
    expect(toast.inert).toBe(true);

    layers.close(help);
    layers.close(modal);
    expect(states(page.children)).toEqual({ app: false, toast: false });
  });

  it("closing an unknown or already closed layer changes nothing", () => {
    const page = fakeBody("app");
    const layers = createModalLayerStack(page.body);
    const modal = page.element("modal");

    layers.close(modal);
    expect(states(page.children)).toEqual({ app: false });
    expect(page.overflow()).toBe("auto");

    layers.open(modal);
    layers.close(modal);
    layers.close(modal);
    expect(states(page.children)).toEqual({ app: false });
    expect(page.overflow()).toBe("auto");
  });
});
