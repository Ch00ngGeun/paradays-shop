import { afterEach, describe, expect, it, vi } from "vitest";
import { createAdminApiClient } from "@/lib/commerce/admin-api-client";
import { AdminApiResponseError } from "@/lib/commerce/admin-api-client-errors";
import type { AdminProductDraft } from "@/lib/admin-ui/types";
import { apiConfig, createClient } from "./admin-api-client-fixtures";

afterEach(() => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
});

describe("createAdminApiClient", () => {
  describe("blank size fields", () => {
    const deck = { nose: 6.875, tail: null, width: 8.5, length: null, wheelbase: null };
    const topValues = {
      length: 72,
      shoulder: null,
      chest: 56,
      sleeveLength: null,
      hem: 55,
      sleeveWidth: null,
      armhole: null,
    };
    const row = (
      category: string,
      version: number,
      extra: Record<string, unknown>,
    ) => ({
      productId: "prd_blank",
      name: "Blank",
      brandName: "Quasi",
      category,
      price: 1000,
      inventoryQuantity: 1,
      status: "PUBLISHED",
      featured: false,
      version,
      description: [],
      sizes: ["S", "M"],
      ...extra,
    });
    const answer = (...products: Record<string, unknown>[]) => {
      const fetchImplementation = vi.fn<typeof fetch>();
      for (const product of products)
        fetchImplementation.mockResolvedValueOnce(Response.json({ product }));
      return { fetchImplementation, ...createClient(fetchImplementation) };
    };
    const body = (
      fetchImplementation: ReturnType<typeof vi.fn<typeof fetch>>,
      call = 0,
    ) => JSON.parse(String(fetchImplementation.mock.calls[call][1]?.body));

    it("lists deck and clothing values with blank fields, and drops all-blank or broken ones", async () => {
      const { client } = createClient(
        vi.fn<typeof fetch>().mockResolvedValue(
          Response.json({
            products: [
              row("Deck", 4, { deckSpec: deck, deckSpecsBySize: { M: deck } }),
              row("Top", 4, {
                productId: "prd_top",
                sizeChart: { kind: "shortSleeve", values: topValues },
                sizeChartKind: "shortSleeve",
                sizeChartsBySize: { M: topValues },
              }),
              row("Deck", 4, {
                productId: "prd_bad",
                deckSpec: {
                  nose: null,
                  tail: null,
                  width: null,
                  length: null,
                  wheelbase: null,
                },
                deckSpecsBySize: { M: { nose: 6.875 } },
              }),
              row("Top", 4, {
                productId: "prd_bad_top",
                sizeChart: {
                  kind: "shortSleeve",
                  values: Object.fromEntries(
                    Object.keys(topValues).map((key) => [key, null]),
                  ),
                },
              }),
            ],
          }),
        ),
      );
      const [deckRow, topRow, badDeck, badTop] = await client.listCatalogProducts();
      expect(deckRow.deckSpec).toEqual(deck);
      expect(deckRow.deckSpecsBySize).toEqual({ M: deck });
      expect(topRow.sizeChart).toEqual({ kind: "shortSleeve", values: topValues });
      expect(topRow.sizeChartsBySize).toEqual({ M: topValues });
      expect(badDeck).not.toHaveProperty("deckSpec");
      expect(badDeck).not.toHaveProperty("deckSpecsBySize");
      expect(badTop).not.toHaveProperty("sizeChart");
    });

    it("sends blank fields as null and checks the saved values including null", async () => {
      const { client, fetchImplementation } = answer(
        row("Deck", 4, { deckSpec: deck }),
        row("Deck", 5, { deckSpecsBySize: { M: deck } }),
        row("Top", 6, { sizeChart: { kind: "shortSleeve", values: topValues } }),
        row("Top", 7, {
          sizeChartKind: "shortSleeve",
          sizeChartsBySize: { M: topValues },
        }),
        // A server that turned a blank field into a number did not save what was sent.
        row("Deck", 9, { deckSpec: { ...deck, tail: 6.5 } }),
        row("Top", 10, {
          sizeChart: { kind: "shortSleeve", values: { ...topValues, armhole: 24 } },
        }),
      );
      await client.updateProductDeckSpec({
        id: "prd_blank",
        version: 3,
        deckSpec: deck,
      });
      expect(body(fetchImplementation)).toEqual({ version: 3, deckSpec: deck });
      await client.updateProductDeckSpec({
        id: "prd_blank",
        version: 4,
        deckSpec: deck,
        size: "M",
      });
      expect(body(fetchImplementation, 1)).toEqual({
        version: 4,
        size: "M",
        sizeDeckSpec: deck,
      });
      await client.updateProductSizeChart({
        id: "prd_blank",
        version: 5,
        sizeChart: { kind: "shortSleeve", values: topValues },
      });
      expect(body(fetchImplementation, 2).sizeChart.values).toEqual(topValues);
      await client.updateProductOptionSizeChart({
        id: "prd_blank",
        version: 6,
        size: "M",
        sizeChartValues: topValues,
      });
      expect(body(fetchImplementation, 3).sizeChartValues).toEqual(topValues);
      await expect(
        client.updateProductDeckSpec({ id: "prd_blank", version: 8, deckSpec: deck }),
      ).rejects.toBeInstanceOf(AdminApiResponseError);
      await expect(
        client.updateProductSizeChart({
          id: "prd_blank",
          version: 9,
          sizeChart: { kind: "shortSleeve", values: topValues },
        }),
      ).rejects.toBeInstanceOf(AdminApiResponseError);
    });

    it("keeps the server's four-decimal limit for deck inches, with or without blank fields", async () => {
      const fetchImplementation = vi.fn<typeof fetch>().mockResolvedValue(
        Response.json({
          products: [
            row("Deck", 4, { deckSpec: { ...deck, nose: 6.0625 } }),
            row("Deck", 4, {
              productId: "prd_five",
              deckSpec: { ...deck, nose: 6.06251 },
            }),
            row("Deck", 4, {
              productId: "prd_full",
              deckSpec: {
                nose: 6.0625,
                tail: 6.5,
                width: 8.5,
                length: 31.75,
                wheelbase: 14.25,
              },
            }),
          ],
        }),
      );
      const { client, getAccessToken } = createClient(fetchImplementation);
      const [four, five, full] = await client.listCatalogProducts();
      expect(four.deckSpec).toEqual({ ...deck, nose: 6.0625 });
      expect(five).not.toHaveProperty("deckSpec");
      expect(full.deckSpec?.nose).toBe(6.0625);
      fetchImplementation.mockClear();
      getAccessToken.mockClear();
      for (const deckSpec of [
        { ...deck, nose: 6.06251 },
        { nose: 6.06251, tail: 6.5, width: 8.5, length: 31.75, wheelbase: 14.25 },
      ])
        await expect(
          client.updateProductDeckSpec({ id: "prd_blank", version: 3, deckSpec }),
        ).rejects.toBeInstanceOf(AdminApiResponseError);
      expect(getAccessToken).not.toHaveBeenCalled();
      expect(fetchImplementation).not.toHaveBeenCalled();
    });

    it("refuses all-blank values before authentication or fetch", async () => {
      const fetchImplementation = vi.fn<typeof fetch>();
      const { client, getAccessToken } = createClient(fetchImplementation);
      const blankDeck = {
        nose: null,
        tail: null,
        width: null,
        length: null,
        wheelbase: null,
      };
      const blankTop = Object.fromEntries(
        Object.keys(topValues).map((key) => [key, null]),
      );
      for (const attempt of [
        () =>
          client.updateProductDeckSpec({
            id: "prd_blank",
            version: 3,
            deckSpec: blankDeck,
          }),
        () =>
          client.updateProductDeckSpec({
            id: "prd_blank",
            version: 3,
            deckSpec: blankDeck,
            size: "M",
          }),
        () =>
          client.updateProductSizeChart({
            id: "prd_blank",
            version: 3,
            sizeChart: { kind: "shortSleeve", values: blankTop },
          }),
        () =>
          client.updateProductOptionSizeChart({
            id: "prd_blank",
            version: 3,
            size: "M",
            sizeChartValues: blankTop,
          }),
      ])
        await expect(attempt()).rejects.toBeInstanceOf(AdminApiResponseError);
      expect(getAccessToken).not.toHaveBeenCalled();
      expect(fetchImplementation).not.toHaveBeenCalled();
    });
  });

  describe("explicit product comparison price serialization", () => {
    const draft: AdminProductDraft = {
      name: "Synthetic product",
      brand: "Synthetic brand",
      category: "Deck",
      sku: "preserved-SKU",
      price: "109000",
      compareAtPrice: "",
      stock: "13",
      imageUrl: "/images/product-placeholder.svg",
      sizes: "8.25”, Custom / Mixed CASE",
      description: "Synthetic description",
      isVisible: false,
      isFeatured: true,
      nameI18n: { ko: "합성 상품", en: "Synthetic product" },
      descriptionI18n: { ko: ["합성 설명"], en: ["Synthetic description"] },
      sourceLocale: "ko",
    };

    it.each([false, true])(
      "sends an explicit empty comparison price for a versioned edit without altering publication %s",
      async (isVisible) => {
        const fetchImplementation = vi
          .fn<typeof fetch>()
          .mockResolvedValue(Response.json({}));
        const { client, getAccessToken } = createClient(fetchImplementation);
        await client.saveProductDraft({
          ...draft,
          productId: "product/legacy +code",
          version: 7,
          isVisible,
        });
        expect(getAccessToken).toHaveBeenCalledOnce();
        expect(fetchImplementation).toHaveBeenCalledOnce();
        const [url, request] = fetchImplementation.mock.calls[0];
        expect(url).toBe(
          "https://api.example.com/prod/admin/catalog/products/product%2Flegacy%20%2Bcode",
        );
        expect(request?.method).toBe("PATCH");
        expect(new Headers(request?.headers).get("authorization")).toBe(
          "Bearer cognito-admin-access-token",
        );
        expect(JSON.parse(String(request?.body))).toEqual({
          ...draft,
          compareAtPrice: "",
          isVisible,
          version: 7,
        });
        expect(String(request?.body)).toContain('"compareAtPrice":""');
      },
    );

    it.each(["129000", " 129000 ", "0", "not-a-number"])(
      "preserves the comparison price string without silent parsing for edit %j",
      async (compareAtPrice) => {
        const fetchImplementation = vi
          .fn<typeof fetch>()
          .mockResolvedValue(Response.json({}));
        const { client } = createClient(fetchImplementation);
        await client.saveProductDraft({
          ...draft,
          productId: "product-1",
          version: 8,
          compareAtPrice,
        });
        expect(fetchImplementation).toHaveBeenCalledOnce();
        const [url, request] = fetchImplementation.mock.calls[0];
        expect(url).toBe(
          "https://api.example.com/prod/admin/catalog/products/product-1",
        );
        expect(request?.method).toBe("PATCH");
        expect(JSON.parse(String(request?.body))).toEqual({
          ...draft,
          compareAtPrice,
          version: 8,
        });
      },
    );

    it.each(["129000", " 129000 ", "0", "not-a-number"])(
      "preserves a supplied new-product comparison price string %j",
      async (compareAtPrice) => {
        const fetchImplementation = vi
          .fn<typeof fetch>()
          .mockResolvedValue(Response.json({}));
        const { client } = createClient(fetchImplementation);
        await client.saveProductDraft({ ...draft, compareAtPrice });
        expect(fetchImplementation).toHaveBeenCalledOnce();
        const [url, request] = fetchImplementation.mock.calls[0];
        expect(url).toBe("https://api.example.com/prod/admin/catalog/products");
        expect(request?.method).toBe("POST");
        expect(JSON.parse(String(request?.body))).toEqual({ ...draft, compareAtPrice });
      },
    );

    it.each([{}, { productId: "legacy-without-version" }, { version: 7 }])(
      "keeps blank comparison price omitted on the existing create path %j",
      async (identity) => {
        const fetchImplementation = vi
          .fn<typeof fetch>()
          .mockResolvedValue(Response.json({}));
        const { client } = createClient(fetchImplementation);
        await client.saveProductDraft({ ...draft, ...identity });
        expect(fetchImplementation).toHaveBeenCalledOnce();
        const [url, request] = fetchImplementation.mock.calls[0];
        expect(url).toBe("https://api.example.com/prod/admin/catalog/products");
        expect(request?.method).toBe("POST");
        const body = JSON.parse(String(request?.body));
        expect(body).not.toHaveProperty("compareAtPrice");
        expect(body).not.toHaveProperty("version");
        expect(body).not.toHaveProperty("productId");
        const { compareAtPrice: omitted, ...expected } = draft;
        expect(omitted).toBe("");
        expect(body).toEqual(expected);
      },
    );

    it("does not send an explicit removal without an authenticated administrator token", async () => {
      const fetchImplementation = vi.fn<typeof fetch>();
      const client = createAdminApiClient({
        config: apiConfig,
        authorizationTokenProvider: { getAccessToken: () => null },
        fetchImplementation,
      });
      await expect(
        client.saveProductDraft({ ...draft, productId: "product-1", version: 7 }),
      ).rejects.toThrow();
      expect(fetchImplementation).not.toHaveBeenCalled();
    });

    it("propagates a rejected removal once without retrying or altering the draft", async () => {
      const fetchImplementation = vi
        .fn<typeof fetch>()
        .mockResolvedValue(
          Response.json({ code: "CATALOG_PRODUCT_VERSION_CONFLICT" }, { status: 409 }),
        );
      const { client } = createClient(fetchImplementation);
      const input = Object.freeze({ ...draft, productId: "product-1", version: 7 });
      await expect(client.saveProductDraft(input)).rejects.toMatchObject({
        status: 409,
      });
      expect(fetchImplementation).toHaveBeenCalledOnce();
      expect(
        JSON.parse(String(fetchImplementation.mock.calls[0][1]?.body)),
      ).toMatchObject({
        compareAtPrice: "",
        version: 7,
      });
      expect(input).toMatchObject({ compareAtPrice: "", version: 7 });
    });
  });
});
