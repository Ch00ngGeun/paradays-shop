// 역할: 관리자 영어 화면 검사에 쓰는 합성 날짜·주문·카탈로그·회원·매출 보고서·OCR 토큰·PNG 데이터를 제공함.
import { deflateSync } from "node:zlib";
import { type OcrTableToken } from "../infra/lambda/ocr-table-parser.js";
import {
  calculateTotals,
  type DayReport,
  type SaleEntry,
} from "../infra/lambda/sales-ledger-domain";

const DAY = "2026-10-15";

const CLOSED_DAY = "2026-10-14";

const AS_OF = `${DAY}T14:00:00.000Z`;

const catalog = [
  {
    productId: "prd_english_deck",
    slug: "english-synthetic-deck",
    name: "[TEST] English deck",
    brandId: "brand_test",
    brandName: "TEST",
    category: "Deck",
    price: 107_000,
    currency: "KRW",
    status: "PUBLISHED",
    inventoryQuantity: 2,
    featured: false,
    image: "/images/product-placeholder.svg",
    images: ["/images/product-placeholder.svg"],
    description: ["Synthetic English fixture"],
    sizes: ["8.5"],
    sku: "TEST-EN-DECK",
    version: 3,
    createdAt: "2026-10-01T00:00:00Z",
    updatedAt: "2026-10-01T00:00:00Z",
  },
];

const members = [
  {
    username: "member+alex@example.test",
    userSub: "member-synthetic-alex",
    email: "alex@example.test",
    displayName: "[TEST] Alex",
    enabled: true,
    groups: [],
  },
];

const order = {
  orderId: "pd_order_001",
  status: "PAID",
  paymentStatus: "DONE",
  total: 200,
  createdAt: `${DAY}T00:00:00Z`,
  lines: [
    {
      line: 0,
      productId: "prd_deck",
      name: "Deck",
      selectedSize: "8",
      quantity: 2,
      unitPrice: 100,
      lineTotal: 200,
      canceledQuantity: 0,
      restoredQuantity: 0,
    },
  ],
  inventory: {
    state: "DEBITED",
    fulfillment: "SHIPPED",
    expiresAt: `${DAY}T00:30:00Z`,
    refundedAmount: 0,
    pendingRefund: null,
    lastFailure: { operationId: "admin_old", code: "SYNTHETIC_REJECTED" },
  },
};

function sale(overrides: Partial<SaleEntry> = {}): SaleEntry {
  return {
    entryId: "sale_english_001",
    businessDay: DAY,
    recordType: "SALE",
    version: 1,
    status: "POSTED",
    kind: "SALE",
    soldAt: `${DAY}T00:30:00.000Z`,
    method: "CARD",
    reference: "CARD-001",
    amount: 10_000,
    memo: "Synthetic English ledger",
    lines: [
      {
        productId: "prd_deck",
        name: "Deck",
        option: "8.25",
        quantity: 1,
        unitAmount: 10_000,
      },
    ],
    createdAt: AS_OF,
    updatedAt: AS_OF,
    ...overrides,
  };
}

const entries = (day: string) => [
  sale({ businessDay: day, soldAt: `${day}T00:30:00.000Z` }),
  sale({
    entryId: "sale_english_002",
    businessDay: day,
    soldAt: `${day}T00:40:00.000Z`,
    status: "DRAFT",
    method: "CASH",
    reference: "CASH-001",
    amount: 5_000,
    lines: [
      { productId: null, name: "", option: "", quantity: 1, unitAmount: 4_000 },
    ] as unknown as SaleEntry["lines"],
  }),
  sale({
    entryId: "sale_english_003",
    businessDay: day,
    soldAt: `${day}T00:50:00.000Z`,
    kind: "REVERSAL",
    method: "TRANSFER",
    reference: "REV-TRANSFER-001",
    original: { businessDay: day, entryId: "sale_english_001" },
    restocked: false,
  }),
];

const onlineEvents = (day: string) => [
  {
    orderId: "pd_online_001",
    kind: "APPROVAL" as const,
    amount: 30_000,
    occurredAt: `${day}T02:00:00.000Z`,
    timeBasis: "OBSERVED" as const,
  },
  {
    orderId: "pd_online_002",
    kind: "REFUND" as const,
    amount: 5_000,
    occurredAt: `${day}T03:00:00.000Z`,
    timeBasis: "PROVIDER" as const,
  },
];

function dayReport(day: string): DayReport {
  const closed = day === CLOSED_DAY;
  const dayEntries = entries(day);
  const events = onlineEvents(day);
  const totals = calculateTotals(dayEntries, events);
  return {
    businessDay: day,
    timezone: "Asia/Seoul",
    version: 4,
    status: closed ? "CLOSED" : "OPEN",
    asOf: AS_OF,
    entries: dayEntries,
    onlineEvents: events,
    totals,
    warnings: closed ? [] : ["UNPOSTED_SALES", "ONLINE_PAYMENT_RESULT_PENDING"],
    onlineFingerprint: "a".repeat(64),
    snapshots: closed
      ? [
          {
            snapshotId: "close_english_001",
            closedAt: AS_OF,
            version: 3,
            totals,
            onlineFingerprint: "a".repeat(64),
            cashComparedAmount: totals.cash,
            entryManifest: "c".repeat(64),
            entryCount: 3,
            onlineEvents: events,
          },
        ]
      : [],
    history: closed
      ? [
          { action: "CLOSE", reason: "매출 대조 확인", at: AS_OF },
          { action: "REOPEN", reason: "현금 재확인", at: AS_OF },
          { action: "CLOSE", reason: "매출 대조 확인", at: AS_OF },
        ]
      : [],
    complete: true,
  } as DayReport;
}

// OCR 원문 토큰은 ASCII 합성값만 사용함. 영역 지정 결과는 실제 파서로 계산함.
function token(
  id: string,
  sourceText: string,
  left: number,
  top: number,
  width: number,
) {
  return {
    id,
    sourceText,
    confidence: 0.94,
    box: [
      [left, top],
      [left + width, top],
      [left + width, top + 30],
      [left, top + 30],
    ] as [number, number][],
  };
}

const ocrTokens: OcrTableToken[] = [
  token("title", "Synthetic intake", 100, 70, 260),
  token("name1", "Synthetic deck", 100, 200, 250),
  token("brand1", "Test Maker", 500, 200, 120),
  token("option1", "Black", 800, 200, 120),
  token("qty1", "2", 1300, 200, 30),
  token("price1", "120000", 1100, 200, 100),
  token("name2", "Synthetic wheels", 100, 320, 280),
  token("brand2", "Test Maker", 500, 320, 120),
  token("option2", "White", 800, 320, 120),
  token("qty2", "3", 1300, 320, 30),
  token("price2", "150000", 1100, 320, 100),
  token("footer", "Total", 100, 420, 80),
  token("footerqty", "5", 1300, 420, 30),
];

const initialOcrJob = () => ({
  jobId: "ocr_english",
  version: 1,
  rawText: ocrTokens.map((row) => row.sourceText).join("\n"),
  rows: ocrTokens.map((row) => ({
    ...row,
    productName: "",
    brand: "",
    option: "",
    quantity: "",
  })) as Record<string, unknown>[],
  analysis: { mode: "unclassified", reason: "header-not-found" } as Record<
    string,
    unknown
  >,
});

/** 관리자 카탈로그 한 행을 상점 공개 응답 형식으로 바꿈. */
function publicShape(item: Record<string, unknown>) {
  const { productId, brandName, ...rest } = item;
  return { ...rest, id: productId, brand: brandName };
}

/** 1600×820 흰 PNG. 영역 드래그 좌표가 실제 이미지 크기로 정규화되도록 크기만 맞춤. */
function blankPng(width = 1600, height = 820) {
  const crc = (bytes: Buffer) => {
    let c = 0xffffffff;
    for (const byte of bytes) {
      c ^= byte;
      for (let bit = 0; bit < 8; bit++) c = (c >>> 1) ^ (c & 1 ? 0xedb88320 : 0);
    }
    return (c ^ 0xffffffff) >>> 0;
  };
  const chunk = (name: string, data: Buffer) => {
    const type = Buffer.from(name);
    const size = Buffer.alloc(4);
    const checksum = Buffer.alloc(4);
    size.writeUInt32BE(data.length);
    checksum.writeUInt32BE(crc(Buffer.concat([type, data])));
    return Buffer.concat([size, type, data, checksum]);
  };
  const pixels = Buffer.alloc((width * 3 + 1) * height, 255);
  for (let y = 0; y < height; y++) pixels[y * (width * 3 + 1)] = 0;
  const header = Buffer.alloc(13);
  header.writeUInt32BE(width, 0);
  header.writeUInt32BE(height, 4);
  header[8] = 8;
  header[9] = 2;
  return Buffer.concat([
    Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
    chunk("IHDR", header),
    chunk("IDAT", deflateSync(pixels)),
    chunk("IEND", Buffer.alloc(0)),
  ]);
}

const PNG = blankPng();

export {
  DAY,
  CLOSED_DAY,
  order,
  PNG,
  catalog,
  AS_OF,
  members,
  dayReport,
  ocrTokens,
  initialOcrJob,
  publicShape,
};
