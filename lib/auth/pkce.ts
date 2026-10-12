// 역할: Cognito Authorization Code flow에서 쓰는 PKCE verifier·challenge와 OIDC 난수를 생성합니다.

/** 브라우저 Web Crypto 난수 생성기에 맞춘 주입 가능한 타입. */
export type RandomBytesSource = (byteLength: number) => Uint8Array;

/** 브라우저 Web Crypto SHA-256 처리에 맞춘 주입 가능한 타입. */
export type Sha256Digest = (value: string) => Promise<ArrayBuffer>;

/** Uint8Array를 URL-safe Base64 문자열로 바꿉니다. */
function toBase64Url(bytes: Uint8Array) {
  let binary = "";

  for (const byte of bytes) {
    binary += String.fromCharCode(byte);
  }

  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/g, "");
}

/** 지원되는 브라우저의 암호학적 난수를 읽습니다. */
function getRandomBytes(byteLength: number) {
  if (!globalThis.crypto?.getRandomValues) {
    throw new Error("AUTH_WEB_CRYPTO_UNAVAILABLE");
  }

  return globalThis.crypto.getRandomValues(new Uint8Array(byteLength));
}

/** 지원되는 브라우저의 SHA-256 구현으로 PKCE challenge 원문을 해시합니다. */
async function digestSha256(value: string) {
  if (!globalThis.crypto?.subtle) {
    throw new Error("AUTH_WEB_CRYPTO_UNAVAILABLE");
  }

  return globalThis.crypto.subtle.digest("SHA-256", new TextEncoder().encode(value));
}

/** PKCE와 OIDC state/nonce에 쓸 충분히 긴 URL-safe 난수를 생성합니다. */
export function createRandomValue(
  byteLength = 32,
  randomBytes: RandomBytesSource = getRandomBytes,
) {
  return toBase64Url(randomBytes(byteLength));
}

/** PKCE verifier를 생성합니다. 64바이트 난수는 RFC 7636 허용 길이 안에 들어갑니다. */
export function createCodeVerifier(randomBytes: RandomBytesSource = getRandomBytes) {
  return createRandomValue(64, randomBytes);
}

/** PKCE S256 code challenge를 만듭니다. */
export async function createCodeChallenge(
  verifier: string,
  sha256Digest: Sha256Digest = digestSha256,
) {
  const digest = await sha256Digest(verifier);

  return toBase64Url(new Uint8Array(digest));
}
