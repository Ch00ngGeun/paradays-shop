// 역할: 브랜드 화면 검사용 합성 상품·저장 응답과 브랜드 입력·표·행 선택 도우미를 제공함.
import { type Page, type Route } from "@playwright/test";
import { DAY, products, respond } from "./admin-navigation-base-fixtures";

const brandProducts = [
  { ...products[0], brandName: "TEST" },
  { ...products[1], brandName: " test " },
  { ...products[1], productId: "prd_synthetic_C", brandName: "RIVER" },
];

const brandWorkspace = (page: Page) => page.locator("#admin-panel-brands");

const brandNameInput = (page: Page) =>
  brandWorkspace(page).getByRole("textbox", { name: "브랜드명 (필수)", exact: true });

const brandTable = (page: Page) =>
  brandWorkspace(page).getByRole("table", {
    name: "브랜드별 이 화면 상품 연결",
    exact: true,
  });

const brandRow = (page: Page, name: string) =>
  brandTable(page)
    .getByRole("row")
    .filter({ has: page.getByText(name, { exact: true }) });

async function savedBrand(route: Route, name: string) {
  await respond(
    route,
    {
      record: {
        brandId: "br_synthetic_registered",
        name,
        slug: name.toLowerCase().replaceAll(" ", "-"),
        status: "ACTIVE",
        version: 1,
        createdAt: `${DAY}T14:00:00.000Z`,
        updatedAt: `${DAY}T14:00:00.000Z`,
      },
    },
    201,
  );
}

export {
  brandNameInput,
  brandProducts,
  brandRow,
  brandTable,
  brandWorkspace,
  savedBrand,
};
