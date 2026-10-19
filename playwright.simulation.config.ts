/** Isolated synthetic-login browser tests. Production runtimes/settings/credentials are never loaded. */
import { defineConfig } from "@playwright/test";
import isolated from "./playwright.ocr.config";
export default defineConfig({
  ...isolated,
  testMatch: ["admin-order-simulation.spec.ts", "admin-order-inventory.spec.ts"],
  projects: [{ name: "chromium-simulation", use: isolated.projects?.[0]?.use }],
  timeout: 45_000,
});
