// 역할: OCR 영역 매핑 템플릿의 저장·복제·역할 일치·재사용 조건과 접근자 거부를 검증함.
import { describe, expect, it, vi } from "vitest";
import {
  OCR_MAPPING_TEMPLATES_STORAGE_KEY,
  isOcrMappingTemplateLayoutReusable,
  isOcrRegionTemplateReusable,
  loadOcrMappingTemplates,
  saveOcrMappingTemplate,
  type OcrMappingTemplate,
  type OcrMappingTemplateColumnRole,
} from "../lib/admin-ui/ocr-mapping-templates";
import {
  storageFixture,
  template,
  regionTemplate,
  envelope,
} from "./ocr-mapping-templates-fixtures";

describe("explicit browser OCR mapping templates", () => {
  it("saves and reloads both mapping versions without migrating the v1 envelope", () => {
    const storage = storageFixture(envelope([template()]));
    expect(saveOcrMappingTemplate(storage, regionTemplate())).toEqual({
      ok: true,
      value: [template(), regionTemplate()],
    });
    const serialized = storage.getItem(OCR_MAPPING_TEMPLATES_STORAGE_KEY)!;
    expect(JSON.parse(serialized)).toEqual({
      schemaVersion: 1,
      templates: [template(), regionTemplate()],
    });
    expect(loadOcrMappingTemplates(serialized)).toEqual({
      ok: true,
      value: [template(), regionTemplate()],
    });
    expect(storage.setItem).toHaveBeenCalledWith(
      OCR_MAPPING_TEMPLATES_STORAGE_KEY,
      expect.any(String),
    );
  });

  it("clones numeric image configuration and every region without retaining input references", () => {
    const input = regionTemplate();
    const storage = storageFixture();
    saveOcrMappingTemplate(storage, input);
    Object.assign(input.mapping.image, { width: 600 });
    Object.assign(input.mapping.firstRow.productName, { left: 0.2 });
    Object.assign(input.mapping.firstRow.quantity!, { right: 0.99 });
    expect(loadOcrMappingTemplates(storage)).toEqual({
      ok: true,
      value: [regionTemplate()],
    });
  });

  it("requires the four region roles to match selected fields including explicit absence", () => {
    const input: OcrMappingTemplate = {
      ...regionTemplate(),
      mapping: {
        ...regionTemplate().mapping,
        firstRow: {
          ...regionTemplate().mapping.firstRow,
          brand: null,
          option: null,
          quantity: null,
        },
        quantityConfirmed: false,
      },
      layout: { roles: ["productName", "ignore", "ignore", "ignore"] },
    };
    expect(saveOcrMappingTemplate(storageFixture(), input)).toMatchObject({ ok: true });
    for (const roles of [
      ["productName", "brand", "option", "quantity"],
      ["productName", "ignore", "ignore"],
      ["productName", "ignore", "ignore", "unknown"],
    ]) {
      expect(
        saveOcrMappingTemplate(storageFixture(), {
          ...input,
          layout: { roles: roles as OcrMappingTemplateColumnRole[] },
        }),
      ).toMatchObject({ ok: false });
    }
  });

  it("keeps numeric and region reuse checks separate and requires an aspect match", () => {
    const input = regionTemplate();
    expect(isOcrMappingTemplateLayoutReusable(input, input.layout.roles)).toBe(false);
    expect(isOcrRegionTemplateReusable(template(), { width: 1200, height: 800 })).toBe(
      false,
    );
    expect(isOcrRegionTemplateReusable(input, { width: 600, height: 400 })).toBe(true);
    expect(isOcrRegionTemplateReusable(input, { width: 1224, height: 800 })).toBe(true);
    expect(isOcrRegionTemplateReusable(input, { width: 1236, height: 800 })).toBe(true);
    expect(isOcrRegionTemplateReusable(input, { width: 1237, height: 800 })).toBe(
      false,
    );
    expect(isOcrRegionTemplateReusable(input, { width: 1200, height: 1200 })).toBe(
      false,
    );
  });

  it.each([
    { width: NaN, height: 800 },
    { width: Infinity, height: 800 },
    { width: 1200, height: NaN },
    { width: 0, height: 800 },
    { width: -1, height: 800 },
    { width: 1200.5, height: 800 },
    { width: 16_385, height: 800 },
    { width: 1200, height: 16_385 },
    { width: 9000, height: 6000 },
  ])("rejects invalid or oversized current natural dimensions (%#)", (naturalSize) => {
    expect(isOcrRegionTemplateReusable(regionTemplate(), naturalSize)).toBe(false);
  });

  it.each([
    { ...regionTemplate(), fileName: "SECRET_SAMPLE" },
    {
      ...regionTemplate(),
      mapping: { ...regionTemplate().mapping, rawText: "SECRET_SAMPLE" },
    },
    {
      ...regionTemplate(),
      mapping: {
        ...regionTemplate().mapping,
        image: { ...regionTemplate().mapping.image, src: "SECRET_SAMPLE" },
      },
    },
    {
      ...regionTemplate(),
      mapping: {
        ...regionTemplate().mapping,
        firstRow: { ...regionTemplate().mapping.firstRow, headerText: "SECRET_SAMPLE" },
      },
    },
    {
      ...regionTemplate(),
      mapping: {
        ...regionTemplate().mapping,
        firstRow: {
          ...regionTemplate().mapping.firstRow,
          productName: {
            ...regionTemplate().mapping.firstRow.productName,
            sourceText: "SECRET_SAMPLE",
          },
        },
      },
    },
    {
      ...regionTemplate(),
      layout: { ...regionTemplate().layout, imageAspectRatio: "SECRET_SAMPLE" },
    },
  ])(
    "rejects every unknown region field without persisting secret extras (%#)",
    (input) => {
      const storage = storageFixture();
      const result = saveOcrMappingTemplate(storage, input as OcrMappingTemplate);
      expect(result).toMatchObject({ ok: false, error: { code: "invalid-template" } });
      expect(JSON.stringify(result)).not.toContain("SECRET_SAMPLE");
      expect(storage.setItem).not.toHaveBeenCalled();
      expect(loadOcrMappingTemplates(envelope([input]))).toMatchObject({ ok: false });
      expect(
        isOcrRegionTemplateReusable(input as OcrMappingTemplate, {
          width: 1200,
          height: 800,
        }),
      ).toBe(false);
    },
  );

  it("rejects nested region accessors and serializers without calling them", () => {
    const readWidth = vi.fn(() => 1200);
    const readLeft = vi.fn(() => 0.1);
    const toJSON = vi.fn(() => "SECRET_SAMPLE");
    const imageAccessor = regionTemplate();
    Object.defineProperty(imageAccessor.mapping.image, "width", { get: readWidth });
    const rectAccessor = regionTemplate();
    Object.defineProperty(rectAccessor.mapping.firstRow.productName, "left", {
      get: readLeft,
    });
    const serializer = regionTemplate();
    Object.assign(serializer.mapping.firstRow.quantity!, { toJSON });
    for (const input of [imageAccessor, rectAccessor, serializer]) {
      expect(saveOcrMappingTemplate(storageFixture(), input)).toMatchObject({
        ok: false,
      });
      expect(isOcrRegionTemplateReusable(input, { width: 1200, height: 800 })).toBe(
        false,
      );
    }
    expect(readWidth).not.toHaveBeenCalled();
    expect(readLeft).not.toHaveBeenCalled();
    expect(toJSON).not.toHaveBeenCalled();
  });

  it.each([
    { ...regionTemplate().mapping, schemaVersion: 3 },
    { ...regionTemplate().mapping, parserVersion: 2 },
    { ...regionTemplate().mapping, kind: "other" },
    { ...regionTemplate().mapping, image: { width: "1200", height: 800 } },
    { ...regionTemplate().mapping, tableBottom: NaN },
    { ...regionTemplate().mapping, quantityConfirmed: false },
  ])("rejects unsupported or invalid region configuration (%#)", (mapping) => {
    expect(
      saveOcrMappingTemplate(storageFixture(), {
        ...regionTemplate(),
        mapping,
      } as OcrMappingTemplate),
    ).toMatchObject({ ok: false });
  });
});
