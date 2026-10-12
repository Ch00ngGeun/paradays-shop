// 역할: Cognito 회원가입·로그인과 AWS 회원 프로필·주문 내역 UI를 제공하는 정적 계정 라우트입니다.
import { AccountContent } from "@/components/account-content";

/** `/account` 페이지는 static export에서도 AuthProvider 하위 클라이언트 상태로 동작합니다. */
export default function AccountPage() {
  return <AccountContent />;
}
