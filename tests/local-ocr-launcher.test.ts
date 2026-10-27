import { describe, expect, it } from "vitest";
import { resolveLocalOcrProfile } from "../scripts/start-local-ocr.mjs";

describe("desktop OCR launcher profiles without starting processes", () => {
  it.each([undefined, "false"])(
    "keeps local-only 120/130-second limits for %s",
    (setting) => {
      expect(resolveLocalOcrProfile(setting)).toEqual({
        demoEnabled: false,
        providerDeadlineSeconds: 120,
        relayTimeoutMs: 130000,
      });
    },
  );

  it("requires exact opt-in and leaves time for relay/client safe errors", () => {
    expect(resolveLocalOcrProfile("true")).toEqual({
      demoEnabled: true,
      providerDeadlineSeconds: 110,
      relayTimeoutMs: 115000,
    });
    expect(resolveLocalOcrProfile("true").relayTimeoutMs).toBeLessThan(120000);
  });

  it.each(["", "TRUE", "1", "yes", " true ", "https://arbitrary.test", true, null, 1])(
    "rejects malformed opt-in %s",
    (setting) => {
      expect(() => resolveLocalOcrProfile(setting as string)).toThrow(
        "LOCAL_OCR_DEMO_CONFIGURATION_INVALID",
      );
    },
  );
});
