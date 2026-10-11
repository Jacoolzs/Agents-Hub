import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

export function createCompanionData() {
  return mkdtemp(path.join(os.tmpdir(), "agents-hub-e2e-data-"));
}
export async function removeCompanionData(directory: string) {
  if (
    path.dirname(directory) !== path.resolve(os.tmpdir()) ||
    !path.basename(directory).startsWith("agents-hub-e2e-data-")
  )
    throw new Error("Unsafe fixture directory");
  await rm(directory, { recursive: true, force: true });
}
