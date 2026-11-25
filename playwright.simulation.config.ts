// 역할: 주문 시뮬레이션·주문 재고 e2e spec을 OCR 격리 설정(합성 로그인)으로 실행하며 운영 런타임·설정·자격정보는 읽지 않습니다.
import { defineConfig } from "@playwright/test";
import isolated from "./playwright.ocr.config";
export default defineConfig({
  ...isolated,
  testMatch: ["admin-order-simulation.spec.ts", "admin-order-inventory.spec.ts"],
  projects: [{ name: "chromium-simulation", use: isolated.projects?.[0]?.use }],
  timeout: 45_000,
});
