/** JavaScript 런타임 파서의 TypeScript 호출 계약임. */
export type OcrTableToken = Readonly<{
  id: string;
  sourceText: string;
  confidence?: number;
  box?: readonly (readonly [number, number])[];
}>;

export type OcrTableReviewRow = OcrTableToken &
  Readonly<{
    productName: string;
    brand: string;
    option: string;
    quantity: string;
  }>;

export type OcrColumnMapping = Readonly<{
  schemaVersion: 1;
  headerRow: number;
  columns: Readonly<{
    productName: number;
    brand: number | null;
    option: number | null;
    quantity: number | null;
  }>;
  productInfo?: Readonly<{
    productNameLine: number | null;
    brandLine: number | null;
    optionLine: number | null;
  }>;
}>;
export type OcrRegionRect = Readonly<{
  left: number;
  top: number;
  right: number;
  bottom: number;
}>;
export type OcrRegionMapping = Readonly<{
  schemaVersion: 2;
  parserVersion: 1;
  kind: "regions";
  image: Readonly<{ width: number; height: number }>;
  firstRow: Readonly<{
    productName: OcrRegionRect;
    brand: OcrRegionRect | null;
    option: OcrRegionRect | null;
    quantity: OcrRegionRect | null;
  }>;
  tableBottom: number;
  secondRowY: number | null;
  quantityConfirmed: boolean;
}>;
export type OcrMapping = OcrColumnMapping | OcrRegionMapping;
export type OcrRegionAnalysis = Readonly<{
  sourceTokenCount: number;
  includedTokenCount: number;
  excludedTokenCount: number;
  warnings: readonly string[];
}>;
export type OcrTableDescriptor = Readonly<{
  headerRow: number;
  columns: readonly Readonly<{ index: number; label: string; role: string }>[];
}>;
export type OcrTableAnalysis = Readonly<{
  mode: "table" | "empty" | "unclassified";
  reason?: string;
  table?: OcrTableDescriptor;
  mapping?: OcrMapping;
  region?: OcrRegionAnalysis;
}>;

export type OcrTableParseResult =
  | Readonly<{
      mode: "table";
      rows: readonly OcrTableReviewRow[];
      table?: OcrTableDescriptor;
      mapping: OcrMapping;
      region?: OcrRegionAnalysis;
    }>
  | Readonly<{
      mode: "empty" | "unclassified";
      reason: string;
      rows: readonly OcrTableToken[];
      table?: OcrTableDescriptor;
      region?: OcrRegionAnalysis;
    }>;

export function isOcrColumnMapping(value: unknown): value is OcrColumnMapping;
export function isOcrRegionMapping(value: unknown): value is OcrRegionMapping;
export function isOcrMapping(value: unknown): value is OcrMapping;
export function parseOcrTableRows(
  rows: readonly OcrTableToken[],
  mapping?: OcrMapping,
): OcrTableParseResult;
