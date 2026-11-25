import { expect, type Locator, type Page } from "@playwright/test";

/** The guide's drawing: the ring around the target and the underline under an input. */
const guideRing = (page: Page) => page.locator("[data-modal-layer] svg > rect[rx='8']");

const guideLines = (page: Page) => page.locator("[data-modal-layer] svg > line");

async function boxOf(locator: Locator) {
  const box = await locator.boundingBox();
  if (!box) throw new Error("no box");
  return box;
}

const recentOperations = (page: Page) =>
  page.getByRole("region", { name: "최근 운영 기록", exact: true });

const operationRows = (page: Page) => recentOperations(page).locator("li[data-status]");

async function noticeColors(notice: Locator) {
  return notice.evaluate((element) => {
    const luminance = (value: string) => {
      const [red, green, blue] = value
        .match(/[\d.]+/g)!
        .slice(0, 3)
        .map(Number)
        .map((channel) => {
          const c = channel / 255;
          return c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
        });
      return red * 0.2126 + green * 0.7152 + blue * 0.0722;
    };
    const background = getComputedStyle(element).backgroundColor;
    const text = getComputedStyle(element.querySelector("strong")!).color;
    const values = [luminance(background), luminance(text)].sort((a, b) => b - a);
    return { background, text, ratio: (values[0] + 0.05) / (values[1] + 0.05) };
  });
}

async function flowStates(page: Page, name: string) {
  const flow = page.getByRole("list", { name, exact: true });
  await expect(flow).toBeVisible();
  return flow
    .getByRole("listitem")
    .evaluateAll((items) => items.map((item) => (item as HTMLElement).dataset.state));
}

async function requiredLook(field: Locator) {
  return field.evaluate((element) => {
    const style = getComputedStyle(element);
    return [style.backgroundColor, style.borderTopColor];
  });
}

const REQUIRED = ["rgb(242, 246, 250)", "rgb(40, 100, 180)"];

export {
  boxOf,
  flowStates,
  guideLines,
  guideRing,
  noticeColors,
  operationRows,
  recentOperations,
  REQUIRED,
  requiredLook,
};
