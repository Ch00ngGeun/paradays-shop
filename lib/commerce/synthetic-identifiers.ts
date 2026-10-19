/** Synthetic teaching IDs are a reserved client namespace, never an API/payment bypass. */
export function isSyntheticIdentifier(value: unknown): boolean {
  return typeof value === "string" && /^TEST(?:[_-]|$)/i.test(value.trim());
}
