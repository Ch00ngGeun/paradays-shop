// 역할: static export에서도 Cognito client context로 권한을 확인하는 관리자 진입 경로입니다.
import { AdminDashboardConnector } from "@/components/admin-dashboard-connector";

/** 실제 데이터 보호는 API Gateway/Lambda의 admin 그룹 검증이 담당하며, 페이지는 UX 가드만 제공합니다. */
export default function AdminPage() {
  return <AdminDashboardConnector />;
}
