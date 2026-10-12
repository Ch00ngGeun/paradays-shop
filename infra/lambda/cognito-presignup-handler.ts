/**
 * 역할: Cognito PreSignUp — Firebase 문자 본인인증 토큰이 있으면 자동 확인.
 * ClientMetadata.firebaseIdToken을 Google Identity Toolkit으로 검증하고
 * phone_number 속성과 일치할 때만 autoConfirm/autoVerifyEmail.
 */

import type {
  PreSignUpTriggerEvent,
  PreSignUpTriggerHandler,
} from "aws-lambda";

type FirebaseLookupResponse = {
  users?: Array<{
    localId?: string;
    phoneNumber?: string;
  }>;
  error?: { message?: string };
};

async function lookupFirebaseUser(idToken: string, apiKey: string) {
  const response = await fetch(
    `https://identitytoolkit.googleapis.com/v1/accounts:lookup?key=${apiKey}`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ idToken }),
    },
  );

  if (!response.ok) {
    return null;
  }

  const body = (await response.json()) as FirebaseLookupResponse;

  return body.users?.[0] ?? null;
}

function readPhoneAttribute(event: PreSignUpTriggerEvent) {
  const attributes = event.request.userAttributes ?? {};

  return attributes.phone_number?.trim() || null;
}

export const handler: PreSignUpTriggerHandler = async (event) => {
  const firebaseIdToken = event.request.clientMetadata?.firebaseIdToken?.trim();
  const apiKey = process.env.FIREBASE_WEB_API_KEY?.trim();

  if (!firebaseIdToken || !apiKey) {
    return event;
  }

  const phoneAttribute = readPhoneAttribute(event);

  if (!phoneAttribute) {
    return event;
  }

  try {
    const firebaseUser = await lookupFirebaseUser(firebaseIdToken, apiKey);

    if (
      firebaseUser?.phoneNumber &&
      firebaseUser.phoneNumber === phoneAttribute
    ) {
      event.response.autoConfirmUser = true;
      event.response.autoVerifyEmail = true;
    }
  } catch {
    // 검증 실패 시 기본(이메일 코드) 흐름으로 둠.
  }

  return event;
};
