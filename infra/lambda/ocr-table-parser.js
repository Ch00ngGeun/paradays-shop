/** 인식 좌표와 명확한 표 헤더로 상품 행을 묶는 공유 ESM JavaScript 파서임. */
const HEADERS = {
  productName: [
    "상품명",
    "품명",
    "제품명",
    "product",
    "productname",
    "item",
    "itemname",
    "품목명",
    "주문상품명",
  ],
  brand: ["브랜드", "제조사", "brand"],
  option: [
    "옵션",
    "규격",
    "사이즈",
    "option",
    "options",
    "size",
    "spec",
    "specification",
  ],
  quantity: ["수량", "입고수량", "수량개", "qty", "quantity", "qtypcs", "quantitypcs"],
  productInfo: [
    "상품정보",
    "제품정보",
    "품목정보",
    "주문상품",
    "productinfo",
    "productinformation",
    "itemdetails",
  ],
  price: [
    "가격",
    "단가",
    "판매가",
    "금액",
    "상품금액",
    "주문금액",
    "결제금액",
    "합계",
    "price",
    "amount",
    "total",
    "unitprice",
  ],
  ignore: [
    "이미지",
    "상품이미지",
    "사진",
    "상태",
    "주문상태",
    "배송상태",
    "결제상태",
    "선택",
    "번호",
    "주문번호",
    "image",
    "photo",
    "status",
    "orderid",
    "no",
  ],
};

const FIELDS = ["productName", "brand", "option", "quantity"];
const exactKeys = (value, keys) => {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return (
    (prototype === Object.prototype || prototype === null) &&
    Reflect.ownKeys(value).length === keys.length &&
    keys.every((key) => {
      const descriptor = Object.getOwnPropertyDescriptor(value, key);
      return descriptor && "value" in descriptor;
    })
  );
};
const index = (value, max) => Number.isInteger(value) && value >= 0 && value <= max;

/** 저장 설정에는 열/줄 번호만 허용함. 원문이나 임의 속성은 받아들이지 않음. */
export function isOcrColumnMapping(value) {
  if (
    !exactKeys(
      value,
      Object.hasOwn(value ?? {}, "productInfo")
        ? ["schemaVersion", "headerRow", "columns", "productInfo"]
        : ["schemaVersion", "headerRow", "columns"],
    )
  )
    return false;
  if (
    value.schemaVersion !== 1 ||
    !index(value.headerRow, 499) ||
    !exactKeys(value.columns, FIELDS) ||
    !index(value.columns.productName, 19)
  )
    return false;
  const assigned = [];
  for (const field of FIELDS) {
    const column = value.columns[field];
    if (column === null && field !== "productName") continue;
    if (!index(column, 19) || assigned.includes(column)) return false;
    assigned.push(column);
  }
  if (Object.hasOwn(value, "productInfo")) {
    if (!exactKeys(value.productInfo, ["productNameLine", "brandLine", "optionLine"]))
      return false;
    const lines = Object.values(value.productInfo).filter((line) => line !== null);
    if (lines.some((line) => !index(line, 19)) || new Set(lines).size !== lines.length)
      return false;
    if (
      (value.productInfo.brandLine !== null && value.columns.brand !== null) ||
      (value.productInfo.optionLine !== null && value.columns.option !== null)
    )
      return false;
  }
  return true;
}

const unit = (value) => Number.isFinite(value) && value >= 0 && value <= 1;
const overlaps = (a, b) =>
  Math.min(a.right, b.right) > Math.max(a.left, b.left) &&
  Math.min(a.bottom, b.bottom) > Math.max(a.top, b.top);

/** 좌표 설정만 허용하며 이미지·원문·파일명·임의 속성은 포함하지 않음. */
export function isOcrRegionMapping(value) {
  if (
    !exactKeys(value, [
      "schemaVersion",
      "parserVersion",
      "kind",
      "image",
      "firstRow",
      "tableBottom",
      "secondRowY",
      "quantityConfirmed",
    ]) ||
    value.schemaVersion !== 2 ||
    value.parserVersion !== 1 ||
    value.kind !== "regions" ||
    !exactKeys(value.image, ["width", "height"]) ||
    !exactKeys(value.firstRow, FIELDS)
  )
    return false;
  const { width, height } = value.image;
  if (
    !Number.isInteger(width) ||
    !Number.isInteger(height) ||
    width < 1 ||
    height < 1 ||
    width > 16384 ||
    height > 16384 ||
    width * height > 40000000 ||
    !unit(value.tableBottom) ||
    typeof value.quantityConfirmed !== "boolean"
  )
    return false;
  const rects = [];
  for (const field of FIELDS) {
    const rect = value.firstRow[field];
    if (rect === null && field !== "productName") continue;
    if (
      !exactKeys(rect, ["left", "top", "right", "bottom"]) ||
      !Object.values(rect).every(unit) ||
      rect.right - rect.left + 1e-10 < 0.003 ||
      rect.bottom - rect.top + 1e-10 < 0.003 ||
      (rect.right - rect.left) * width + 1e-8 < 4 ||
      (rect.bottom - rect.top) * height + 1e-8 < 4 ||
      rect.bottom > value.tableBottom ||
      rects.some((previous) => overlaps(previous, rect))
    )
      return false;
    rects.push(rect);
  }
  const top = Math.min(...rects.map((rect) => rect.top)),
    bottom = Math.max(...rects.map((rect) => rect.bottom));
  if (
    value.secondRowY !== null &&
    (!unit(value.secondRowY) ||
      value.secondRowY > value.tableBottom ||
      value.secondRowY -
        (value.firstRow.productName.top + value.firstRow.productName.bottom) / 2 <
        bottom - top)
  )
    return false;
  return value.firstRow.quantity === null || value.quantityConfirmed;
}

export function isOcrMapping(value) {
  return isOcrColumnMapping(value) || isOcrRegionMapping(value);
}

const normalizeHeader = (value) =>
  value
    .normalize("NFKC")
    .toLowerCase()
    .replace(/[\s()[\]{}:：._/-]/gu, "");

function headerField(value) {
  const normalized = normalizeHeader(value);
  return Object.keys(HEADERS).find((field) => HEADERS[field].includes(normalized));
}

function geometry(row) {
  if (!Array.isArray(row.box) || row.box.length < 2) return null;
  if (
    row.box.some(
      (point) =>
        !Array.isArray(point) ||
        point.length !== 2 ||
        point.some((value) => !Number.isFinite(value)),
    )
  )
    return null;
  const xs = row.box.map((point) => point[0]);
  const ys = row.box.map((point) => point[1]);
  const left = Math.min(...xs);
  const right = Math.max(...xs);
  const top = Math.min(...ys);
  const bottom = Math.max(...ys);
  if (right <= left || bottom <= top) return null;
  return { row, left, right, top, bottom, y: (top + bottom) / 2, height: bottom - top };
}

function median(values) {
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.floor(sorted.length / 2)];
}

function visualOrder(a, b) {
  return a.y - b.y || a.left - b.left || a.row.id.localeCompare(b.row.id);
}

/** 화면 크기가 달라도 글자 높이와 중심 거리로 같은 문자 줄을 찾음. */
function visualLines(tokens) {
  const lines = [];
  for (const token of [...tokens].sort(visualOrder)) {
    const previous = lines[lines.length - 1];
    if (
      previous &&
      Math.abs(token.y - previous.y) <=
        Math.min(token.height, median(previous.tokens.map((item) => item.height))) * 0.5
    ) {
      previous.tokens.push(token);
      previous.y = median(previous.tokens.map((item) => item.y));
    } else {
      lines.push({ y: token.y, tokens: [token] });
    }
  }
  return lines;
}

function headerTokens(line) {
  const tokens = [...line.tokens].sort((a, b) => a.left - b.left);
  const result = [];
  for (let i = 0; i < tokens.length; i += 1) {
    let token = tokens[i];
    // 같은 줄에서 분리된 헤더 단어만 합침. 본문 값에는 적용하지 않음.
    if (
      tokens[i + 1] &&
      (!headerField(token.row.sourceText) ||
        !headerField(tokens[i + 1].row.sourceText)) &&
      tokens[i + 1].left - token.right <= token.height * 1.5 &&
      headerField(token.row.sourceText + tokens[i + 1].row.sourceText)
    ) {
      const next = tokens[++i];
      token = {
        ...token,
        right: next.right,
        row: {
          ...token.row,
          sourceText: token.row.sourceText + " " + next.row.sourceText,
        },
      };
    }
    result.push(token);
  }
  return result;
}

function compoundFields(cells, config) {
  const lines = visualLines(cells).map((line) =>
    [...line.tokens]
      .sort((a, b) => a.left - b.left)
      .map((cell) => cell.row.sourceText.trim())
      .join(" "),
  );
  const fields = { productName: "", brand: "", option: "", quantity: "" };
  const unlabelled = [];
  let active;
  for (const text of lines) {
    // 한 줄의 복수 라벨·가격/상태 라벨을 상품명에 붙이지 않음.
    if ((text.match(/[:：]/gu) ?? []).length > 1) return null;
    const label = text.match(/^([^:：]+)[:：]\s*(.*)$/u);
    const field = label && headerField(label[1]);
    if (label && !FIELDS.includes(field)) return null;
    if (FIELDS.includes(field)) {
      if (fields[field]) return null;
      fields[field] = label[2];
      active = field;
    } else if (active && active !== "quantity") {
      fields[active] += " " + text;
    } else {
      unlabelled.push(text);
      active = undefined;
    }
  }
  for (const field of ["productName", "brand", "option"]) {
    const selected = config?.[field + "Line"];
    if (selected === undefined || selected === null) continue;
    if (selected >= lines.length) return null;
    const text = lines[selected];
    const label = text.match(/^([^:：]+)[:：]\s*(.*)$/u);
    if (label && headerField(label[1]) && headerField(label[1]) !== field) return null;
    fields[field] = label ? label[2] : text;
  }
  if (!fields.productName) {
    if (unlabelled.length !== 1) return null;
    fields.productName = unlabelled[0];
  }
  return fields;
}

function parseRegions(rows, mapping) {
  let included = 0;
  const report = (warnings) => ({
    sourceTokenCount: rows.length,
    includedTokenCount: included,
    excludedTokenCount: rows.length - included,
    warnings,
  });
  const fallback = (reason) => ({
    mode: rows.length ? "unclassified" : "empty",
    reason,
    rows,
    region: report([reason]),
  });
  if (!rows.length) return fallback("empty");
  if (rows.length > 500 || new Set(rows.map((row) => row.id)).size !== rows.length)
    return fallback("row-limit");
  const geometries = rows.map(geometry);
  if (geometries.some((token) => !token)) return fallback("missing-geometry");
  const tokens = geometries.map((token) => ({
    ...token,
    left: token.left / mapping.image.width,
    right: token.right / mapping.image.width,
    top: token.top / mapping.image.height,
    bottom: token.bottom / mapping.image.height,
    y: token.y / mapping.image.height,
    height: token.height / mapping.image.height,
  }));
  if (
    tokens.some(
      (token) => token.left < 0 || token.top < 0 || token.right > 1 || token.bottom > 1,
    )
  )
    return fallback("region-image-mismatch");
  const rects = Object.values(mapping.firstRow).filter(Boolean);
  const rowTop = Math.min(...rects.map((rect) => rect.top)),
    rowBottom = Math.max(...rects.map((rect) => rect.bottom));
  const rowHeight = rowBottom - rowTop,
    center =
      (mapping.firstRow.productName.top + mapping.firstRow.productName.bottom) / 2;
  const qty = mapping.firstRow.quantity;
  const inRect = (token, rect) => {
    const x = (token.left + token.right) / 2;
    return (
      x >= rect.left && x < rect.right && token.y >= rect.top && token.y < rect.bottom
    );
  };
  const fit = (token, rect) => {
    const intersection =
      Math.max(0, Math.min(token.right, rect.right) - Math.max(token.left, rect.left)) *
      Math.max(0, Math.min(token.bottom, rect.bottom) - Math.max(token.top, rect.top));
    return (
      intersection / ((token.right - token.left) * (token.bottom - token.top)) >= 0.8
    );
  };
  if (qty) {
    const above = tokens
      .filter(
        (token) =>
          token.bottom <= rowTop &&
          (token.left + token.right) / 2 >= qty.left &&
          (token.left + token.right) / 2 < qty.right,
      )
      .sort((a, b) => b.bottom - a.bottom);
    // 통화/단위 안내가 실제 헤더를 가리지 않도록 의미가 확인된 헤더끼리 비교함.
    const evidence = above
      .map((token) => ({ ...token, role: headerField(token.row.sourceText) }))
      .filter((token) => ["quantity", "price", "ignore"].includes(token.role));
    const nearestHeader = evidence[0];
    if (
      nearestHeader &&
      (nearestHeader.role !== "quantity" ||
        evidence.some(
          (token) =>
            token.role !== "quantity" &&
            Math.min(token.bottom, nearestHeader.bottom) >
              Math.max(token.top, nearestHeader.top),
        ))
    )
      return fallback("quantity-column-conflict");
    const first = tokens.filter((token) => inRect(token, qty));
    if (
      first.length !== 1 ||
      !/^[0-9]{1,9}$/.test(first[0].row.sourceText.trim()) ||
      !fit(first[0], qty)
    )
      return fallback("region-quantity-invalid");
  }
  const offsets = [0];
  if (mapping.secondRowY !== null && !qty) {
    const stride = mapping.secondRowY - center;
    for (let step = 1; step <= 500; step++) {
      const offset = step * stride;
      if (rowBottom + offset > mapping.tableBottom + 0.000001) break;
      offsets.push(offset);
    }
    // 정해진 간격과 맞지 않는 수량은 상품이 누락될 수 있으므로 전체 미분류로 남김.
    if (
      qty &&
      tokens.some(
        (token) =>
          token.y >= rowTop &&
          token.y < mapping.tableBottom &&
          (token.left + token.right) / 2 >= qty.left &&
          (token.left + token.right) / 2 < qty.right &&
          !offsets.some((offset) =>
            inRect(token, {
              ...qty,
              top: qty.top + offset,
              bottom: qty.bottom + offset,
            }),
          ),
      )
    )
      return fallback("region-row-spacing-uncertain");
  } else if (qty) {
    const first = tokens.find((token) => inRect(token, qty));
    const candidates = tokens
      .filter(
        (token) =>
          token.y >= qty.top &&
          token.y < mapping.tableBottom &&
          (token.left + token.right) / 2 >= qty.left &&
          (token.left + token.right) / 2 < qty.right,
      )
      .sort(visualOrder);
    for (const token of candidates) {
      if (!/^[0-9]{1,9}$/.test(token.row.sourceText.trim()))
        return fallback("region-quantity-invalid");
      const offset = token.y - first.y;
      if (offset < rowHeight * 0.5) {
        if (token !== first) return fallback("region-row-spacing-uncertain");
        continue;
      }
      if (
        rowBottom + offset > mapping.tableBottom + 0.000001 ||
        offsets.some((previous) => Math.abs(previous - offset) < rowHeight)
      )
        return fallback("region-row-spacing-uncertain");
      offsets.push(offset);
    }
  } else if (mapping.tableBottom > rowBottom + 0.005)
    return fallback("region-second-row-required");
  if (
    qty &&
    mapping.secondRowY !== null &&
    (offsets.length < 2 ||
      Math.abs(mapping.secondRowY - center - offsets[1]) > rowHeight / 2)
  )
    return fallback("region-row-spacing-uncertain");
  const result = [];
  const used = new Set();
  for (const offset of offsets) {
    const fields = {};
    const selected = [];
    for (const field of FIELDS) {
      const base = mapping.firstRow[field];
      if (!base) {
        fields[field] = "";
        continue;
      }
      const rect = { ...base, top: base.top + offset, bottom: base.bottom + offset };
      if (
        tokens.some(
          (token) =>
            overlaps(token, rect) && (!inRect(token, rect) || !fit(token, rect)),
        )
      )
        return fallback("region-boundary-uncertain");
      const cells = tokens.filter((token) => inRect(token, rect)).sort(visualOrder);
      if (cells.some((token) => !fit(token, rect) || used.has(token.row.id)))
        return fallback("region-boundary-uncertain");
      fields[field] = visualLines(cells)
        .map((line) =>
          [...line.tokens]
            .sort((a, b) => a.left - b.left)
            .map((token) => token.row.sourceText.trim().replace(/\s+/gu, " "))
            .join(" "),
        )
        .join(" ");
      selected.push(...cells);
    }
    if (!fields.productName) return fallback("region-row-spacing-uncertain");
    if (
      /^(합계|총합계|총금액|total|grand\s*total|배송완료|주문완료|로그인|마이페이지)$/iu.test(
        fields.productName,
      )
    )
      return fallback("region-footer-uncertain");
    if (qty && !/^[0-9]{1,9}$/.test(fields.quantity))
      return fallback("region-quantity-invalid");
    selected.forEach((token) => used.add(token.row.id));
    const canonical = tokens
      .filter((token) => token.y >= rowTop + offset && token.y < rowBottom + offset)
      .sort(visualOrder);
    const anchor = canonical[0]?.row;
    const sourceText = [...selected]
      .sort(visualOrder)
      .map((token) => token.row.sourceText)
      .join(" | ");
    if (
      !anchor ||
      fields.productName.length > 240 ||
      fields.brand.length > 100 ||
      fields.option.length > 200 ||
      sourceText.length > 1000
    )
      return fallback("field-limit");
    result.push({ ...anchor, sourceText, ...fields });
  }
  // 지정한 항목 열의 미포함 글자는 긴 상품명/불규칙 간격일 수 있음. 성공으로 숨기지 않음.
  const missed = tokens.filter(
    (token) =>
      token.y >= rowTop &&
      token.y < mapping.tableBottom &&
      !used.has(token.row.id) &&
      rects.some(
        (rect) => Math.min(token.right, rect.right) > Math.max(token.left, rect.left),
      ),
  );
  if (missed.length) return fallback("region-boundary-uncertain");
  // 지정하지 않은 열/표 밖 글자는 삭제하지 않고 원본에 남기고 제외 수를 표시함.
  included = used.size;
  const outside = tokens.filter(
    (token) =>
      token.y >= rowTop && token.y < mapping.tableBottom && !used.has(token.row.id),
  );
  return {
    mode: "table",
    rows: result,
    mapping,
    region: report(outside.length ? ["region-excluded-tokens"] : []),
  };
}

/** 불확실한 입력은 원문 행과 이유를 그대로 반환함. 명시적 지정도 서버 원본으로 재계산함. */
export function parseOcrTableRows(rows, mapping) {
  if (mapping?.schemaVersion === 2)
    return isOcrRegionMapping(mapping)
      ? parseRegions(rows, mapping)
      : {
          mode: rows.length ? "unclassified" : "empty",
          reason: "invalid-mapping",
          rows,
        };
  let table;
  const fallback = (reason) => ({
    mode: rows.length === 0 ? "empty" : "unclassified",
    reason,
    rows,
    ...(table ? { table } : {}),
  });
  if (rows.length === 0) return fallback("empty");
  if (rows.length > 500) return fallback("row-limit");
  if (mapping !== undefined && !isOcrColumnMapping(mapping))
    return fallback("invalid-mapping");
  if (new Set(rows.map((row) => row.id)).size !== rows.length)
    return fallback("duplicate-id");
  const tokens = rows.map(geometry);
  if (tokens.some((token) => !token)) return fallback("missing-geometry");
  const lines = visualLines(tokens);
  const candidates = lines.filter((line) => {
    const roles = headerTokens(line).map((token) => headerField(token.row.sourceText));
    return (
      roles.some((role) => role === "productName" || role === "productInfo") &&
      roles.length >= 2
    );
  });
  const headerLine = mapping ? lines[mapping.headerRow] : candidates[0];
  if (!headerLine) return fallback("header-not-found");
  const headers = headerTokens(headerLine);
  if (headers.length < 2 || headers.length > 20) return fallback("ambiguous-header");
  table = {
    headerRow: lines.indexOf(headerLine),
    columns: headers.map((header, column) => ({
      index: column,
      label: header.row.sourceText,
      role: headerField(header.row.sourceText) ?? "unknown",
    })),
  };
  if (!mapping && candidates.length !== 1) return fallback("ambiguous-header");
  if (headers.some((header, index) => index && header.left <= headers[index - 1].right))
    return fallback("ambiguous-header");
  const roles = table.columns.map((column) => column.role);
  if (mapping && roles.every((role) => role === "unknown"))
    return fallback("header-not-confirmed");
  if (!mapping) {
    if (
      roles.includes("unknown") ||
      FIELDS.some((field) => roles.filter((role) => role === field).length > 1) ||
      roles.filter((role) => role === "productName" || role === "productInfo")
        .length !== 1
    )
      return fallback("ambiguous-header");
    mapping = {
      schemaVersion: 1,
      headerRow: table.headerRow,
      columns: Object.fromEntries(
        FIELDS.map((field) => {
          const found = roles.indexOf(
            field === "productName" && roles.includes("productInfo")
              ? "productInfo"
              : field,
          );
          return [field, found < 0 ? null : found];
        }),
      ),
    };
  }
  if (
    Object.values(mapping.columns).some(
      (column) => column !== null && column >= headers.length,
    )
  )
    return fallback("invalid-mapping");
  // 금액·번호를 수량으로 바꾸지 않음. 명시적 지정도 숫자 모양만으로 확정하지 않음.
  if (
    mapping.columns.quantity !== null &&
    ["price", "ignore"].includes(roles[mapping.columns.quantity])
  )
    return fallback("quantity-column-conflict");
  if (["price", "ignore"].includes(roles[mapping.columns.productName]))
    return fallback("product-column-conflict");
  const headerHeight = median(headers.map((header) => header.height));
  const body = lines.slice(lines.indexOf(headerLine) + 1);
  const classified = [];

  for (const line of body) {
    const cells = [];
    for (const token of line.tokens) {
      const tolerance = Math.min(token.height, headerHeight) * 0.65;
      if (token.left < headers[0].left - headerHeight)
        return fallback("ambiguous-layout");
      let column = 0;
      while (
        column + 1 < headers.length &&
        token.left + tolerance >= headers[column + 1].left
      )
        column += 1;
      if (headers[column + 1] && token.right > headers[column + 1].left - tolerance)
        return fallback("ambiguous-layout");
      cells.push({
        ...token,
        column,
        field: FIELDS.find((field) => mapping.columns[field] === column) ?? "ignore",
      });
    }
    for (const column of new Set(cells.map((cell) => cell.column))) {
      const fragments = cells
        .filter((cell) => cell.column === column)
        .sort((a, b) => a.left - b.left);
      if (
        fragments.some(
          (cell, i) =>
            i > 0 &&
            cell.left - fragments[i - 1].right >
              Math.min(cell.height, fragments[i - 1].height) * 3,
        )
      )
        return fallback("ambiguous-layout");
    }
    // 합계 이름만으로 표를 잘라내지 않음. 상품/수량을 가진 'Total'도 상품일 수 있음.
    if (
      cells.some(
        (cell) =>
          cell.field === "productName" &&
          /^(합계|총합계|총금액|total|grand\s*total)$/iu.test(
            cell.row.sourceText.trim(),
          ),
      ) &&
      cells.some((cell) => roles[cell.column] === "price") &&
      !cells.some((cell) => cell.field === "quantity")
    )
      continue;
    classified.push({ ...line, cells });
  }

  const anchors = classified.filter((line) => {
    const fields = new Set(line.cells.map((cell) => cell.field));
    return (
      (fields.has("quantity") &&
        line.cells.some(
          (cell) =>
            cell.field === "quantity" &&
            /^[0-9]{1,9}$/.test(cell.row.sourceText.trim()),
        )) ||
      (fields.has("productName") &&
        (fields.has("quantity") ||
          (fields.has("brand") && fields.has("option")) ||
          (mapping.columns.quantity === null &&
            new Set(line.cells.map((cell) => cell.column)).size >= 2)))
    );
  });
  if (classified.length && !anchors.length) return fallback("ambiguous-layout");
  const groups = anchors.map((anchor) => ({ anchor, cells: [...anchor.cells] }));

  for (const line of classified) {
    if (anchors.includes(line)) continue;
    if (
      line.cells.some((cell) =>
        /^(배송완료|배송중|구매확정|주문완료|취소완료|반품완료|교환완료|로그인|회원가입|마이페이지|장바구니|이전|다음)$/u.test(
          cell.row.sourceText.trim(),
        ),
      )
    )
      return fallback("ambiguous-noise");
    // 여러 열을 가진 불완전한 행은 별도 상품일 수 있으므로 줄바꿈으로 합치지 않음.
    if (new Set(line.cells.map((cell) => cell.column)).size !== 1)
      return fallback("ambiguous-layout");
    const nearest = groups
      .map((group) => ({ group, distance: Math.abs(group.anchor.y - line.y) }))
      .sort((a, b) => a.distance - b.distance);
    const height = median(line.cells.map((cell) => cell.height));
    if (
      !nearest[0] ||
      nearest[0].distance > height * 3 ||
      (nearest[1] && nearest[1].distance - nearest[0].distance < height * 0.5)
    )
      return fallback("ambiguous-layout");
    nearest[0].group.cells.push(...line.cells);
  }

  const result = [];
  for (const group of groups) {
    const cells = visualLines(group.cells).flatMap((line) =>
      [...line.tokens].sort((a, b) => a.left - b.left),
    );
    const fields = {};
    for (const field of FIELDS) {
      fields[field] = cells
        .filter((cell) => cell.field === field)
        .map((cell) => cell.row.sourceText.trim().replace(/\s+/gu, " "))
        .join(" ");
    }
    if (mapping.productInfo || roles[mapping.columns.productName] === "productInfo") {
      const compound = compoundFields(
        cells.filter((cell) => cell.field === "productName"),
        mapping.productInfo,
      );
      if (!compound) return fallback("ambiguous-product-info");
      for (const field of FIELDS) {
        if (
          field !== "productName" &&
          fields[field] &&
          compound[field] &&
          fields[field] !== compound[field]
        )
          return fallback("conflicting-fields");
        fields[field] = compound[field] || fields[field];
      }
    }
    if (!fields.productName) return fallback("ambiguous-layout");
    const sourceText = cells.map((cell) => cell.row.sourceText).join(" | ");
    if (
      fields.productName.length > 240 ||
      fields.brand.length > 100 ||
      fields.option.length > 200 ||
      sourceText.length > 1000
    )
      return fallback("field-limit");
    // 상품명 열을 바꾸더라도 같은 행 묶음의 원본 ID·score·box는 바뀌지 않음.
    const anchor = cells[0].row;
    result.push({
      ...anchor,
      sourceText,
      productName: fields.productName,
      brand: fields.brand,
      option: fields.option,
      quantity: /^[0-9]{1,9}$/.test(fields.quantity) ? fields.quantity : "",
    });
  }
  if (!result.length) return fallback("no-product-rows");
  return { mode: "table", rows: result, table, mapping };
}
