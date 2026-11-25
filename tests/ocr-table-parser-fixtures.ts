export function token(
  id: string,
  sourceText: string,
  x: number,
  y: number,
  width = 70,
) {
  return {
    id,
    sourceText,
    confidence: 0.91,
    box: [
      [x, y],
      [x + width, y],
      [x + width, y + 20],
      [x, y + 20],
    ],
  } as const;
}

export function fixture() {
  return [
    token("title", "가상 입고표", 20, 10),
    token("h1", "상품명", 20, 80),
    token("h2", "브랜드", 330, 80),
    token("h3", "옵션", 520, 80),
    token("h4", "수량(개)", 800, 80),
    token("p1", "Long test deck", 20, 150, 270),
    token("b1", "Sample Works", 330, 150),
    token("o1", "8.75 inch", 520, 150),
    token("q1", "7", 820, 150, 15),
    token("p2", "Test wheel", 20, 230),
    token("b2", "Other Works", 330, 230),
    token("o2", "52 mm", 520, 230),
    token("q2", "12", 815, 230, 25),
  ];
}
