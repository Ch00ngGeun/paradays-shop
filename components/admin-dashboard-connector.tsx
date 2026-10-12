// 역할: 관리자 UI의 선택적 action을 실제 Cognito access token 기반 API client에 연결합니다.
"use client";

import { useMemo } from "react";

import { useAuth } from "@/contexts/auth-context";
import type { AdminDashboardActions } from "@/lib/admin-ui/types";
import { createAdminApiClientFromEnvironment } from "@/lib/commerce/admin-api-client";

import { AdminDashboard } from "./admin-dashboard";

/** API URL이 아직 배포되지 않은 로컬 화면도 안전한 임시 초안 UX를 유지합니다. */
export function AdminDashboardConnector() {
  const { getAccessToken } = useAuth();
  const actions = useMemo<AdminDashboardActions | undefined>(() => {
    try {
      const client = createAdminApiClientFromEnvironment({
        authorizationTokenProvider: { getAccessToken },
      });

      return {
        uploadProductImage: client.uploadProductImage,
        loadOverviewMetrics: client.loadOverviewMetrics,
        listCatalogProducts: client.listCatalogProducts,
        saveProductDraft: client.saveProductDraft,
        updateProductStock: client.updateProductStock,
        deleteCatalogProducts: client.deleteCatalogProducts,
        saveBrandDraft: client.saveBrandDraft,
        saveCouponDraft: client.saveCouponDraft,
        saveCampaignDraft: client.saveCampaignDraft,
        listMembers: client.listMembers,
        updateMemberGroup: client.updateMemberGroup,
        recognizeInventory: client.recognizeInventory,
        loadOcrReview: client.loadOcrReview,
        saveOcrReview: client.saveOcrReview,
      };
    } catch {
      return undefined;
    }
  }, [getAccessToken]);

  return <AdminDashboard actions={actions} />;
}
