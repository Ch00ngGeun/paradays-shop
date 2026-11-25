// 역할: 관리자 API 클라이언트의 의류·휠 사이즈표 조회·저장·옵션명 변경·도면 변경과 응답 검증을 확인함.
import { afterEach, describe, expect, it, vi } from "vitest";
import { AdminApiRequestError } from "@/lib/commerce/admin-api-client";
import { AdminApiResponseError } from "@/lib/commerce/admin-api-client-errors";
import { createClient } from "./admin-api-client-fixtures";

afterEach(() => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
});

describe("createAdminApiClient", () => {
  describe("clothing and wheel size chart", () => {
    const values = {
      length: 72,
      shoulder: 50.5,
      chest: 56,
      sleeveLength: 22,
      hem: 55,
      sleeveWidth: 20.5,
      armhole: 24,
    };
    const sizeChart = { kind: "shortSleeve" as const, values };
    const top = (version: number, extra: Record<string, unknown> = {}) => ({
      productId: "prd_top",
      name: "Top",
      brandName: "Quasi",
      category: "Top",
      price: 50000,
      inventoryQuantity: 3,
      status: "PUBLISHED",
      featured: false,
      version,
      description: [],
      sizes: ["S", "M"],
      ...extra,
    });
    const respond = (...products: Record<string, unknown>[]) => {
      const fetchImplementation = vi.fn<typeof fetch>();
      for (const product of products)
        fetchImplementation.mockResolvedValueOnce(Response.json({ product }));
      return { fetchImplementation, ...createClient(fetchImplementation) };
    };
    const sent = (
      fetchImplementation: ReturnType<typeof vi.fn<typeof fetch>>,
      call = 0,
    ) => JSON.parse(String(fetchImplementation.mock.calls[call][1]?.body));

    it("lists the default, the drawing and option values that fit it", async () => {
      const reversed = Object.fromEntries(Object.entries(values).reverse());
      const { client } = createClient(
        vi.fn<typeof fetch>().mockResolvedValue(
          Response.json({
            products: [
              top(4, {
                sizeChart: { kind: "shortSleeve", values: reversed },
                sizeChartKind: "shortSleeve",
                sizeChartsBySize: {
                  S: values,
                  M: { ...values, length: 300.1 },
                  L: { diameter: 54, width: 33, contactWidth: 20 },
                },
              }),
              // 옵션만 있어도 자기 도면 이름을 가짐.
              top(4, {
                productId: "prd_options",
                sizeChartKind: "raglanLongSleeve",
                sizeChartsBySize: {
                  M: {
                    length: 70,
                    chest: 58,
                    cuff: 10,
                    neckToCuff: 80,
                    hem: 50,
                    armhole: 30,
                  },
                },
              }),
              top(4, {
                productId: "prd_bad",
                sizeChart: { kind: "deck", values },
                sizeChartKind: "deck",
                sizeChartsBySize: { M: values },
              }),
            ],
          }),
        ),
      );
      const [kept, optionsOnly, dropped] = await client.listCatalogProducts();
      expect(kept.sizeChart).toEqual(sizeChart);
      expect(Object.keys(kept.sizeChart!.values)).toEqual(Object.keys(values));
      expect(kept.sizeChartKind).toBe("shortSleeve");
      expect(kept.sizeChartsBySize).toEqual({ S: values });
      expect(optionsOnly.sizeChart).toBeUndefined();
      expect(optionsOnly.sizeChartKind).toBe("raglanLongSleeve");
      expect(Object.keys(optionsOnly.sizeChartsBySize ?? {})).toEqual(["M"]);
      for (const field of ["sizeChart", "sizeChartKind", "sizeChartsBySize"])
        expect(dropped).not.toHaveProperty(field);
    });

    it("saves the default with its own PATCH and checks the stored value, not a missing one", async () => {
      const reversed = Object.fromEntries(Object.entries(values).reverse());
      const { client, fetchImplementation } = respond(
        top(4, { sizeChart: { kind: "shortSleeve", values: reversed } }),
        // 구버전 서버는 이 필드를 무시하고 없이 응답함.
        top(5),
        top(6, {
          sizeChart: { kind: "shortSleeve", values: { ...values, length: 73 } },
        }),
        top(7),
        top(8, { sizeChart }),
      );
      const saved = await client.updateProductSizeChart({
        id: "prd_top",
        version: 3,
        sizeChart,
      });
      expect(saved).toMatchObject({ id: "prd_top", version: 4, sizeChart });
      expect(sent(fetchImplementation)).toEqual({ version: 3, sizeChart });
      expect(fetchImplementation.mock.calls[0][1]).toMatchObject({ method: "PATCH" });
      for (const version of [4, 5])
        await expect(
          client.updateProductSizeChart({ id: "prd_top", version, sizeChart }),
        ).rejects.toBeInstanceOf(AdminApiResponseError);
      const cleared = await client.updateProductSizeChart({
        id: "prd_top",
        version: 6,
        sizeChart: null,
      });
      expect(cleared).not.toHaveProperty("sizeChart");
      expect(sent(fetchImplementation, 3)).toEqual({ version: 6, sizeChart: null });
      await expect(
        client.updateProductSizeChart({ id: "prd_top", version: 7, sizeChart: null }),
      ).rejects.toBeInstanceOf(AdminApiResponseError);
    });

    it("saves one option's values, renames only on a real new name, and checks the saved option", async () => {
      const { client, fetchImplementation } = respond(
        top(4, { sizeChartKind: "shortSleeve", sizeChartsBySize: { M: values } }),
        top(5, {
          sizes: ["S", "L"],
          sizeChartKind: "shortSleeve",
          sizeChartsBySize: { L: values },
        }),
        // 구버전 서버: 옵션 맵도 kind도 없음.
        top(6),
        // 이름 변경 무시됨: 예전 이름이 여전히 목록에 있음.
        top(7, { sizeChartKind: "shortSleeve", sizeChartsBySize: { L: values } }),
        top(8, { sizeChartKind: "shortSleeve" }),
      );
      await client.updateProductOptionSizeChart({
        id: "prd_top",
        version: 3,
        size: "M",
        sizeName: "M",
        sizeChartValues: values,
      });
      expect(sent(fetchImplementation)).toEqual({
        version: 3,
        size: "M",
        sizeChartValues: values,
      });
      const renamed = await client.updateProductOptionSizeChart({
        id: "prd_top",
        version: 4,
        size: "M",
        sizeName: "L",
        sizeChartValues: values,
      });
      expect(renamed.sizeChartsBySize).toEqual({ L: values });
      expect(sent(fetchImplementation, 1)).toEqual({
        version: 4,
        size: "M",
        sizeName: "L",
        sizeChartValues: values,
      });
      await expect(
        client.updateProductOptionSizeChart({
          id: "prd_top",
          version: 5,
          size: "M",
          sizeChartValues: values,
        }),
      ).rejects.toBeInstanceOf(AdminApiResponseError);
      await expect(
        client.updateProductOptionSizeChart({
          id: "prd_top",
          version: 6,
          size: "M",
          sizeName: "L",
          sizeChartValues: values,
        }),
      ).rejects.toBeInstanceOf(AdminApiResponseError);
      const cleared = await client.updateProductOptionSizeChart({
        id: "prd_top",
        version: 7,
        size: "M",
        sizeChartValues: null,
      });
      expect(cleared).not.toHaveProperty("sizeChartsBySize");
      expect(sent(fetchImplementation, 4)).toEqual({
        version: 7,
        size: "M",
        sizeChartValues: null,
      });
    });

    it("changes the drawing and fails when the server does not name the new one", async () => {
      const { client, fetchImplementation } = respond(
        top(4, { sizeChartKind: "raglanLongSleeve" }),
        top(5),
      );
      const changed = await client.updateProductSizeChartKind({
        id: "prd_top",
        version: 3,
        sizeChartKind: "raglanLongSleeve",
      });
      expect(changed.sizeChartKind).toBe("raglanLongSleeve");
      expect(sent(fetchImplementation)).toEqual({
        version: 3,
        sizeChartKind: "raglanLongSleeve",
      });
      await expect(
        client.updateProductSizeChartKind({
          id: "prd_top",
          version: 4,
          sizeChartKind: "raglanLongSleeve",
        }),
      ).rejects.toBeInstanceOf(AdminApiResponseError);
    });

    it("rejects bad input before authentication or fetch", async () => {
      const fetchImplementation = vi.fn<typeof fetch>();
      const { client, getAccessToken } = createClient(fetchImplementation);
      const attempts = [
        () => client.updateProductSizeChart({ id: " ", version: 3, sizeChart }),
        () => client.updateProductSizeChart({ id: "prd_top", version: 0, sizeChart }),
        () =>
          client.updateProductSizeChart({
            id: "prd_top",
            version: 3,
            sizeChart: { kind: "shortSleeve", values: { ...values, length: 300.1 } },
          }),
        () =>
          client.updateProductSizeChart({
            id: "prd_top",
            version: 3,
            sizeChart: { kind: "deck" as never, values },
          }),
        () =>
          client.updateProductOptionSizeChart({
            id: "prd_top",
            version: 3,
            size: "",
            sizeChartValues: values,
          }),
        () =>
          client.updateProductOptionSizeChart({
            id: "prd_top",
            version: 3,
            size: "M",
            sizeName: "a,b",
            sizeChartValues: values,
          }),
        () =>
          client.updateProductOptionSizeChart({
            id: "prd_top",
            version: 3,
            size: "M",
            sizeChartValues: { length: 72 },
          }),
        () =>
          client.updateProductSizeChartKind({
            id: "prd_top",
            version: 3,
            sizeChartKind: "deck" as never,
          }),
      ];
      for (const attempt of attempts)
        await expect(attempt()).rejects.toBeInstanceOf(AdminApiResponseError);
      expect(getAccessToken).not.toHaveBeenCalled();
      expect(fetchImplementation).not.toHaveBeenCalled();
    });

    it("keeps the safe catalog conflict code on every size chart PATCH", async () => {
      const calls = [
        (client: ReturnType<typeof createClient>["client"]) =>
          client.updateProductSizeChart({ id: "prd_top", version: 3, sizeChart }),
        (client: ReturnType<typeof createClient>["client"]) =>
          client.updateProductOptionSizeChart({
            id: "prd_top",
            version: 3,
            size: "M",
            sizeName: "L",
            sizeChartValues: values,
          }),
        (client: ReturnType<typeof createClient>["client"]) =>
          client.updateProductSizeChartKind({
            id: "prd_top",
            version: 3,
            sizeChartKind: "raglanLongSleeve",
          }),
      ];
      for (const call of calls) {
        const { client } = createClient(
          vi
            .fn<typeof fetch>()
            .mockResolvedValue(
              Response.json(
                { code: "CATALOG_PRODUCT_DUPLICATE", message: "PRIVATE" },
                { status: 409 },
              ),
            ),
        );
        const error = await call(client).catch((caught) => caught);
        expect(error).toBeInstanceOf(AdminApiRequestError);
        expect(error).toMatchObject({
          status: 409,
          responseCode: "CATALOG_PRODUCT_DUPLICATE",
        });
        expect(error.message).not.toContain("PRIVATE");
      }
    });
  });
});
