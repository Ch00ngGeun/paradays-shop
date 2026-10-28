import { describe, expect, it, vi } from "vitest";
import {
  OCR_MAPPING_TEMPLATES_STORAGE_KEY,
  deleteOcrMappingTemplate,
  isOcrMappingTemplateLayoutReusable,
  isOcrRegionTemplateReusable,
  loadOcrMappingTemplates,
  resetOcrMappingTemplates,
  saveOcrMappingTemplate,
  type OcrMappingTemplate,
  type OcrMappingTemplateColumnRole,
  type OcrMappingTemplateStorage,
} from "../lib/admin-ui/ocr-mapping-templates";
import type {
  OcrColumnMapping,
  OcrRegionMapping,
} from "../infra/lambda/ocr-table-parser.js";

function storageFixture(initial?: string): OcrMappingTemplateStorage {
  const values = new Map<string, string>();
  if (initial !== undefined) values.set(OCR_MAPPING_TEMPLATES_STORAGE_KEY, initial);
  return {
    getItem: vi.fn((key) => values.get(key) ?? null),
    setItem: vi.fn((key, value) => void values.set(key, value)),
    removeItem: vi.fn((key) => void values.delete(key)),
  };
}

function template(
  id = "template-1",
): OcrMappingTemplate & { mapping: OcrColumnMapping } {
  return {
    id,
    name: "양식 1",
    layout: { roles: ["ignore", "productInfo", "quantity"] },
    mapping: {
      schemaVersion: 1,
      headerRow: 0,
      columns: { productName: 1, brand: null, option: null, quantity: 2 },
      productInfo: { productNameLine: 0, brandLine: 1, optionLine: null },
    },
  };
}

function regionTemplate(
  id = "region-1",
): OcrMappingTemplate & { mapping: OcrRegionMapping } {
  return {
    id,
    name: "양식 2",
    layout: { roles: ["productName", "brand", "option", "quantity"] },
    mapping: {
      schemaVersion: 2,
      parserVersion: 1,
      kind: "regions",
      image: { width: 1200, height: 800 },
      firstRow: {
        productName: { left: 0.1, top: 0.2, right: 0.4, bottom: 0.25 },
        brand: { left: 0.5, top: 0.2, right: 0.6, bottom: 0.25 },
        option: { left: 0.7, top: 0.2, right: 0.8, bottom: 0.25 },
        quantity: { left: 0.9, top: 0.2, right: 0.95, bottom: 0.25 },
      },
      tableBottom: 0.9,
      secondRowY: 0.35,
      quantityConfirmed: true,
    },
  };
}

const envelope = (templates: unknown[], schemaVersion = 1) =>
  JSON.stringify({ schemaVersion, templates });

describe("explicit browser OCR mapping templates", () => {
  it("loads an empty store and saves only the versioned allowlist", () => {
    const storage = storageFixture();
    expect(loadOcrMappingTemplates(storage)).toEqual({ ok: true, value: [] });
    expect(saveOcrMappingTemplate(storage, template())).toEqual({
      ok: true,
      value: [template()],
    });
    expect(storage.setItem).toHaveBeenCalledExactlyOnceWith(
      OCR_MAPPING_TEMPLATES_STORAGE_KEY,
      expect.any(String),
    );
    expect(JSON.parse(storage.getItem(OCR_MAPPING_TEMPLATES_STORAGE_KEY)!)).toEqual({
      schemaVersion: 1,
      templates: [template()],
    });
  });

  it("reloads and reuses an independent mapping without retaining object references", () => {
    const storage = storageFixture();
    const input = template();
    saveOcrMappingTemplate(storage, input);
    Object.assign(input.mapping.columns, { productName: 3 });
    Object.assign(input.layout.roles, { 0: "price" });
    const saved = storage.getItem(OCR_MAPPING_TEMPLATES_STORAGE_KEY);
    const reloaded = loadOcrMappingTemplates(saved);
    expect(reloaded).toEqual({ ok: true, value: [template()] });
    if (!reloaded.ok) throw new Error("Expected a valid template");
    if (reloaded.value[0].mapping.schemaVersion !== 1)
      throw new Error("Expected a column template");
    Object.assign(reloaded.value[0].mapping.columns, { quantity: 4 });
    Object.assign(reloaded.value[0].layout.roles, { 0: "price" });
    expect(loadOcrMappingTemplates(storage)).toEqual({ ok: true, value: [template()] });
  });

  it("replaces the same ID and retains other templates", () => {
    const storage = storageFixture(envelope([template(), template("template-2")]));
    const updated = { ...template(), name: "양식 2" };
    expect(saveOcrMappingTemplate(storage, updated)).toEqual({
      ok: true,
      value: [updated, template("template-2")],
    });
  });

  it("removes one template and resets only its own storage key", () => {
    const storage = storageFixture(envelope([template(), template("template-2")]));
    storage.setItem("unrelated-key", "keep");
    expect(deleteOcrMappingTemplate(storage, "template-1")).toEqual({
      ok: true,
      value: [template("template-2")],
    });
    expect(resetOcrMappingTemplates(storage)).toEqual({ ok: true, value: [] });
    expect(storage.removeItem).toHaveBeenCalledExactlyOnceWith(
      OCR_MAPPING_TEMPLATES_STORAGE_KEY,
    );
    expect(storage.getItem("unrelated-key")).toBe("keep");
    expect(loadOcrMappingTemplates(storage)).toEqual({ ok: true, value: [] });
  });

  it("does not write when deleting an absent ID", () => {
    const storage = storageFixture(envelope([template()]));
    expect(deleteOcrMappingTemplate(storage, "absent")).toEqual({
      ok: true,
      value: [template()],
    });
    expect(storage.setItem).not.toHaveBeenCalled();
  });

  it.each(["", "not-json", "null", "[]", "{}", "x".repeat(32_769)])(
    "returns a safe error for corrupted or oversized data (%#)",
    (serialized) => {
      expect(loadOcrMappingTemplates(serialized)).toMatchObject({
        ok: false,
        error: { code: "invalid-data" },
      });
    },
  );

  it("rejects unsupported envelope and mapping versions", () => {
    expect(loadOcrMappingTemplates(envelope([], 2))).toMatchObject({
      ok: false,
      error: { code: "unsupported-version" },
    });
    const unsupported = {
      ...template(),
      mapping: { ...template().mapping, schemaVersion: 2 },
    };
    expect(loadOcrMappingTemplates(envelope([unsupported]))).toMatchObject({
      ok: false,
    });
  });

  it.each([
    { ...template(), rawText: "SECRET_SAMPLE" },
    { ...template(), mapping: { ...template().mapping, headerText: "SECRET_SAMPLE" } },
    { ...template(), layout: { ...template().layout, headerText: "SECRET_SAMPLE" } },
    {
      ...template(),
      mapping: {
        ...template().mapping,
        columns: { ...template().mapping.columns, token: "SECRET_SAMPLE" },
      },
    },
    {
      ...template(),
      mapping: {
        ...template().mapping,
        productInfo: { ...template().mapping.productInfo, fileName: "SECRET_SAMPLE" },
      },
    },
  ])("rejects unknown nested fields without writing secret extras (%#)", (input) => {
    const storage = storageFixture();
    const result = saveOcrMappingTemplate(storage, input as OcrMappingTemplate);
    expect(result).toMatchObject({ ok: false, error: { code: "invalid-template" } });
    expect(JSON.stringify(result)).not.toContain("SECRET_SAMPLE");
    expect(storage.setItem).not.toHaveBeenCalled();
    expect(loadOcrMappingTemplates(envelope([input]))).toMatchObject({ ok: false });
  });

  it("rejects unknown envelope fields and never calls user serializers or accessors", () => {
    expect(
      loadOcrMappingTemplates(
        JSON.stringify({ schemaVersion: 1, templates: [], image: "SECRET_SAMPLE" }),
      ),
    ).toMatchObject({ ok: false, error: { code: "invalid-data" } });
    const toJSON = vi.fn(() => "SECRET_SAMPLE");
    const readName = vi.fn(() => "SECRET_SAMPLE");
    const storage = storageFixture();
    expect(
      saveOcrMappingTemplate(storage, { ...template(), toJSON } as OcrMappingTemplate),
    ).toMatchObject({ ok: false });
    expect(
      saveOcrMappingTemplate(
        storage,
        Object.defineProperty(template(), "name", { get: readName }),
      ),
    ).toMatchObject({ ok: false });
    expect(toJSON).not.toHaveBeenCalled();
    expect(readName).not.toHaveBeenCalled();
    expect(storage.setItem).not.toHaveBeenCalled();
  });

  it.each([
    { ...template(), id: "../bad" },
    { ...template(), id: "a".repeat(81) },
    { ...template(), name: "" },
    { ...template(), name: "n".repeat(61) },
    { ...template(), name: " padded " },
    { ...template(), name: "bad\u0000name" },
    { ...template(), name: "양식 0" },
    { ...template(), name: "양식 100" },
    { ...template(), name: "SECRET_SAMPLE" },
    { ...template(), mapping: { ...template().mapping, headerRow: -1 } },
  ])("rejects an invalid name, ID, or mapping (%#)", (input) => {
    expect(saveOcrMappingTemplate(storageFixture(), input)).toMatchObject({
      ok: false,
      error: { code: "invalid-template" },
    });
  });

  it("accepts a fixed numbered name and rejects duplicate IDs in stored data", () => {
    const input = { ...template(), name: "양식 99" };
    expect(saveOcrMappingTemplate(storageFixture(), input)).toMatchObject({ ok: true });
    expect(loadOcrMappingTemplates(envelope([template(), template()]))).toMatchObject({
      ok: false,
      error: { code: "invalid-data" },
    });
  });

  it("stores only role enums and refuses a different role order or column count", () => {
    const input = template();
    expect(
      isOcrMappingTemplateLayoutReusable(input, ["ignore", "productInfo", "quantity"]),
    ).toBe(true);
    expect(
      isOcrMappingTemplateLayoutReusable(input, ["ignore", "quantity", "productInfo"]),
    ).toBe(false);
    expect(isOcrMappingTemplateLayoutReusable(input, ["productInfo", "quantity"])).toBe(
      false,
    );
    const storage = storageFixture();
    expect(saveOcrMappingTemplate(storage, input)).toMatchObject({ ok: true });
    expect(
      JSON.parse(storage.getItem(OCR_MAPPING_TEMPLATES_STORAGE_KEY)!).templates[0]
        .layout,
    ).toEqual({ roles: ["ignore", "productInfo", "quantity"] });
  });

  it("allows storing unknown roles but requires fresh review before reuse", () => {
    const input: OcrMappingTemplate = {
      ...template(),
      layout: { roles: ["unknown", "productInfo", "quantity"] },
    };
    expect(saveOcrMappingTemplate(storageFixture(), input)).toMatchObject({ ok: true });
    expect(isOcrMappingTemplateLayoutReusable(input, input.layout.roles)).toBe(false);
    expect(
      isOcrMappingTemplateLayoutReusable(template(), [
        "unknown",
        "productInfo",
        "quantity",
      ]),
    ).toBe(false);
  });

  it.each([
    [],
    Array.from({ length: 21 }, () => "ignore"),
    ["ignore", "상품 정보", "quantity"],
    ["ignore", "SECRET_SAMPLE", "quantity"],
    ["ignore", "productInfo"],
  ])("rejects invalid, textual, or too-short layout roles (%#)", (...roles) => {
    const input = { ...template(), layout: { roles } } as OcrMappingTemplate;
    const storage = storageFixture();
    expect(saveOcrMappingTemplate(storage, input)).toMatchObject({ ok: false });
    expect(storage.setItem).not.toHaveBeenCalled();
    expect(loadOcrMappingTemplates(envelope([input]))).toMatchObject({ ok: false });
    expect(
      isOcrMappingTemplateLayoutReusable(
        input,
        roles as OcrMappingTemplateColumnRole[],
      ),
    ).toBe(false);
  });

  it("requires the layout fingerprint and bounds every selected column to its length", () => {
    const missingLayout = {
      id: template().id,
      name: template().name,
      mapping: template().mapping,
    };
    expect(loadOcrMappingTemplates(envelope([missingLayout]))).toMatchObject({
      ok: false,
    });
    for (const field of ["productName", "brand", "option", "quantity"] as const) {
      const input = {
        ...template(),
        mapping: {
          ...template().mapping,
          columns: { ...template().mapping.columns, [field]: 3 },
        },
      };
      expect(saveOcrMappingTemplate(storageFixture(), input)).toMatchObject({
        ok: false,
      });
    }
    const twentyColumns: OcrMappingTemplate = {
      ...template(),
      layout: { roles: Array.from({ length: 20 }, () => "ignore" as const) },
    };
    expect(saveOcrMappingTemplate(storageFixture(), twentyColumns)).toMatchObject({
      ok: true,
    });
  });

  it("rejects array accessors and serializers without reading or serializing them", () => {
    const readRole = vi.fn(() => "SECRET_SAMPLE");
    const toJSON = vi.fn(() => ["SECRET_SAMPLE"]);
    const accessorRoles = ["ignore", "productInfo", "quantity"];
    Object.defineProperty(accessorRoles, "0", { get: readRole });
    const serializerRoles = Object.assign(["ignore", "productInfo", "quantity"], {
      toJSON,
    });
    for (const roles of [accessorRoles, serializerRoles]) {
      expect(
        saveOcrMappingTemplate(storageFixture(), {
          ...template(),
          layout: { roles: roles as OcrMappingTemplateColumnRole[] },
        }),
      ).toMatchObject({ ok: false });
    }
    expect(readRole).not.toHaveBeenCalled();
    expect(toJSON).not.toHaveBeenCalled();
  });

  it("allows updating at the 20-template limit but rejects a 21st template", () => {
    const templates = Array.from({ length: 20 }, (_, index) =>
      template(`template-${index}`),
    );
    const storage = storageFixture(envelope(templates));
    expect(
      saveOcrMappingTemplate(storage, { ...template("template-0"), name: "양식 2" }),
    ).toMatchObject({ ok: true });
    expect(saveOcrMappingTemplate(storage, template("template-20"))).toMatchObject({
      ok: false,
      error: { code: "limit-reached" },
    });
    expect(
      loadOcrMappingTemplates(envelope([...templates, template("template-20")])),
    ).toMatchObject({ ok: false });
  });

  it("preserves corrupted storage until explicit reset", () => {
    const storage = storageFixture("corrupted");
    expect(saveOcrMappingTemplate(storage, template())).toMatchObject({ ok: false });
    expect(deleteOcrMappingTemplate(storage, "template-1")).toMatchObject({
      ok: false,
    });
    expect(storage.setItem).not.toHaveBeenCalled();
    expect(resetOcrMappingTemplates(storage)).toEqual({ ok: true, value: [] });
    expect(saveOcrMappingTemplate(storage, template())).toMatchObject({ ok: true });
  });

  it("returns safe quota and security errors without exposing exception messages", () => {
    const quotaStorage = storageFixture();
    quotaStorage.setItem = () => {
      throw Object.assign(new Error("SECRET_SAMPLE"), { name: "QuotaExceededError" });
    };
    const quota = saveOcrMappingTemplate(quotaStorage, template());
    expect(quota).toMatchObject({ ok: false, error: { code: "storage-quota" } });
    expect(JSON.stringify(quota)).not.toContain("SECRET_SAMPLE");
    const deniedStorage = storageFixture();
    deniedStorage.getItem = () => {
      throw Object.assign(new Error("SECRET_SAMPLE"), { name: "SecurityError" });
    };
    deniedStorage.removeItem = deniedStorage.getItem;
    expect(loadOcrMappingTemplates(deniedStorage)).toMatchObject({
      ok: false,
      error: { code: "storage-unavailable" },
    });
    expect(resetOcrMappingTemplates(deniedStorage)).toMatchObject({
      ok: false,
      error: { code: "storage-unavailable" },
    });
  });

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
