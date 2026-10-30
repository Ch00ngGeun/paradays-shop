// 역할: 관리자 메뉴별 화면 안내(코치마크) 단계 문구입니다. 각 메뉴 상단 단계 흐름을 따라 첫 사용자 눈높이로 씁니다.
import type { Locale } from "@/types/store";

export type AdminGuideMenu =
  | "home"
  | "products"
  | "inventory"
  | "sales"
  | "brands"
  | "members"
  | "coupons"
  | "marketing"
  | "ocr";

type Text = Readonly<{ ko: string; en: string }>;

export type AdminGuideEntry = Readonly<{
  /** 화면 요소의 data-admin-guide 값. "메뉴.부분" 형식입니다. */
  target: string;
  /** 입력칸은 밑줄, 그 밖은 둥근 사각형입니다. */
  mark: "ring" | "underline";
  title: Text;
  body: Text;
}>;

const step = (
  target: string,
  mark: AdminGuideEntry["mark"],
  title: Text,
  body: Text,
): AdminGuideEntry => ({ target, mark, title, body });

export const ADMIN_GUIDES: Readonly<
  Record<AdminGuideMenu, readonly AdminGuideEntry[]>
> = {
  // 상단 흐름: 운영 지표 조회 → 재고 확인 → 매출·일마감
  home: [
    // 오늘 매출·주문·판매 수량 지표 카드 묶음
    step(
      "home.metrics",
      "ring",
      { ko: "오늘 숫자 보기", en: "Today at a glance" },
      {
        ko: "오늘 매출과 주문 수를 한눈에 봅니다.",
        en: "See today's sales and orders at a glance.",
      },
    ),
    // 운영 바로가기의 '재고 주의' 카드
    step(
      "home.lowStock",
      "ring",
      { ko: "재고가 적은 상품", en: "Products running low" },
      {
        ko: "재고가 1~5개 남은 상품 수입니다. 누르면 재고 화면으로 갑니다.",
        en: "Products with 1 to 5 left. Press it to open stock editing.",
      },
    ),
    // 운영 바로가기의 '매출·일마감' 카드
    step(
      "home.sales",
      "ring",
      { ko: "하루 마감", en: "Close the day" },
      {
        ko: "가게 판매를 정리하고 하루를 마감하는 곳으로 갑니다.",
        en: "Go to settle in-store sales and close the day.",
      },
    ),
    // '주문 취소·반품 재고 관리'의 주문번호 입력칸
    step(
      "home.orderLookup",
      "underline",
      { ko: "취소·반품 처리", en: "Cancels and returns" },
      {
        ko: "주문번호를 넣고 조회하면 환불과 재입고를 처리할 수 있습니다.",
        en: "Enter an order number to handle its refund and restock.",
      },
    ),
  ],
  // 상단 흐름: 상품 선택 → 정보 입력 → 저장·공개
  products: [
    // 상품 목록(각 행의 '수정' 버튼 포함)
    step(
      "products.list",
      "ring",
      { ko: "상품 고르기", en: "Pick a product" },
      {
        ko: "고칠 상품의 '수정'을 누르거나 새 상품을 등록합니다.",
        en: "Press Edit on a product, or register a new one.",
      },
    ),
    // 편집 화면의 상품명 입력칸
    step(
      "products.name",
      "underline",
      { ko: "상품 이름 쓰기", en: "Write the name" },
      {
        ko: "손님에게 보일 이름입니다. 두 줄까지 쓸 수 있습니다.",
        en: "The name customers see. It can take two lines.",
      },
    ),
    // '사이즈 / 옵션' 입력칸
    step(
      "products.options",
      "underline",
      { ko: "사이즈 넣기", en: "Add sizes" },
      {
        ko: "사이즈를 하나씩 쓰고 '옵션 추가'를 누릅니다.",
        en: "Type one size at a time and press Add option.",
      },
    ),
    // 오른쪽 '고객 화면 미리보기'
    step(
      "products.preview",
      "ring",
      { ko: "손님 화면 확인", en: "Check the customer view" },
      {
        ko: "저장하기 전에 손님이 볼 모습을 확인합니다.",
        en: "See what customers will see before you save.",
      },
    ),
    // 편집 화면 아래의 저장 버튼
    step(
      "products.save",
      "ring",
      { ko: "저장하기", en: "Save" },
      {
        ko: "다 썼으면 저장합니다. 공개로 저장하면 손님에게 보입니다.",
        en: "Save when you are done. Saving as public shows it to customers.",
      },
    ),
  ],
  // 상단 흐름: 상품 선택 → 변경 수량 확인 → 재고 저장
  inventory: [
    // 재고 상품 목록
    step(
      "inventory.list",
      "ring",
      { ko: "상품 고르기", en: "Pick a product" },
      {
        ko: "재고를 바꿀 상품을 누릅니다.",
        en: "Press the product whose stock you want to change.",
      },
    ),
    // '변경 후 재고 수량' 입력칸
    step(
      "inventory.quantity",
      "underline",
      { ko: "새 수량 넣기", en: "Enter the new count" },
      {
        ko: "＋/－ 버튼이나 숫자로 바뀐 수량을 넣습니다.",
        en: "Use + / − or type the new count.",
      },
    ),
    // 수량 변경 확인·저장 버튼
    step(
      "inventory.save",
      "ring",
      { ko: "재고 저장", en: "Save stock" },
      {
        ko: "바뀌기 전과 후 수량을 확인하고 저장합니다.",
        en: "Check the count before and after, then save.",
      },
    ),
  ],
  // 상단 흐름: 장부 조회 → 판매 전표 정리 → 일마감
  sales: [
    // 매출·일마감 처음 화면의 '연습하기' / '실제 운영' 선택
    step(
      "sales.mode",
      "ring",
      { ko: "연습 또는 실제", en: "Practice or real" },
      {
        ko: "처음이라면 '연습하기'로 먼저 해 봅니다.",
        en: "New to this? Try Practice first.",
      },
    ),
    // 장부의 영업일 입력칸
    step(
      "sales.day",
      "underline",
      { ko: "날짜 고르기", en: "Pick the day" },
      {
        ko: "정리할 날짜를 고르고 장부를 불러옵니다.",
        en: "Choose the day to settle and load its ledger.",
      },
    ),
    // 새 판매 기록(전표) 버튼
    step(
      "sales.newEntry",
      "ring",
      { ko: "판매 적기", en: "Record a sale" },
      {
        ko: "카드·현금 판매를 한 건씩 적고 상품을 연결합니다.",
        en: "Record each card or cash sale and link its products.",
      },
    ),
    // 일마감 영역
    step(
      "sales.close",
      "ring",
      { ko: "하루 마감", en: "Close the day" },
      {
        ko: "현금을 다시 세어 맞춘 뒤 하루를 마감합니다.",
        en: "Count the cash again, then close the day.",
      },
    ),
  ],
  // 상단 흐름: 브랜드 목록 확인 → 브랜드 입력 → 브랜드 저장
  brands: [
    // 브랜드 목록 표
    step(
      "brands.list",
      "ring",
      { ko: "있는 브랜드 확인", en: "Check existing brands" },
      {
        ko: "이미 있는 브랜드인지 먼저 찾아봅니다.",
        en: "First check whether the brand is already here.",
      },
    ),
    // '브랜드 추가'의 브랜드명 입력칸
    step(
      "brands.name",
      "underline",
      { ko: "브랜드 이름 쓰기", en: "Write the brand name" },
      { ko: "새 브랜드 이름을 적습니다.", en: "Type the new brand's name." },
    ),
    // '브랜드 등록' 버튼
    step(
      "brands.save",
      "ring",
      { ko: "등록하기", en: "Register" },
      {
        ko: "등록하면 상품을 만들 때 고를 수 있습니다.",
        en: "Once registered, you can pick it for products.",
      },
    ),
  ],
  // 상단 흐름: 회원 조회 → 회원 선택 → 권한 변경
  members: [
    // '회원 목록 불러오기' 버튼
    step(
      "members.load",
      "ring",
      { ko: "회원 불러오기", en: "Load members" },
      {
        ko: "버튼을 눌러 회원 목록을 불러옵니다.",
        en: "Press the button to load the member list.",
      },
    ),
    // 회원 목록
    step(
      "members.list",
      "ring",
      { ko: "회원 고르기", en: "Pick a member" },
      {
        ko: "권한을 바꿀 회원을 누릅니다.",
        en: "Press the member whose access you want to change.",
      },
    ),
    // 운영 권한 변경 영역
    step(
      "members.roles",
      "ring",
      { ko: "권한 바꾸기", en: "Change access" },
      {
        ko: "관리자·상담 권한을 고르고 내용을 확인한 뒤 바꿉니다.",
        en: "Choose admin or support access, check it, then apply.",
      },
    ),
  ],
  // 상단 흐름: 혜택 설정 → 미리보기 확인 → 저장 → 고객 발급
  coupons: [
    // 쿠폰명 입력칸
    step(
      "coupons.name",
      "underline",
      { ko: "쿠폰 이름 쓰기", en: "Name the coupon" },
      { ko: "손님에게 보일 쿠폰 이름입니다.", en: "The coupon name customers see." },
    ),
    // 혜택 유형과 할인 값
    step(
      "coupons.benefit",
      "ring",
      { ko: "할인 정하기", en: "Set the discount" },
      {
        ko: "몇 %를, 또는 얼마를 깎아 줄지 정합니다.",
        en: "Choose a percent off or an amount off.",
      },
    ),
    // 오른쪽 '쿠폰 미리보기'
    step(
      "coupons.preview",
      "ring",
      { ko: "모습 확인", en: "Check how it looks" },
      {
        ko: "손님에게 보일 쿠폰 모습을 확인합니다.",
        en: "See how the coupon will look.",
      },
    ),
    // 쿠폰 저장 버튼
    step(
      "coupons.save",
      "ring",
      { ko: "쿠폰 저장", en: "Save the coupon" },
      {
        ko: "저장해도 아직 손님에게 나눠 주지는 않습니다.",
        en: "Saving does not hand it out to customers yet.",
      },
    ),
  ],
  // 상단 흐름: 채널 선택 → 문구 작성 → 저장 → 고객 발송
  marketing: [
    // 이메일·SMS·푸시 채널 카드
    step(
      "marketing.channels",
      "ring",
      { ko: "보낼 곳 고르기", en: "Pick where to send" },
      {
        ko: "이메일·문자·푸시 중 문구를 만들 곳을 고릅니다.",
        en: "Choose email, text or push for the message.",
      },
    ),
    // 캠페인 제목 입력칸
    step(
      "marketing.title",
      "underline",
      { ko: "제목 쓰기", en: "Write the title" },
      { ko: "손님이 처음 보게 될 제목입니다.", en: "The first thing customers read." },
    ),
    // 메시지 입력칸
    step(
      "marketing.body",
      "underline",
      { ko: "내용 쓰기", en: "Write the message" },
      { ko: "혜택과 안내를 짧게 적습니다.", en: "Keep the offer and details short." },
    ),
    // 오른쪽 미리보기
    step(
      "marketing.preview",
      "ring",
      { ko: "모습 확인", en: "Check how it looks" },
      { ko: "보낼 모습을 미리 확인합니다.", en: "See the message before saving." },
    ),
    // 캠페인 저장 버튼
    step(
      "marketing.save",
      "ring",
      { ko: "저장하기", en: "Save" },
      {
        ko: "저장해도 손님에게 보내지는 않습니다.",
        en: "Saving does not send anything to customers.",
      },
    ),
  ],
  // 상단 흐름: 이미지 선택 → 글자 인식 → 내용 검토 → 검토본 저장 → 입고 반영
  ocr: [
    // 입고 명세서 이미지 선택
    step(
      "ocr.image",
      "ring",
      { ko: "사진 고르기", en: "Choose a photo" },
      {
        ko: "입고 명세서 사진을 고릅니다. 표 전체가 보여야 합니다.",
        en: "Choose a photo of the delivery sheet showing the whole table.",
      },
    ),
    // 사진 속 글자를 읽는 버튼
    step(
      "ocr.recognize",
      "ring",
      { ko: "글자 읽기", en: "Read the text" },
      {
        ko: "버튼을 누르면 사진 속 글자를 읽어 옵니다.",
        en: "Press the button to read the text in the photo.",
      },
    ),
    // 인식 결과(상품명·수량 표)
    step(
      "ocr.review",
      "ring",
      { ko: "내용 고치기", en: "Fix the details" },
      {
        ko: "사진과 비교하며 상품명과 수량을 고칩니다.",
        en: "Compare with the photo and fix names and counts.",
      },
    ),
    // 검토본 저장 버튼
    step(
      "ocr.save",
      "ring",
      { ko: "확인한 내용 저장", en: "Save what you checked" },
      {
        ko: "고친 내용을 저장합니다. 재고는 아직 바뀌지 않습니다.",
        en: "Save your fixes. Stock does not change yet.",
      },
    ),
    // '재고 반영' 영역
    step(
      "ocr.apply",
      "ring",
      { ko: "재고에 넣기", en: "Add to stock" },
      {
        ko: "상품을 맞추고 확인한 뒤 재고에 넣습니다.",
        en: "Match the products, check them, then add to stock.",
      },
    ),
  ],
};

/** 화면 안내 컴포넌트에 넘길 단계(화면 언어로)입니다. */
export function adminGuideSteps(menu: AdminGuideMenu, locale: Locale) {
  return ADMIN_GUIDES[menu].map(({ target, mark, title, body }) => ({
    target,
    mark,
    title: title[locale],
    body: body[locale],
  }));
}
