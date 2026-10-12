/**
 * 역할: 관리자만 상품 이미지를 S3에 올릴 수 있는 짧은 수명 프리사인 URL을 발급함.
 * 기능: MIME·용량을 검증한 뒤 PutObject URL과 공개 HTTPS URL을 돌려줌.
 */

import { randomUUID } from "node:crypto";
import { PutObjectCommand, S3Client } from "@aws-sdk/client-s3";
import { getSignedUrl } from "@aws-sdk/s3-request-presigner";
import type {
  APIGatewayProxyEventV2WithJWTAuthorizer,
  APIGatewayProxyResultV2,
} from "aws-lambda";

import { authorizeAdmin } from "./admin-auth.js";
import { getRequiredEnvironment } from "./dynamodb-client.js";
import { jsonResponse } from "./http-response.js";
import { isRecord, parseJsonBody, readBoundedString } from "./request-helpers.js";

const ALLOWED_CONTENT_TYPES = new Set([
  "image/jpeg",
  "image/png",
  "image/webp",
  "image/gif",
]);
const MAX_UPLOAD_BYTES = 6 * 1024 * 1024;
const PRESIGN_EXPIRES_SECONDS = 300;

const s3Client = new S3Client({});

/** POST /admin/catalog/uploads — 프리사인 Put URL 발급 */
export async function handler(
  event: APIGatewayProxyEventV2WithJWTAuthorizer,
): Promise<APIGatewayProxyResultV2> {
  const authorization = await authorizeAdmin(event);

  if (!authorization.ok) {
    return jsonResponse(authorization.statusCode, { code: authorization.code });
  }

  if (event.requestContext.http.method !== "POST") {
    return jsonResponse(405, { code: "METHOD_NOT_ALLOWED" });
  }

  let bucketName: string;
  let publicBaseUrl: string;

  try {
    bucketName = getRequiredEnvironment("PRODUCT_IMAGE_BUCKET_NAME");
    publicBaseUrl = getRequiredEnvironment("PRODUCT_IMAGE_PUBLIC_BASE_URL").replace(
      /\/+$/,
      "",
    );
  } catch {
    return jsonResponse(503, { code: "UPLOAD_CONFIGURATION_UNAVAILABLE" });
  }

  const body = parseJsonBody(event);
  const request = parseUploadRequest(body);

  if (!request) {
    return jsonResponse(400, { code: "UPLOAD_REQUEST_INVALID" });
  }

  const extension = extensionForContentType(request.contentType);
  const objectKey = `products/${authorization.userSub}/${Date.now()}-${randomUUID()}.${extension}`;

  try {
    const uploadUrl = await getSignedUrl(
      s3Client,
      new PutObjectCommand({
        Bucket: bucketName,
        Key: objectKey,
        ContentType: request.contentType,
        ContentLength: request.contentLength,
      }),
      { expiresIn: PRESIGN_EXPIRES_SECONDS },
    );

    return jsonResponse(200, {
      uploadUrl,
      publicUrl: `${publicBaseUrl}/${objectKey}`,
      objectKey,
      expiresIn: PRESIGN_EXPIRES_SECONDS,
      contentType: request.contentType,
      maxBytes: MAX_UPLOAD_BYTES,
    });
  } catch {
    return jsonResponse(503, { code: "UPLOAD_URL_UNAVAILABLE" });
  }
}

function parseUploadRequest(body: unknown): {
  contentType: string;
  contentLength: number;
} | null {
  if (!isRecord(body)) {
    return null;
  }

  const contentType = readBoundedString(body.contentType, 80)?.toLowerCase();
  const contentLength =
    typeof body.contentLength === "number"
      ? body.contentLength
      : typeof body.contentLength === "string" && /^\d+$/.test(body.contentLength)
        ? Number(body.contentLength)
        : NaN;

  if (
    !contentType ||
    !ALLOWED_CONTENT_TYPES.has(contentType) ||
    !Number.isSafeInteger(contentLength) ||
    contentLength <= 0 ||
    contentLength > MAX_UPLOAD_BYTES
  ) {
    return null;
  }

  return { contentType, contentLength };
}

function extensionForContentType(contentType: string) {
  switch (contentType) {
    case "image/png":
      return "png";
    case "image/webp":
      return "webp";
    case "image/gif":
      return "gif";
    default:
      return "jpg";
  }
}
