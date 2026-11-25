/** Admin menu round-trips use isolated source and synthetic auth/API fixtures only. */
import { defineConfig } from "@playwright/test";
import isolated from "./playwright.sales.config";

export default defineConfig({
  ...isolated,
  testMatch: [
    "admin-menu-resume.spec.ts",
    "admin-storefront-return.spec.ts",
    "admin-navigation-history.spec.ts",
    "admin-navigation-product-history.spec.ts",
    "admin-navigation-home.spec.ts",
    "admin-navigation-product-editor.spec.ts",
    "admin-navigation-product-publishing.spec.ts",
    "admin-navigation-product-catalog.spec.ts",
    "admin-navigation-product-options.spec.ts",
    "admin-navigation-product-pricing.spec.ts",
    "admin-navigation-inventory-badges.spec.ts",
    "admin-navigation-inventory-filters.spec.ts",
    "admin-navigation-inventory-editing.spec.ts",
    "admin-navigation-brands.spec.ts",
    "admin-navigation-coupons.spec.ts",
    "admin-navigation-marketing-preview.spec.ts",
    "admin-navigation-marketing-saving.spec.ts",
    "admin-navigation-notices.spec.ts",
    "admin-navigation-operations.spec.ts",
    "admin-navigation-images.spec.ts",
    "admin-navigation-work-flow.spec.ts",
    "admin-navigation-required-fields.spec.ts",
    "admin-navigation-screen-guide.spec.ts",
    "admin-navigation-members.spec.ts",
    "admin-sales-ledger.spec.ts",
    "admin-sales-simulation.spec.ts",
    "deck-size-spec.spec.ts",
    "admin-english.spec.ts",
  ],
  projects: [{ name: "chromium-menu-resume", use: isolated.projects?.[0]?.use }],
});
