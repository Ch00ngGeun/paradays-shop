// 역할: Cognito admin 그룹 사용자에게만 노출되는 정적 관리자 워크스페이스 UI를 제공합니다.
"use client";
import { useAuth } from "@/contexts/auth-context";
import { useLocale } from "@/contexts/locale-context";
import type { AdminDashboardActions } from "@/lib/admin-ui/types";
import { rememberAuthReturnPath } from "@/lib/auth/return-path";
import Link from "next/link";
import { AdminAccessPanel } from "./admin-access-panel";
import { ADMIN_GROUP } from "./admin-navigation";
import { AdminWorkspace } from "./admin-workspace";

/** API 어댑터는 상위에서 주입하며, 이 파일은 브라우저 UI·임시 초안만 책임집니다. */
export function AdminDashboard({
  actions,
}: Readonly<{ actions?: AdminDashboardActions }>) {
  const { isAuthenticated, isAvailable, status, user } = useAuth();
  const { copy } = useLocale();

  if (!isAvailable) {
    return (
      <AdminAccessPanel
        eyebrow={copy.adminAccessEyebrow}
        title={copy.adminAuthSetupRequired}
        description={copy.adminAuthSetupDescription}
        loadingLabel={copy.adminCheckingPermissionsLoading}
      />
    );
  }

  if (status === "initializing") {
    return (
      <AdminAccessPanel
        eyebrow={copy.adminAccessEyebrow}
        title={copy.adminCheckingPermissions}
        description={copy.adminCheckingPermissionsDescription}
        loading
        loadingLabel={copy.adminCheckingPermissionsLoading}
      />
    );
  }

  if (!isAuthenticated || !user) {
    return (
      <AdminAccessPanel
        action={
          <Link href="/login" onClick={() => rememberAuthReturnPath()}>
            {copy.adminLoginAction}
          </Link>
        }
        eyebrow={copy.adminAccessEyebrow}
        title={copy.adminLoginRequired}
        description={copy.adminLoginRequiredDescription}
        loadingLabel={copy.adminCheckingPermissionsLoading}
      />
    );
  }

  if (!user.groups.includes(ADMIN_GROUP)) {
    return (
      <AdminAccessPanel
        action={<Link href="/account">{copy.adminGoToAccount}</Link>}
        eyebrow={copy.adminAccessDeniedEyebrow}
        title={copy.adminAccessDenied}
        description={copy.adminAccessDeniedDescription}
        loadingLabel={copy.adminCheckingPermissionsLoading}
      />
    );
  }

  return (
    <AdminWorkspace
      actions={actions}
      adminName={user.displayName ?? user.email ?? user.username}
      key={user.sub}
    />
  );
}
