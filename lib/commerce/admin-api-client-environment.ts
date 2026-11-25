/** Local OCR is an explicit development transport; Cognito authentication still applies. */
export function isLocalOcrDevelopmentMode(): boolean {
  return readLocalOcrApiBaseUrl() !== undefined;
}

/** 별도 공개 설정과 정확한 Firebase origin에서만 임시 HTTPS OCR을 사용합니다. */
export function isRemoteOcrDemoMode(): boolean {
  return readRemoteOcrDemoApiBaseUrl() !== undefined;
}

export function readRemoteOcrDemoApiBaseUrl(): string | undefined {
  if (
    process.env.NEXT_PUBLIC_OCR_DEMO_ENABLED !== "true" ||
    typeof window === "undefined" ||
    window.location.origin !== "https://paradays.web.app"
  )
    return undefined;
  try {
    // 발행 시 확인한 단일 HTTPS origin만 pin함. 사용자 입력·저장소는 읽지 않음.
    const allowedOrigin = process.env.NEXT_PUBLIC_OCR_DEMO_ALLOWED_API_ORIGIN;
    const url = new URL(process.env.NEXT_PUBLIC_OCR_DEMO_API_URL ?? "");
    return url.protocol === "https:" &&
      url.origin === allowedOrigin &&
      url.pathname === "/" &&
      !url.port &&
      !url.username &&
      !url.password &&
      !url.search &&
      !url.hash &&
      url.hostname.includes(".") &&
      !url.hostname.endsWith(".") &&
      !/^(?:[0-9.]+|\[.*\])$/.test(url.hostname) &&
      !["localhost", "paradays.web.app"].includes(url.hostname) &&
      !url.hostname.endsWith(".localhost") &&
      !url.hostname.endsWith(".local")
      ? url.origin
      : undefined;
  } catch {
    return undefined;
  }
}

export function readLocalOcrApiBaseUrl(): string | undefined {
  if (
    process.env.NODE_ENV !== "development" ||
    process.env.NEXT_PUBLIC_LOCAL_OCR_ENABLED !== "true" ||
    typeof window === "undefined" ||
    window.location.protocol !== "http:" ||
    !["localhost", "127.0.0.1"].includes(window.location.hostname)
  )
    return undefined;
  try {
    const url = new URL(process.env.NEXT_PUBLIC_LOCAL_OCR_API_URL ?? "");
    return url.protocol === "http:" &&
      ["localhost", "127.0.0.1"].includes(url.hostname) &&
      url.port === "8011" &&
      url.pathname === "/" &&
      !url.username &&
      !url.password &&
      !url.search &&
      !url.hash
      ? url.origin
      : undefined;
  } catch {
    return undefined;
  }
}
