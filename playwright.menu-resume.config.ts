/** Admin menu round-trips use isolated source and synthetic auth/API fixtures only. */
import { defineConfig } from "@playwright/test";
import isolated from "./playwright.sales.config";

export default defineConfig({
  ...isolated,
  testMatch: [
    "admin-menu-resume.spec.ts",
    "admin-storefront-return.spec.ts",
    "admin-navigation.spec.ts",
    "admin-sales-ledger.spec.ts",
    "admin-sales-simulation.spec.ts",
  ],
  projects: [{ name: "chromium-menu-resume", use: isolated.projects?.[0]?.use }],
});
