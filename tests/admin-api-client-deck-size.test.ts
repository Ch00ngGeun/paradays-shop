import { afterEach, describe, expect, it, vi } from "vitest";
import { AdminApiRequestError } from "@/lib/commerce/admin-api-client";
import { AdminApiResponseError } from "@/lib/commerce/admin-api-client-errors";
import { createClient } from "./admin-api-client-fixtures";

afterEach(() => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
});

describe("createAdminApiClient", () => {
  describe("deck size spec", () => {
    const deckSpec = {
      nose: 6.875,
      tail: 6.5,
      width: 8.5,
      length: 31.75,
      wheelbase: 14.25,
    };
    const savedProduct = (version: number, spec?: typeof deckSpec) => ({
      productId: "prd_deck",
      name: "Deck",
      brandName: "Quasi",
      category: "Deck",
      price: 107000,
      inventoryQuantity: 3,
      status: "PUBLISHED",
      featured: false,
      version,
      description: [],
      sizes: ["8.5"],
      ...(spec ? { deckSpec: spec } : {}),
    });

    it("PATCHes only version and deckSpec and returns the updated row", async () => {
      const fetchImplementation = vi.fn<typeof fetch>().mockResolvedValue(
        new Response(JSON.stringify({ product: savedProduct(4, deckSpec) }), {
          status: 200,
        }),
      );
      const { client } = createClient(fetchImplementation);

      const product = await client.updateProductDeckSpec({
        id: "prd_deck",
        version: 3,
        deckSpec,
      });

      expect(product).toMatchObject({ id: "prd_deck", version: 4, deckSpec });
      const [url, request] = fetchImplementation.mock.calls[0];
      expect(url).toBe("https://api.example.com/prod/admin/catalog/products/prd_deck");
      expect(request).toMatchObject({ method: "PATCH" });
      expect(JSON.parse(String(request?.body))).toEqual({ version: 3, deckSpec });
    });

    it("sends null to delete and rejects a response that still has a spec", async () => {
      const fetchImplementation = vi
        .fn<typeof fetch>()
        .mockResolvedValueOnce(
          new Response(JSON.stringify({ product: savedProduct(4) }), { status: 200 }),
        )
        .mockResolvedValueOnce(
          new Response(JSON.stringify({ product: savedProduct(5, deckSpec) }), {
            status: 200,
          }),
        );
      const { client } = createClient(fetchImplementation);

      const cleared = await client.updateProductDeckSpec({
        id: "prd_deck",
        version: 3,
        deckSpec: null,
      });
      expect(cleared).not.toHaveProperty("deckSpec");
      expect(JSON.parse(String(fetchImplementation.mock.calls[0][1]?.body))).toEqual({
        version: 3,
        deckSpec: null,
      });

      await expect(
        client.updateProductDeckSpec({ id: "prd_deck", version: 4, deckSpec: null }),
      ).rejects.toBeInstanceOf(AdminApiResponseError);
    });

    it("rejects a delete response that carries a malformed spec", async () => {
      const fetchImplementation = vi.fn<typeof fetch>().mockResolvedValue(
        new Response(
          JSON.stringify({ product: { ...savedProduct(4), deckSpec: {} } }),
          {
            status: 200,
          },
        ),
      );
      const { client } = createClient(fetchImplementation);

      await expect(
        client.updateProductDeckSpec({ id: "prd_deck", version: 3, deckSpec: null }),
      ).rejects.toBeInstanceOf(AdminApiResponseError);
    });

    it("rejects invalid inches before authentication or fetch", async () => {
      const fetchImplementation = vi.fn<typeof fetch>();
      const { client, getAccessToken } = createClient(fetchImplementation);

      for (const invalid of [
        { ...deckSpec, nose: 0 },
        { ...deckSpec, tail: Number.NaN },
        { ...deckSpec, length: 101 },
      ]) {
        await expect(
          client.updateProductDeckSpec({
            id: "prd_deck",
            version: 3,
            deckSpec: invalid,
          }),
        ).rejects.toBeInstanceOf(AdminApiResponseError);
      }
      expect(getAccessToken).not.toHaveBeenCalled();
      expect(fetchImplementation).not.toHaveBeenCalled();
    });

    const optionSpec = { ...deckSpec, width: 8.25, wheelbase: 14 };
    const respond = (product: object) =>
      new Response(JSON.stringify({ product }), { status: 200 });

    it("saves one size option with sizeDeckSpec and parses the option map", async () => {
      const fetchImplementation = vi.fn<typeof fetch>().mockResolvedValue(
        respond({
          ...savedProduct(4, deckSpec),
          sizes: ["8.25", "8.5"],
          deckSpecsBySize: { "8.25": optionSpec },
        }),
      );
      const { client } = createClient(fetchImplementation);

      const product = await client.updateProductDeckSpec({
        id: "prd_deck",
        version: 3,
        deckSpec: optionSpec,
        size: "8.25",
      });

      expect(JSON.parse(String(fetchImplementation.mock.calls[0][1]?.body))).toEqual({
        version: 3,
        size: "8.25",
        sizeDeckSpec: optionSpec,
      });
      expect(product.deckSpec).toEqual(deckSpec);
      expect(product.deckSpecsBySize).toEqual({ "8.25": optionSpec });
    });

    it("rejects an option save answered by a server without option charts", async () => {
      // An older server ignores size and sizeDeckSpec and only bumps the version.
      const fetchImplementation = vi
        .fn<typeof fetch>()
        .mockResolvedValue(respond(savedProduct(4, deckSpec)));
      const { client } = createClient(fetchImplementation);

      await expect(
        client.updateProductDeckSpec({
          id: "prd_deck",
          version: 3,
          deckSpec: optionSpec,
          size: "8.5",
        }),
      ).rejects.toBeInstanceOf(AdminApiResponseError);
    });

    it("deletes one size option with null and checks only that option", async () => {
      const fetchImplementation = vi
        .fn<typeof fetch>()
        .mockResolvedValueOnce(
          respond({
            ...savedProduct(4, deckSpec),
            deckSpecsBySize: { "8.0": optionSpec },
          }),
        )
        .mockResolvedValueOnce(
          respond({ ...savedProduct(5), deckSpecsBySize: { "8.5": optionSpec } }),
        );
      const { client } = createClient(fetchImplementation);

      const cleared = await client.updateProductDeckSpec({
        id: "prd_deck",
        version: 3,
        deckSpec: null,
        size: "8.5",
      });
      expect(JSON.parse(String(fetchImplementation.mock.calls[0][1]?.body))).toEqual({
        version: 3,
        size: "8.5",
        sizeDeckSpec: null,
      });
      expect(cleared.deckSpecsBySize).toEqual({ "8.0": optionSpec });

      await expect(
        client.updateProductDeckSpec({
          id: "prd_deck",
          version: 4,
          deckSpec: null,
          size: "8.5",
        }),
      ).rejects.toBeInstanceOf(AdminApiResponseError);
    });

    it("rejects an empty or oversized option name before authentication or fetch", async () => {
      const fetchImplementation = vi.fn<typeof fetch>();
      const { client, getAccessToken } = createClient(fetchImplementation);

      for (const size of ["", "   ", "x".repeat(51), 8.5 as unknown as string]) {
        await expect(
          client.updateProductDeckSpec({ id: "prd_deck", version: 3, deckSpec, size }),
        ).rejects.toBeInstanceOf(AdminApiResponseError);
      }
      expect(getAccessToken).not.toHaveBeenCalled();
      expect(fetchImplementation).not.toHaveBeenCalled();
    });

    it("renames an option with its chart in one PATCH and checks the renamed list", async () => {
      const fetchImplementation = vi.fn<typeof fetch>().mockResolvedValue(
        respond({
          ...savedProduct(4, deckSpec),
          sizes: ["8.25 wide", "8.5"],
          deckSpecsBySize: { "8.25 wide": optionSpec },
        }),
      );
      const { client } = createClient(fetchImplementation);

      const product = await client.updateProductDeckSpec({
        id: "prd_deck",
        version: 3,
        deckSpec: optionSpec,
        size: "8.25",
        sizeName: "8.25 wide",
      });

      expect(JSON.parse(String(fetchImplementation.mock.calls[0][1]?.body))).toEqual({
        version: 3,
        size: "8.25",
        sizeName: "8.25 wide",
        sizeDeckSpec: optionSpec,
      });
      expect(product.sizes).toBe("8.25 wide, 8.5");
      expect(product.deckSpecsBySize).toEqual({ "8.25 wide": optionSpec });
    });

    it("renames with an empty chart and sends the same-name save as the H-035 body", async () => {
      const fetchImplementation = vi
        .fn<typeof fetch>()
        .mockResolvedValueOnce(respond({ ...savedProduct(4), sizes: ["8.75", "8.5"] }))
        .mockResolvedValueOnce(
          respond({
            ...savedProduct(5),
            sizes: ["8.75", "8.5"],
            deckSpecsBySize: { "8.5": optionSpec },
          }),
        );
      const { client } = createClient(fetchImplementation);

      await client.updateProductDeckSpec({
        id: "prd_deck",
        version: 3,
        deckSpec: null,
        size: "8.25",
        sizeName: "8.75",
      });
      expect(JSON.parse(String(fetchImplementation.mock.calls[0][1]?.body))).toEqual({
        version: 3,
        size: "8.25",
        sizeName: "8.75",
        sizeDeckSpec: null,
      });

      // An unchanged name, even one the new-name rules would refuse, keeps the H-035 body.
      await client.updateProductDeckSpec({
        id: "prd_deck",
        version: 4,
        deckSpec: optionSpec,
        size: "8.5",
        sizeName: "8.5",
      });
      expect(JSON.parse(String(fetchImplementation.mock.calls[1][1]?.body))).toEqual({
        version: 4,
        size: "8.5",
        sizeDeckSpec: optionSpec,
      });
    });

    it("rejects a rename answered with the old option name still listed", async () => {
      // A server before H-035 ignores every option field and only bumps the version.
      for (const sizes of [["8.25", "8.5"], ["8.25", "8.25 wide"], "8.25 wide"]) {
        const fetchImplementation = vi.fn<typeof fetch>().mockResolvedValue(
          respond({
            ...savedProduct(4),
            sizes,
            deckSpecsBySize: { "8.25 wide": optionSpec },
          }),
        );
        const { client } = createClient(fetchImplementation);

        await expect(
          client.updateProductDeckSpec({
            id: "prd_deck",
            version: 3,
            deckSpec: optionSpec,
            size: "8.25",
            sizeName: "8.25 wide",
          }),
        ).rejects.toBeInstanceOf(AdminApiResponseError);
      }
    });

    it("rejects an invalid new option name before authentication or fetch", async () => {
      const fetchImplementation = vi.fn<typeof fetch>();
      const { client, getAccessToken } = createClient(fetchImplementation);

      for (const input of [
        { size: "8.25", sizeName: "" },
        { size: "8.25", sizeName: " 8.75" },
        { size: "8.25", sizeName: "8.75 " },
        { size: "8.25", sizeName: "x".repeat(51) },
        { size: "8.25", sizeName: "8.75, 9.0" },
        { size: "8.25", sizeName: "8.75\n" },
        { size: "8.25", sizeName: "__proto__" },
        { size: "8.25", sizeName: "constructor" },
        { size: "8.25", sizeName: "prototype" },
        { size: "8.25", sizeName: 8.75 as unknown as string },
        { sizeName: "8.75" },
      ]) {
        await expect(
          client.updateProductDeckSpec({
            id: "prd_deck",
            version: 3,
            deckSpec,
            ...input,
          }),
        ).rejects.toBeInstanceOf(AdminApiResponseError);
      }
      expect(getAccessToken).not.toHaveBeenCalled();
      expect(fetchImplementation).not.toHaveBeenCalled();
    });

    it.each([
      "CATALOG_PRODUCT_RESERVED",
      "CATALOG_PRODUCT_DUPLICATE",
      "CATALOG_PRODUCT_VERSION_CONFLICT",
    ])(
      "a single product PATCH keeps the safe %s code without the server message",
      async (code) => {
        const fetchImplementation = vi
          .fn<typeof fetch>()
          .mockResolvedValue(
            Response.json({ code, message: "PRIVATE_SERVER_MESSAGE" }, { status: 409 }),
          );
        const { client } = createClient(fetchImplementation);
        const error = await client
          .updateProductDeckSpec({
            id: "prd_deck",
            version: 3,
            deckSpec,
            size: "8.25",
            sizeName: "8.75",
          })
          .catch((caught) => caught);

        expect(error).toBeInstanceOf(AdminApiRequestError);
        expect(error).toMatchObject({ status: 409, responseCode: code });
        expect(error.message).not.toContain("PRIVATE_SERVER_MESSAGE");
        expect(fetchImplementation).toHaveBeenCalledOnce();
      },
    );

    it("a single product PATCH drops codes outside its list", async () => {
      for (const code of [
        "OCR_INTAKE_INVALID",
        "CATALOG_PRODUCT_INVALID",
        "ANYTHING",
      ]) {
        const { client } = createClient(
          vi
            .fn<typeof fetch>()
            .mockResolvedValue(Response.json({ code }, { status: 400 })),
        );
        await expect(
          client.updateProductDeckSpec({ id: "prd_deck", version: 3, deckSpec }),
        ).rejects.toMatchObject({ status: 400, responseCode: undefined });
      }
      // A non-JSON body is still a plain request error.
      const { client } = createClient(
        vi.fn<typeof fetch>().mockResolvedValue(new Response("oops", { status: 409 })),
      );
      await expect(
        client.updateProductDeckSpec({ id: "prd_deck", version: 3, deckSpec }),
      ).rejects.toMatchObject({ status: 409, responseCode: undefined });
    });

    it("other endpoints keep ignoring catalog codes", async () => {
      const fetchImplementation = vi
        .fn<typeof fetch>()
        .mockResolvedValue(
          Response.json({ code: "CATALOG_PRODUCT_RESERVED" }, { status: 409 }),
        );
      const { client } = createClient(fetchImplementation);
      await expect(client.loadOverviewMetrics()).rejects.toMatchObject({
        status: 409,
        responseCode: undefined,
      });
    });

    it("keeps only well-formed option charts when listing products", async () => {
      const fetchImplementation = vi.fn<typeof fetch>().mockResolvedValue(
        new Response(
          JSON.stringify({
            products: [
              {
                ...savedProduct(4),
                deckSpecsBySize: {
                  "8.25": optionSpec,
                  "8.5": { ...optionSpec, nose: 0 },
                },
              },
              {
                ...savedProduct(4),
                productId: "prd_bad",
                deckSpecsBySize: { "8.5": {} },
              },
            ],
          }),
          { status: 200 },
        ),
      );
      const { client } = createClient(fetchImplementation);

      const [kept, dropped] = await client.listCatalogProducts();
      expect(kept.deckSpecsBySize).toEqual({ "8.25": optionSpec });
      expect(dropped).not.toHaveProperty("deckSpecsBySize");
    });
  });
});
