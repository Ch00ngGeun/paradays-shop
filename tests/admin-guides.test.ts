import { describe, expect, it } from "vitest";

import {
  ADMIN_GUIDES,
  adminGuideSteps,
  type AdminGuideMenu,
} from "@/lib/admin-ui/admin-guides";

const menus = Object.keys(ADMIN_GUIDES) as AdminGuideMenu[];

describe("admin screen guides", () => {
  it("covers all nine menus with three to five steps each", () => {
    expect(menus.sort()).toEqual([
      "brands",
      "coupons",
      "home",
      "inventory",
      "marketing",
      "members",
      "ocr",
      "products",
      "sales",
    ]);
    for (const menu of menus) {
      expect(ADMIN_GUIDES[menu].length, menu).toBeGreaterThanOrEqual(3);
      expect(ADMIN_GUIDES[menu].length, menu).toBeLessThanOrEqual(5);
    }
  });

  it("names targets as menu.part, unique across all menus", () => {
    const targets = menus.flatMap((menu) =>
      ADMIN_GUIDES[menu].map((step) => step.target),
    );
    expect(new Set(targets).size).toBe(targets.length);
    for (const menu of menus)
      for (const step of ADMIN_GUIDES[menu])
        expect(step.target).toMatch(new RegExp(`^${menu}\\.[a-z][A-Za-z]*$`));
  });

  it("keeps titles and bodies short, with no Korean in English", () => {
    for (const menu of menus)
      for (const { target, title, body } of ADMIN_GUIDES[menu]) {
        expect(title.ko.length, target).toBeLessThanOrEqual(12);
        expect(title.en.length, target).toBeLessThanOrEqual(26);
        expect(body.ko.length, target).toBeLessThanOrEqual(40);
        expect(body.en.length, target).toBeLessThanOrEqual(70);
        expect(`${title.en} ${body.en}`, target).not.toMatch(/\p{Script=Hangul}/u);
        expect(title.ko, target).toMatch(/\p{Script=Hangul}/u);
      }
  });

  it("avoids technical words in Korean text", () => {
    for (const menu of menus)
      for (const { target, title, body } of ADMIN_GUIDES[menu])
        expect(`${title.ko} ${body.ko}`, target).not.toMatch(
          /API|서버|초안|OCR|전표|DB|데이터/u,
        );
  });

  it("hands the guide component steps in the screen language", () => {
    expect(adminGuideSteps("brands", "en")[1]).toEqual({
      target: "brands.name",
      mark: "underline",
      title: "Write the brand name",
      body: "Type the new brand's name.",
    });
    expect(adminGuideSteps("brands", "ko")[1]?.title).toBe("브랜드 이름 쓰기");
  });
});
