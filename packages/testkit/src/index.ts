export function createFakeId(prefix = "id"): string {
  return `${prefix}-${Date.now()}`;
}
