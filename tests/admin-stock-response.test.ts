import { afterEach, describe, expect, it, vi } from "vitest";
import {
  AdminApiResponseError,
  createAdminApiClient,
} from "@/lib/commerce/admin-api-client";
import { getCheckoutApiConfig } from "@/lib/commerce/checkout-api-client";

afterEach(() => vi.unstubAllEnvs());
const product = {
  productId: "product-1",
  name: "Deck",
  brandName: "PARADAYS",
  category: "Deck",
  price: 1000,
  inventoryQuantity: 9,
  status: "DRAFT",
  featured: false,
  version: 4,
  description: [],
  sizes: [],
  sku: "DECK-1",
};
function client(response: Record<string, unknown>) {
  vi.stubEnv("NEXT_PUBLIC_LOCAL_OCR_ENABLED", "false");
  vi.stubEnv("NEXT_PUBLIC_OCR_DEMO_ENABLED", "false");
  const fetchImplementation = vi
    .fn<typeof fetch>()
    .mockResolvedValue(Response.json({ product: response }));
  const api = createAdminApiClient({
    config: getCheckoutApiConfig({
      NEXT_PUBLIC_COMMERCE_API_BASE_URL: "https://commerce.test/prod/",
    }),
    authorizationTokenProvider: { getAccessToken: () => "synthetic-admin-token" },
    fetchImplementation,
  });
  return { api, fetchImplementation };
}
describe("canonical stock response", () => {
  it("uses the existing authenticated Commerce endpoint with a fixed absolute target", async () => {
    const { api, fetchImplementation } = client(product);
    await expect(
      api.updateProductStock({ id: "product-1", version: 3, stock: 9 }),
    ).resolves.toMatchObject({ id: "product-1", version: 4, stock: 9 });
    expect(fetchImplementation).toHaveBeenCalledOnce();
    const [url, init] = fetchImplementation.mock.calls[0];
    expect(String(url)).toBe(
      "https://commerce.test/prod/admin/catalog/products/product-1",
    );
    expect(init?.method).toBe("PATCH");
    expect(JSON.parse(String(init?.body))).toEqual({ version: 3, stock: 9 });
    expect(new Headers(init?.headers).get("Authorization")).toBe(
      "Bearer synthetic-admin-token",
    );
  });
  it.each([
    { ...product, productId: "other-product" },
    { ...product, version: 3 },
    { ...product, version: 5 },
    { ...product, inventoryQuantity: 8 },
  ])(
    "rejects a valid-shaped response that does not confirm the requested write",
    async (response) => {
      const { api, fetchImplementation } = client(response);
      await expect(
        api.updateProductStock({ id: "product-1", version: 3, stock: 9 }),
      ).rejects.toBeInstanceOf(AdminApiResponseError);
      expect(fetchImplementation).toHaveBeenCalledOnce();
    },
  );
  it("rejects out-of-range stock before requesting anything", async () => {
    const { api, fetchImplementation } = client(product);
    await expect(
      api.updateProductStock({ id: "product-1", version: 3, stock: 1_000_001 }),
    ).rejects.toBeInstanceOf(AdminApiResponseError);
    expect(fetchImplementation).not.toHaveBeenCalled();
  });
});
