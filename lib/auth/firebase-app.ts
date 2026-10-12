// 역할: Firebase 웹 앱 초기화 (선택적 Phone Auth OTP).

import { initializeApp, getApps, type FirebaseApp } from "firebase/app";
import { getAuth, type Auth } from "firebase/auth";

export type FirebasePublicConfig = Readonly<{
  apiKey: string;
  authDomain: string;
  projectId: string;
  appId: string;
  storageBucket?: string;
  messagingSenderId?: string;
}>;

function readFirebaseConfig(): FirebasePublicConfig | null {
  const apiKey = process.env.NEXT_PUBLIC_FIREBASE_API_KEY?.trim();
  const authDomain = process.env.NEXT_PUBLIC_FIREBASE_AUTH_DOMAIN?.trim();
  const projectId = process.env.NEXT_PUBLIC_FIREBASE_PROJECT_ID?.trim();
  const appId = process.env.NEXT_PUBLIC_FIREBASE_APP_ID?.trim();

  if (!apiKey || !authDomain || !projectId || !appId) {
    return null;
  }

  return {
    apiKey,
    authDomain,
    projectId,
    appId,
    ...(process.env.NEXT_PUBLIC_FIREBASE_STORAGE_BUCKET?.trim()
      ? { storageBucket: process.env.NEXT_PUBLIC_FIREBASE_STORAGE_BUCKET.trim() }
      : {}),
    ...(process.env.NEXT_PUBLIC_FIREBASE_MESSAGING_SENDER_ID?.trim()
      ? {
          messagingSenderId:
            process.env.NEXT_PUBLIC_FIREBASE_MESSAGING_SENDER_ID.trim(),
        }
      : {}),
  };
}

export function getFirebaseConfiguration():
  | Readonly<{ available: true; config: FirebasePublicConfig }>
  | Readonly<{ available: false; reason: string }> {
  const config = readFirebaseConfig();

  if (!config) {
    return {
      available: false,
      reason:
        "Firebase 공개 설정이 없습니다. NEXT_PUBLIC_FIREBASE_* 환경 변수를 확인하세요.",
    };
  }

  return { available: true, config };
}

let app: FirebaseApp | null = null;
let auth: Auth | null = null;

export function getFirebaseApp(): FirebaseApp {
  const configuration = getFirebaseConfiguration();

  if (!configuration.available) {
    throw new Error(configuration.reason);
  }

  if (!app) {
    app = getApps()[0] ?? initializeApp(configuration.config);
  }

  return app;
}

export function getFirebaseAuth(): Auth {
  if (!auth) {
    auth = getAuth(getFirebaseApp());
  }

  return auth;
}
