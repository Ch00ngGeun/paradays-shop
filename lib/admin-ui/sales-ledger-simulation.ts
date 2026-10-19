/** Synthetic browser-memory teaching model. It has no production data adapters. */
export const TEST_SALES_PRODUCTS = [
  {
    id: "TEST_PRODUCT_DECK",
    name: "[테스트] 가상 데크",
    options: ["TEST_8_INCH", "TEST_825_INCH"],
    initialStock: 10,
    unitAmount: 10_000,
  },
  {
    id: "TEST_PRODUCT_GRIP",
    name: "[테스트] 가상 그립",
    options: ["TEST_BLACK", "TEST_CLEAR"],
    initialStock: 5,
    unitAmount: 5_000,
  },
] as const;
export type TestProductId = (typeof TEST_SALES_PRODUCTS)[number]["id"];
export type TestSaleLine = Readonly<{
  productId: TestProductId;
  option: string;
  quantity: number;
  unitAmount: number;
}>;
export type TestSaleInput = Readonly<{
  time: string;
  method: "CARD" | "CASH";
  reference: string;
  amount: number;
  lines: readonly TestSaleLine[];
}>;
export type TestSaleEntry = TestSaleInput &
  Readonly<{ id: string; version: number; status: "DRAFT" | "POSTED" }>;
export type TestSaleTotals = Readonly<{
  card: number;
  cash: number;
  offline: number;
  online: 0;
  combined: number;
}>;
export type TestCloseSnapshot = Readonly<{
  id: string;
  totals: TestSaleTotals;
  cashCompared: number;
  entryIds: readonly string[];
  stock: Readonly<Record<TestProductId, number>>;
}>;
export type TestSalesState = Readonly<{
  kind: "LOCAL_SALES_SIMULATION";
  sessionId: string;
  businessDay: "TEST_DAY_001";
  status: "OPEN" | "CLOSED";
  revision: number;
  stock: Readonly<Record<TestProductId, number>>;
  entries: readonly TestSaleEntry[];
  snapshots: readonly TestCloseSnapshot[];
  reopenReasons: readonly string[];
}>;
export type TestStockPreview = Readonly<{
  kind: "TEST_STOCK_PREVIEW";
  sessionId: string;
  entryId: string;
  fingerprint: string;
  rows: readonly Readonly<{
    productId: TestProductId;
    name: string;
    before: number;
    quantity: number;
    after: number;
  }>[];
}>;
export class TestSalesError extends Error {}
function reject(message: string): never {
  throw new TestSalesError(message);
}
const integer = (n: number, min: number, max = 100_000_000) =>
  Number.isSafeInteger(n) && n >= min && n <= max;
function checkState(state: TestSalesState) {
  if (
    state.kind !== "LOCAL_SALES_SIMULATION" ||
    !state.sessionId.startsWith("TEST_") ||
    state.businessDay !== "TEST_DAY_001"
  )
    reject("합성 TEST 장부만 체험할 수 있습니다.");
}
function requireOpen(state: TestSalesState) {
  checkState(state);
  if (state.status !== "OPEN")
    reject("모의 마감된 영업일입니다. 먼저 재개방해 주세요.");
}
export function createTestSales(id: string): TestSalesState {
  if (!/^[A-Za-z0-9_-]{1,48}$/.test(id)) reject("모의 세션 번호가 올바르지 않습니다.");
  return {
    kind: "LOCAL_SALES_SIMULATION",
    sessionId: `TEST_${id}`,
    businessDay: "TEST_DAY_001",
    status: "OPEN",
    revision: 0,
    stock: { TEST_PRODUCT_DECK: 10, TEST_PRODUCT_GRIP: 5 },
    entries: [],
    snapshots: [],
    reopenReasons: [],
  };
}
export const testLineTotal = (lines: readonly TestSaleLine[]) =>
  lines.reduce((sum, line) => sum + line.quantity * line.unitAmount, 0);
function validateInput(input: TestSaleInput): TestSaleInput {
  if (!/^(?:[01]\d|2[0-3]):[0-5]\d$/.test(input.time))
    reject("가상 판매시각은 00:00~23:59로 입력해 주세요.");
  if (input.method !== "CARD" && input.method !== "CASH")
    reject("모의 카드 또는 현금을 선택해 주세요.");
  const reference = input.reference.trim().toUpperCase();
  if (!/^TEST_[A-Z0-9_-]{1,40}$/.test(reference))
    reject("전표 참조번호는 TEST_로 시작하는 영문·숫자·하이픈만 입력해 주세요.");
  if (!integer(input.amount, 1)) reject("가상 전표 금액은 1~100,000,000원 정수입니다.");
  if (input.lines.length > 20) reject("모의 상품은 최대 20줄까지 입력할 수 있습니다.");
  for (const line of input.lines) {
    const product = TEST_SALES_PRODUCTS.find((p) => p.id === line.productId);
    if (!product || !(product.options as readonly string[]).includes(line.option))
      reject("목록의 합성 TEST 상품·옵션만 선택해 주세요.");
    if (!integer(line.quantity, 1, 10_000) || !integer(line.unitAmount, 0))
      reject("수량은 1~10,000개, 단가는 0~100,000,000원 정수입니다.");
  }
  if (!integer(testLineTotal(input.lines), 0))
    reject("상품 줄 합계 한도를 초과했습니다.");
  return { ...input, reference, lines: input.lines.map((line) => ({ ...line })) };
}
export function saveTestSale(
  state: TestSalesState,
  input: TestSaleInput,
  editing?: Readonly<{ id: string; version: number }>,
): TestSalesState {
  requireOpen(state);
  const value = validateInput(input);
  const previous = editing ? state.entries.find((e) => e.id === editing.id) : undefined;
  if (editing && (!previous || previous.version !== editing.version))
    reject("초안이 바뀌었습니다. 전표를 다시 선택해 주세요.");
  if (previous?.status === "POSTED") reject("확정 전표는 수정할 수 없습니다.");
  if (!previous && state.entries.length >= 30)
    reject("모의 전표 30건 한도입니다. 초기화 후 다시 체험해 주세요.");
  if (
    state.entries.some(
      (e) =>
        e.id !== previous?.id &&
        e.method === value.method &&
        e.reference === value.reference,
    )
  )
    reject("같은 결제수단의 TEST 참조번호가 이미 있습니다.");
  const entry: TestSaleEntry = {
    ...value,
    id:
      previous?.id ?? `TEST_SALE_${String(state.entries.length + 1).padStart(3, "0")}`,
    version: (previous?.version ?? 0) + 1,
    status: "DRAFT",
  };
  return {
    ...state,
    revision: state.revision + 1,
    entries: [...state.entries.filter((e) => e.id !== entry.id), entry].sort(
      (a, b) => a.time.localeCompare(b.time) || a.id.localeCompare(b.id),
    ),
  };
}
export function previewTestStock(
  state: TestSalesState,
  entryId: string,
): TestStockPreview {
  requireOpen(state);
  const entry = state.entries.find((e) => e.id === entryId);
  if (!entry || entry.status !== "DRAFT") reject("저장된 모의 초안을 선택해 주세요.");
  validateInput(entry);
  if (!entry.lines.length || testLineTotal(entry.lines) !== entry.amount)
    reject("상품을 연결하고 줄 합계를 가상 전표 금액과 맞춰 주세요.");
  const rows = TEST_SALES_PRODUCTS.flatMap((product) => {
    const quantity = entry.lines
      .filter((line) => line.productId === product.id)
      .reduce((sum, line) => sum + line.quantity, 0);
    if (!quantity) return [];
    const before = state.stock[product.id];
    if (!integer(before, quantity, product.initialStock))
      reject(`${product.name}의 가상 재고가 부족합니다.`);
    return [
      {
        productId: product.id,
        name: product.name,
        before,
        quantity,
        after: before - quantity,
      },
    ];
  });
  return {
    kind: "TEST_STOCK_PREVIEW",
    sessionId: state.sessionId,
    entryId,
    fingerprint: JSON.stringify([state.revision, entry, rows]),
    rows,
  };
}
export function postTestSale(
  state: TestSalesState,
  preview: TestStockPreview,
  confirmed: boolean,
): TestSalesState {
  checkState(state);
  if (
    preview.kind !== "TEST_STOCK_PREVIEW" ||
    preview.sessionId !== state.sessionId ||
    confirmed !== true
  )
    reject("가상 재고 예정표의 명시적 확인이 필요합니다.");
  const entry = state.entries.find((e) => e.id === preview.entryId);
  if (entry?.status === "POSTED") return state;
  const current = previewTestStock(state, preview.entryId);
  if (
    current.fingerprint !== preview.fingerprint ||
    JSON.stringify(current.rows) !== JSON.stringify(preview.rows)
  )
    reject("초안 또는 가상 재고가 바뀌었습니다. 예정표를 다시 확인해 주세요.");
  const stock = { ...state.stock };
  for (const row of current.rows) stock[row.productId] = row.after;
  return {
    ...state,
    revision: state.revision + 1,
    stock,
    entries: state.entries.map((e) =>
      e.id === preview.entryId ? { ...e, version: e.version + 1, status: "POSTED" } : e,
    ),
  };
}
export function testSalesTotals(state: TestSalesState): TestSaleTotals {
  checkState(state);
  const total = (method: "CARD" | "CASH") =>
    state.entries
      .filter((e) => e.status === "POSTED" && e.method === method)
      .reduce((sum, e) => sum + e.amount, 0);
  const card = total("CARD"),
    cash = total("CASH");
  return { card, cash, offline: card + cash, online: 0, combined: card + cash };
}
export function closeTestSales(
  state: TestSalesState,
  cashCompared: number,
  confirmed: boolean,
): TestSalesState {
  checkState(state);
  if (confirmed !== true) reject("모의 마감 확인란을 선택해 주세요.");
  const totals = testSalesTotals(state);
  if (!integer(cashCompared, 0) || cashCompared !== totals.cash)
    reject("현금 수기 대조액을 가상 현금 매출과 맞춰 주세요.");
  if (state.status === "CLOSED") return state;
  if (state.entries.some((e) => e.status === "DRAFT"))
    reject("확정하지 않은 모의 초안이 남아 있어 마감할 수 없습니다.");
  if (state.snapshots.length >= 30)
    reject("모의 마감본 30건 한도입니다. 초기화해 주세요.");
  return {
    ...state,
    status: "CLOSED",
    revision: state.revision + 1,
    snapshots: [
      ...state.snapshots,
      {
        id: `TEST_CLOSE_${state.snapshots.length + 1}`,
        totals,
        cashCompared,
        entryIds: state.entries.map((e) => e.id),
        stock: { ...state.stock },
      },
    ],
  };
}
export function reopenTestSales(state: TestSalesState, reason: string): TestSalesState {
  checkState(state);
  if (state.status !== "CLOSED") reject("모의 마감된 영업일만 재개방할 수 있습니다.");
  if (!/^TEST_[A-Za-z0-9 _-]{1,80}$/.test(reason.trim()))
    reject("재개방 사유는 TEST_로 시작하는 가상 사유로 입력해 주세요.");
  return {
    ...state,
    status: "OPEN",
    revision: state.revision + 1,
    reopenReasons: [...state.reopenReasons, reason.trim()],
  };
}
