import { open } from "node:fs/promises";
import { DatabaseSync } from "node:sqlite";
import { setTimeout as sleep } from "node:timers/promises";
import { verifyPrivatePath } from "./private-directory.js";

/** Persistent inode: never unlink/replace it, including after a crash. */
export async function prepareOwnership(file: string) {
  try {
    const handle = await open(file, "wx", 0o600);
    try {
      await verifyPrivatePath(file, true);
    } finally {
      await handle.close();
    }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
    const deadline = Date.now() + 5000;
    while (true) {
      try {
        await verifyPrivatePath(file);
        return;
      } catch (error) {
        if (Date.now() >= deadline) throw error;
        await sleep(100);
      }
    }
  }
}

/** No SQL writes: BEGIN EXCLUSIVE acquires the pager's OS lock immediately. */
export function tryOwnership(file: string): DatabaseSync | undefined {
  const connection = new DatabaseSync(file);
  try {
    connection.exec("BEGIN EXCLUSIVE");
    return connection;
  } catch (error) {
    connection.close();
    if ((error as { errcode?: number }).errcode === 5) return undefined;
    throw error;
  }
}
