/** Admin-only manual sales and KST day close API. No PG or card data integration. */
import type {
  APIGatewayProxyEventV2WithJWTAuthorizer,
  APIGatewayProxyResultV2,
  Context,
} from "aws-lambda";
import { authorizeAdmin } from "./admin-auth.js";
import { getRequiredEnvironment } from "./dynamodb-client.js";
import { jsonResponse } from "./http-response.js";
import { parseJsonBody } from "./request-helpers.js";
import { parseSalesCommand, validDay, SalesError } from "./sales-ledger-domain.js";
import { operateSalesDay, readSalesDay } from "./sales-ledger-store.js";
import { InventoryError } from "./order-inventory-domain.js";
import { SALES_REQUEST_BUDGET_MS, withSalesRequest } from "./sales-request-deadline.js";

export async function handler(
  event: APIGatewayProxyEventV2WithJWTAuthorizer,
  context?: Pick<Context, "getRemainingTimeInMillis">,
): Promise<APIGatewayProxyResultV2> {
  try {
    // Leave serialization/transport headroom before the 28-second Lambda timeout.
    const budget = Math.min(
      SALES_REQUEST_BUDGET_MS,
      (context?.getRemainingTimeInMillis() ?? 28_000) - 3_000,
    );
    return await withSalesRequest(() => handle(event), budget);
  } catch (e) {
    if (e instanceof SalesError) return jsonResponse(e.status, { code: e.code });
    return jsonResponse(503, { code: "SALES_STORAGE_UNAVAILABLE" });
  }
}
async function handle(
  event: APIGatewayProxyEventV2WithJWTAuthorizer,
): Promise<APIGatewayProxyResultV2> {
  const auth = await authorizeAdmin(event);
  if (!auth.ok) return jsonResponse(auth.statusCode, { code: auth.code });
  const day = event.pathParameters?.businessDay;
  if (!validDay(day)) return jsonResponse(400, { code: "SALES_BUSINESS_DAY_INVALID" });
  const method = event.requestContext.http.method;
  if (method !== "GET" && method !== "POST")
    return jsonResponse(405, { code: "METHOD_NOT_ALLOWED" });
  try {
    for (const key of [
      "SALES_LEDGER_TABLE_NAME",
      "CATALOG_TABLE_NAME",
      "ORDER_TABLE_NAME",
    ])
      getRequiredEnvironment(key);
  } catch {
    return jsonResponse(503, { code: "SALES_CONFIGURATION_UNAVAILABLE" });
  }
  try {
    if (method === "GET") return jsonResponse(200, { report: await readSalesDay(day) });
    if ((event.body?.length ?? 0) > 100_000)
      return jsonResponse(400, { code: "SALES_BODY_INVALID" });
    const command = parseSalesCommand(parseJsonBody(event), day);
    if (!command) return jsonResponse(400, { code: "SALES_BODY_INVALID" });
    return jsonResponse(200, await operateSalesDay(day, command, auth.userSub));
  } catch (e) {
    if (e instanceof SalesError || e instanceof InventoryError)
      return jsonResponse(e.status, { code: e.code });
    return jsonResponse(503, { code: "SALES_STORAGE_UNAVAILABLE" });
  }
}
