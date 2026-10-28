/** Desktop-only profile resolver; importing it does not start any processes. */
export function resolveLocalOcrProfile(demoSetting?: string): {
  demoEnabled: boolean;
  providerDeadlineSeconds: number;
  relayTimeoutMs: number;
};
