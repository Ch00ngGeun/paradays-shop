// 역할: OCR inline image parser가 대형 base64에서도 정규식 RangeError 없이 경계를 지키는지 확인합니다.
import assert from "node:assert/strict";
import type { ReadableStreamReadResult } from "node:stream/web";
import test, { type TestContext } from "node:test";
import {
  MAX_PADDLE_OCR_RESPONSE_BYTES,
  PaddleOcrProviderError,
  recognizePaddleOcr,
} from "../lambda/paddle-ocr.js";
import {
  PNG_SIGNATURE,
  createCanonicalProviderEnvelope,
  TEST_CREDENTIALS,
} from "./paddle-ocr-fixture.js";

const TEST_IMAGE = {
  fileName: "fixture.png",
  mimeType: "image/png" as const,
  bytes: PNG_SIGNATURE,
};
const VALID_RESPONSE = JSON.stringify(
  createCanonicalProviderEnvelope({ rec_texts: ["입고 수량 2"], rec_scores: [0.8] }),
);

function safeProviderError(kind: PaddleOcrProviderError["kind"]) {
  return (error: unknown) => {
    assert.ok(error instanceof PaddleOcrProviderError);
    assert.equal(error.kind, kind);
    assert.equal(error.message, "PADDLE_OCR_PROVIDER_ERROR");
    return true;
  };
}

/** A fetch/reader harness records cleanup without real network or clock waits. */
function installResponse(
  t: TestContext,
  chunks: Uint8Array[],
  options: {
    contentLength?: string;
    read?: () => Promise<ReadableStreamReadResult<Uint8Array>>;
    cancel?: () => Promise<void>;
    ok?: boolean;
    missingBody?: boolean;
  } = {},
) {
  let signal: AbortSignal | undefined;
  let reads = 0;
  let cancellations = 0;
  let releases = 0;
  let notifyRead: () => void = () => {};
  const readStarted = new Promise<void>((resolve) => {
    notifyRead = resolve;
  });
  const cancel = () => {
    cancellations += 1;
    return options.cancel?.() ?? Promise.resolve();
  };
  const reader = {
    read: () => {
      reads += 1;
      notifyRead();
      if (options.read) return options.read();
      const value = chunks.shift();
      return Promise.resolve(
        value
          ? { done: false as const, value }
          : { done: true as const, value: undefined },
      );
    },
    cancel,
    releaseLock: () => {
      releases += 1;
    },
  };
  const response = {
    ok: options.ok ?? true,
    headers: new Headers(
      options.contentLength === undefined
        ? {}
        : { "content-length": options.contentLength },
    ),
    body: options.missingBody ? null : { getReader: () => reader, cancel },
  } as unknown as Response;
  t.mock.method(globalThis, "fetch", async (_url: unknown, init: RequestInit) => {
    signal = init.signal ?? undefined;
    return response;
  });
  return {
    readStarted,
    get signal() {
      return signal;
    },
    get reads() {
      return reads;
    },
    get cancellations() {
      return cancellations;
    },
    get releases() {
      return releases;
    },
  };
}

test("bounded streaming JSON preserves Korean text across UTF-8 chunk boundaries", async (t) => {
  const bytes = Buffer.from(VALID_RESPONSE);
  const split = bytes.indexOf(Buffer.from("입")) + 1;
  const transport = installResponse(t, [
    bytes.subarray(0, split),
    bytes.subarray(split),
  ]);
  const result = await recognizePaddleOcr(TEST_CREDENTIALS, TEST_IMAGE);
  assert.equal(result.rawText, "입고 수량 2");
  assert.equal(transport.cancellations, 0);
  assert.equal(transport.releases, 1);
});

test("native Response stream returns the canonical result and releases its lock", async (t) => {
  const response = new Response(VALID_RESPONSE);
  t.mock.method(globalThis, "fetch", async () => response);
  assert.equal(
    (await recognizePaddleOcr(TEST_CREDENTIALS, TEST_IMAGE)).rawText,
    "입고 수량 2",
  );
  assert.equal(response.body?.locked, false);
});

test("exactly 2MiB of valid JSON including whitespace is accepted", async (t) => {
  const data = Buffer.alloc(MAX_PADDLE_OCR_RESPONSE_BYTES, 0x20);
  Buffer.from(VALID_RESPONSE).copy(data);
  installResponse(t, [data]);
  assert.equal((await recognizePaddleOcr(TEST_CREDENTIALS, TEST_IMAGE)).rows.length, 1);
});

test("oversized streamed body without Content-Length is rejected and cancelled", async (t) => {
  const transport = installResponse(t, [
    Buffer.alloc(MAX_PADDLE_OCR_RESPONSE_BYTES + 1),
  ]);
  await assert.rejects(
    recognizePaddleOcr(TEST_CREDENTIALS, TEST_IMAGE),
    safeProviderError("RESPONSE"),
  );
  assert.equal(transport.cancellations, 1);
  assert.equal(transport.releases, 1);
  assert.equal(transport.signal?.aborted, true);
});

test("cumulative bytes override a lying small Content-Length", async (t) => {
  const transport = installResponse(
    t,
    [
      Buffer.alloc(MAX_PADDLE_OCR_RESPONSE_BYTES / 2),
      Buffer.alloc(MAX_PADDLE_OCR_RESPONSE_BYTES / 2 + 1),
    ],
    { contentLength: "1" },
  );
  await assert.rejects(
    recognizePaddleOcr(TEST_CREDENTIALS, TEST_IMAGE),
    safeProviderError("RESPONSE"),
  );
  assert.equal(transport.reads, 2);
  assert.equal(transport.cancellations, 1);
});

test("oversized declared body is cancelled before reading", async (t) => {
  const transport = installResponse(t, [], {
    contentLength: String(MAX_PADDLE_OCR_RESPONSE_BYTES + 1),
  });
  await assert.rejects(
    recognizePaddleOcr(TEST_CREDENTIALS, TEST_IMAGE),
    safeProviderError("RESPONSE"),
  );
  assert.equal(transport.reads, 0);
  assert.equal(transport.cancellations, 1);
});

test("invalid and truncated JSON return only the safe RESPONSE error", async (t) => {
  for (const value of ["not JSON", VALID_RESPONSE.slice(0, -1)]) {
    installResponse(t, [Buffer.from(value)]);
    await assert.rejects(
      recognizePaddleOcr(TEST_CREDENTIALS, TEST_IMAGE),
      safeProviderError("RESPONSE"),
    );
    t.mock.restoreAll();
  }
});

test("invalid and truncated UTF-8 are rejected rather than replaced", async (t) => {
  for (const bytes of [Buffer.from([0xff]), Buffer.from([0xe3, 0x81])]) {
    installResponse(t, [bytes]);
    await assert.rejects(
      recognizePaddleOcr(TEST_CREDENTIALS, TEST_IMAGE),
      safeProviderError("RESPONSE"),
    );
    t.mock.restoreAll();
  }
});

test("stalled body and stalled reader cancellation cannot extend 12-second deadline", async (t) => {
  t.mock.timers.enable({ apis: ["Date", "setTimeout"] });
  const transport = installResponse(t, [], {
    read: () => new Promise(() => {}),
    cancel: () => new Promise(() => {}),
  });
  const pending = recognizePaddleOcr(TEST_CREDENTIALS, TEST_IMAGE);
  const rejected = assert.rejects(pending, safeProviderError("REQUEST"));
  await transport.readStarted;
  const removeListener = t.mock.method(transport.signal!, "removeEventListener");
  t.mock.timers.tick(11_999);
  assert.equal(transport.signal?.aborted, false);
  t.mock.timers.tick(1);
  await rejected;
  assert.equal(transport.signal?.aborted, true);
  assert.equal(transport.cancellations, 1);
  assert.equal(transport.releases, 1);
  assert.equal(removeListener.mock.callCount(), 1);
});

test("headers and body share one deadline rather than resetting after headers", async (t) => {
  t.mock.timers.enable({ apis: ["Date", "setTimeout"] });
  const transport = installResponse(t, [], { read: () => new Promise(() => {}) });
  const originalMock = globalThis.fetch;
  t.mock.method(
    globalThis,
    "fetch",
    (...args: Parameters<typeof fetch>) =>
      new Promise<Response>((resolve) =>
        setTimeout(() => {
          void originalMock(...args).then(resolve);
        }, 9_000),
      ),
  );
  const rejected = assert.rejects(
    recognizePaddleOcr(TEST_CREDENTIALS, TEST_IMAGE),
    safeProviderError("REQUEST"),
  );
  t.mock.timers.tick(9_000);
  await transport.readStarted;
  t.mock.timers.tick(3_000);
  await rejected;
  assert.equal(transport.cancellations, 1);
});

test("successful response removes deadline timer and abort listener", async (t) => {
  t.mock.timers.enable({ apis: ["Date", "setTimeout"] });
  const transport = installResponse(t, [Buffer.from(VALID_RESPONSE)]);
  const pending = recognizePaddleOcr(TEST_CREDENTIALS, TEST_IMAGE);
  await transport.readStarted;
  const removeListener = t.mock.method(transport.signal!, "removeEventListener");
  await pending;
  t.mock.timers.tick(12_000);
  assert.equal(transport.signal?.aborted, false);
  assert.equal(removeListener.mock.callCount(), 1);
  assert.equal(transport.cancellations, 0);
});

test("synchronous parse finishing after deadline cannot return success", async (t) => {
  t.mock.timers.enable({ apis: ["Date", "setTimeout"] });
  const transport = installResponse(t, [Buffer.from(VALID_RESPONSE)]);
  const parse = JSON.parse;
  t.mock.method(JSON, "parse", (text: string) => {
    t.mock.timers.setTime(Date.now() + 12_000);
    return parse(text);
  });
  await assert.rejects(
    recognizePaddleOcr(TEST_CREDENTIALS, TEST_IMAGE),
    safeProviderError("REQUEST"),
  );
  assert.equal(transport.cancellations, 1);
});

test("synchronous parse failing after deadline retains timeout classification", async (t) => {
  t.mock.timers.enable({ apis: ["Date", "setTimeout"] });
  installResponse(t, [Buffer.from("not JSON")]);
  t.mock.method(JSON, "parse", () => {
    t.mock.timers.setTime(Date.now() + 12_000);
    throw new Error("private-parser-details");
  });
  await assert.rejects(
    recognizePaddleOcr(TEST_CREDENTIALS, TEST_IMAGE),
    safeProviderError("REQUEST"),
  );
});

test("stream read failure and rejecting cancellation preserve safe RESPONSE error", async (t) => {
  const transport = installResponse(t, [], {
    read: () => Promise.reject(new Error("upstream-private-details")),
    cancel: () => Promise.reject(new Error("cancel-private-details")),
  });
  await assert.rejects(
    recognizePaddleOcr(TEST_CREDENTIALS, TEST_IMAGE),
    safeProviderError("RESPONSE"),
  );
  assert.equal(transport.cancellations, 1);
  assert.equal(transport.releases, 1);
});

test("stalled fetch is bounded even when the fake transport ignores abort", async (t) => {
  t.mock.timers.enable({ apis: ["Date", "setTimeout"] });
  t.mock.method(globalThis, "fetch", () => new Promise<Response>(() => {}));
  const rejected = assert.rejects(
    recognizePaddleOcr(TEST_CREDENTIALS, TEST_IMAGE),
    safeProviderError("REQUEST"),
  );
  t.mock.timers.tick(12_000);
  await rejected;
});

test("non-OK and missing-body responses retain existing safe error kinds", async (t) => {
  installResponse(t, [], { ok: false });
  await assert.rejects(
    recognizePaddleOcr(TEST_CREDENTIALS, TEST_IMAGE),
    safeProviderError("REQUEST"),
  );
  t.mock.restoreAll();
  installResponse(t, [], { missingBody: true });
  await assert.rejects(
    recognizePaddleOcr(TEST_CREDENTIALS, TEST_IMAGE),
    safeProviderError("RESPONSE"),
  );
});
