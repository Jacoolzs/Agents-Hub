import { randomBytes, scrypt, timingSafeEqual } from "node:crypto";
import { AppError } from "@agents-hub/shared";

// Fixed, versioned parameters: scrypt N=2^17, r=8, p=1 (128 MiB).
// One concurrent derivation per process, no unbounded waiting queue.
let running = false;
export async function derivePassword(password: string, salt: string) {
  if (running) throw new AppError("RATE_LIMITED", "Espera un momento y vuelve a intentarlo.");
  running = true;
  try {
    return await new Promise<string>((resolve, reject) => {
      scrypt(
        password,
        Buffer.from(salt, "hex"),
        64,
        { N: 131072, r: 8, p: 1, maxmem: 160 * 1024 * 1024 },
        (error, key) => (error ? reject(error) : resolve(key.toString("hex"))),
      );
    });
  } finally {
    running = false;
  }
}
export function passwordSalt() {
  return randomBytes(16).toString("hex");
}
export function equalPassword(actual: string, expected: string) {
  const a = Buffer.from(actual, "hex");
  const b = Buffer.from(expected, "hex");
  return a.length === b.length && timingSafeEqual(a, b);
}
