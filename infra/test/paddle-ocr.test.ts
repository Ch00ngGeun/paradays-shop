// 역할: OCR inline image parser가 대형 base64에서도 정규식 RangeError 없이 경계를 지키는지 확인합니다.
import assert from "node:assert/strict";
import type { ReadableStreamReadResult } from "node:stream/web";
import test, { type TestContext } from "node:test";

import {
  MAX_INLINE_OCR_IMAGE_BYTES,
  MAX_PADDLE_OCR_RESPONSE_BYTES,
  PaddleOcrProviderError,
  parseOcrImageUpload,
  parseRecognitionResponse,
  recognizePaddleOcr,
} from "../lambda/paddle-ocr.js";

const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

function createPngBytes(byteLength: number) {
  const bytes = Buffer.alloc(byteLength);
  PNG_SIGNATURE.copy(bytes);

  return bytes;
}

function createUpload(imageBytes: Buffer, fileName = "arrival.png") {
  return {
    fileName,
    mimeType: "image/png",
    imageBase64: imageBytes.toString("base64"),
  };
}

function createCanonicalProviderEnvelope(prunedResult: unknown) {
  return {
    result: {
      ocrResults: [{ prunedResult }],
    },
  };
}

test("정확히 4MiB 유효 PNG base64는 RangeError 없이 수용합니다", () => {
  const parsed = parseOcrImageUpload(
    createUpload(createPngBytes(MAX_INLINE_OCR_IMAGE_BYTES)),
  );

  assert.equal(parsed.ok, true);

  if (parsed.ok) {
    assert.equal(parsed.image.bytes.length, MAX_INLINE_OCR_IMAGE_BYTES);
    assert.equal(parsed.image.mimeType, "image/png");
  }
});

const TEST_CREDENTIALS = {
  baseUrl: "https://ocr.example.test/provider",
  sharedSecret: "test-only-secret",
};

// Lambda only checks the lightweight signature; Python performs bounded header
// dimensions/pixel validation. Do not claim these fixtures decode as images.
const INPUT_FORMATS = [
  { mimeType: "image/png", bytes: PNG_SIGNATURE },
  { mimeType: "image/jpeg", bytes: Buffer.from([0xff, 0xd8, 0xff]) },
  { mimeType: "image/webp", bytes: Buffer.from("RIFF\0\0\0\0WEBP", "ascii") },
] as const;

for (const { mimeType, bytes } of INPUT_FORMATS) {
  test(`${mimeType} MIME/signature and raw/data-URI contract`, () => {
    const upload = {
      fileName: "입고 목록.png",
      mimeType,
      imageBase64: bytes.toString("base64"),
    };
    for (const imageBase64 of [
      upload.imageBase64,
      `data:${mimeType};base64,${upload.imageBase64}`,
    ]) {
      const result = parseOcrImageUpload({ ...upload, imageBase64 });
      assert.equal(result.ok, true);
      if (result.ok) {
        assert.equal(result.image.mimeType, mimeType);
        assert.equal(result.image.fileName, upload.fileName);
        assert.deepEqual(result.image.bytes, bytes);
      }
    }
    for (const input of [
      { ...upload, mimeType: mimeType === "image/png" ? "image/jpeg" : "image/png" },
      { ...upload, imageBase64: bytes.subarray(0, -1).toString("base64") },
      { ...upload, imageBase64: `data:image/gif;base64,${upload.imageBase64}` },
    ])
      assert.deepEqual(parseOcrImageUpload(input), {
        ok: false,
        code: "OCR_IMAGE_INVALID",
      });
  });

  test(`${mimeType} exact 4MiB accepted, same base64 quantum +1/+2 rejected`, () => {
    for (const extra of [0, 1, 2]) {
      const padded = Buffer.alloc(MAX_INLINE_OCR_IMAGE_BYTES + extra);
      bytes.copy(padded);
      const result = parseOcrImageUpload({
        fileName: "arrival.png",
        mimeType,
        imageBase64: padded.toString("base64"),
      });
      if (extra === 0) {
        assert.equal(result.ok, true);
        if (result.ok)
          assert.equal(result.image.bytes.length, MAX_INLINE_OCR_IMAGE_BYTES);
      } else assert.deepEqual(result, { ok: false, code: "OCR_IMAGE_TOO_LARGE" });
    }
  });
}

test("canonical base64 rejects corrupt alphabet, whitespace, padding, URLs and paths", () => {
  const canonical = PNG_SIGNATURE.toString("base64");
  for (const imageBase64 of [
    "",
    null,
    " " + canonical,
    canonical + "\n",
    canonical.slice(0, -1),
    canonical + "=",
    canonical.slice(0, -2) + "J=",
    "?" + canonical.slice(1),
    "_" + canonical.slice(1),
    "https://example.test/a.png",
    "../arrival.png",
    "/tmp/arrival.png",
  ]) {
    assert.deepEqual(
      parseOcrImageUpload({ ...createUpload(PNG_SIGNATURE), imageBase64 }),
      { ok: false, code: "OCR_IMAGE_INVALID" },
    );
  }
});

test("decomposed Hangul file names pass without changing their original code units", () => {
  const fileName = "\u1109\u1173\u110f\u1173\u1105\u1175\u11ab\u1109\u1163\u11ba2.png";
  const parsed = parseOcrImageUpload(createUpload(PNG_SIGNATURE, fileName));
  assert.equal(parsed.ok, true);
  if (parsed.ok) {
    assert.equal(parsed.image.fileName, fileName);
    assert.notEqual(parsed.image.fileName, "스크린샷2.png");
    assert.deepEqual(
      [...parsed.image.fileName].map((character) => character.charCodeAt(0)),
      [...fileName].map((character) => character.charCodeAt(0)),
    );
  }
});

test("standalone Hangul jamo remain valid at the start or inside file names", () => {
  for (const jamo of [
    "\u1100",
    "\u11ff",
    "\u3131",
    "\u318e",
    "\ua960",
    "\ua97c",
    "\ud7b0",
    "\ud7c6",
    "\ud7cb",
    "\ud7fb",
  ]) {
    for (const fileName of [jamo + ".png", "image-" + jamo + ".png"]) {
      const parsed = parseOcrImageUpload(createUpload(PNG_SIGNATURE, fileName));
      assert.equal(parsed.ok, true);
      if (parsed.ok) assert.equal(parsed.image.fileName, fileName);
    }
  }
});

test("decomposed Hangul keeps the original 120 UTF-16 code unit boundary", () => {
  const fileName = "\u1100\u1161".repeat(58) + ".png";
  assert.equal(fileName.length, 120);
  const parsed = parseOcrImageUpload(createUpload(PNG_SIGNATURE, fileName));
  assert.equal(parsed.ok, true);
  if (parsed.ok) assert.equal(parsed.image.fileName, fileName);
  assert.deepEqual(
    parseOcrImageUpload(createUpload(PNG_SIGNATURE, "\u1100" + fileName)),
    { ok: false, code: "OCR_IMAGE_INVALID" },
  );
});

test("Hangul jamo support does not allow unsafe or unrelated Unicode file names", () => {
  const decomposed = "\u1100\u1161";
  for (const fileName of [
    "../" + decomposed + ".png",
    "a/" + decomposed + ".png",
    "a\\" + decomposed + ".png",
    " " + decomposed + ".png",
    decomposed + ".png ",
    "." + decomposed + ".png",
    "_" + decomposed + ".png",
    "-" + decomposed + ".png",
    "a\u0000.png",
    "a\nb.png",
    "a\tb.png",
    "a\r.png",
    "😀.png",
    "e\u0301.png",
    "a\u200d.png",
    "a\u202e.png",
    "\u3130.png",
    "\u318f.png",
    "\ua97d.png",
    "\ud7c7.png",
    "\ud7fc.png",
  ]) {
    assert.deepEqual(parseOcrImageUpload(createUpload(PNG_SIGNATURE, fileName)), {
      ok: false,
      code: "OCR_IMAGE_INVALID",
    });
  }
});

test("file-name 120 boundary, unsupported MIME and unsafe name stay safe", () => {
  assert.equal(
    parseOcrImageUpload(createUpload(PNG_SIGNATURE, "가".repeat(116) + ".png")).ok,
    true,
  );
  for (const fileName of [
    "",
    "a".repeat(121),
    "../arrival.png",
    "a/b.png",
    "a\\b.png",
    " arrival.png",
    "arrival.png ",
    "a\0.png",
  ]) {
    assert.deepEqual(parseOcrImageUpload(createUpload(PNG_SIGNATURE, fileName)), {
      ok: false,
      code: "OCR_IMAGE_INVALID",
    });
  }
  for (const mimeType of [
    "",
    "image/gif",
    "image/svg+xml",
    "application/octet-stream",
  ]) {
    assert.deepEqual(
      parseOcrImageUpload({ ...createUpload(PNG_SIGNATURE), mimeType }),
      { ok: false, code: "OCR_IMAGE_INVALID" },
    );
  }
});
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

test("4MiB를 한 바이트라도 넘는 base64는 decode 전에 명확히 too-large로 끝납니다", () => {
  const parsed = parseOcrImageUpload(
    createUpload(createPngBytes(MAX_INLINE_OCR_IMAGE_BYTES + 1)),
  );

  assert.deepEqual(parsed, { ok: false, code: "OCR_IMAGE_TOO_LARGE" });
});

test("대형 위조 base64와 안전하지 않은 파일명은 RangeError 없이 invalid로 끝납니다", () => {
  const validLargeBase64 = createPngBytes(Math.floor(3.25 * 1024 * 1024)).toString(
    "base64",
  );
  const forgedBase64 = `${validLargeBase64.slice(0, 512)}?${validLargeBase64.slice(513)}`;
  let forgedResult: ReturnType<typeof parseOcrImageUpload> | undefined;

  assert.doesNotThrow(() => {
    forgedResult = parseOcrImageUpload({
      fileName: "arrival.png",
      mimeType: "image/png",
      imageBase64: forgedBase64,
    });
  });
  assert.deepEqual(forgedResult, { ok: false, code: "OCR_IMAGE_INVALID" });

  const unsafeFileNameResult = parseOcrImageUpload(
    createUpload(Buffer.from(PNG_SIGNATURE), "arrival@sheet.png"),
  );

  assert.deepEqual(unsafeFileNameResult, {
    ok: false,
    code: "OCR_IMAGE_INVALID",
  });
});

test("canonical result.ocrResults[0].prunedResult 배열에서 OCR 행을 읽습니다", () => {
  const recognition = parseRecognitionResponse(
    createCanonicalProviderEnvelope([
      {
        rec_texts: ["PARADAYS", "입고 수량 2"],
        rec_scores: [0.99, 0.8],
      },
    ]),
  );

  assert.deepEqual(recognition, {
    rawText: "PARADAYS\n입고 수량 2",
    rows: [
      { id: "ocr_1", sourceText: "PARADAYS", confidence: 0.99 },
      { id: "ocr_2", sourceText: "입고 수량 2", confidence: 0.8 },
    ],
    sourceRows: [
      { id: "ocr_1", sourceText: "PARADAYS", confidence: 0.99 },
      { id: "ocr_2", sourceText: "입고 수량 2", confidence: 0.8 },
    ],
  });
});

test("valid rec_boxes를 rec_polys보다 우선합니다", () => {
  const recognition = parseRecognitionResponse(
    createCanonicalProviderEnvelope({
      rec_texts: ["상품 코드"],
      rec_boxes: [
        [
          [10, 20],
          [30, 20],
          [30, 40],
          [10, 40],
        ],
      ],
      rec_polys: [
        [
          [100, 200],
          [300, 200],
          [300, 400],
          [100, 400],
        ],
      ],
    }),
  );

  assert.deepEqual(recognition.rows[0]?.box, [
    [10, 20],
    [30, 20],
    [30, 40],
    [10, 40],
  ]);
});

test("missing 또는 malformed rec_boxes는 같은 index의 rec_polys로 보완합니다", () => {
  const recognition = parseRecognitionResponse(
    createCanonicalProviderEnvelope({
      rec_texts: ["대체 좌표"],
      rec_boxes: [["not", "a", "box"]],
      rec_polys: [
        [
          [1, 2],
          [3, 2],
          [3, 4],
          [1, 4],
        ],
      ],
    }),
  );

  assert.deepEqual(recognition.rows[0]?.box, [
    [1, 2],
    [3, 2],
    [3, 4],
    [1, 4],
  ]);
});

test("malformed polygon은 해당 행의 box만 생략하고 텍스트 행은 보존합니다", () => {
  const recognition = parseRecognitionResponse(
    createCanonicalProviderEnvelope({
      rec_texts: ["정상 좌표 행", "좌표 오류 행"],
      rec_polys: [
        [
          [1, 2],
          [3, 2],
          [3, 4],
          [1, 4],
        ],
        [
          [5, 6],
          ["invalid", 8],
        ],
      ],
    }),
  );

  assert.deepEqual(recognition.rows, [
    {
      id: "ocr_1",
      sourceText: "정상 좌표 행",
      box: [
        [1, 2],
        [3, 2],
        [3, 4],
        [1, 4],
      ],
    },
    { id: "ocr_2", sourceText: "좌표 오류 행" },
  ]);
});
