// 역할: start-local-ocr.mjs의 프로필 판별 함수 타입 선언입니다.
/** 데스크톱 전용 프로필 판별 함수이며, import만으로는 어떤 프로세스도 시작하지 않습니다. */
export function resolveLocalOcrProfile(demoSetting?: string): {
  demoEnabled: boolean;
  providerDeadlineSeconds: number;
  relayTimeoutMs: number;
};
