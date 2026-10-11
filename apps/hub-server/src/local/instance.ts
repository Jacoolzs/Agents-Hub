import {
  createCipheriv,
  createDecipheriv,
  createHmac,
  randomBytes,
  timingSafeEqual,
} from "node:crypto";
import { mkdir, open, readFile, rename, unlink } from "node:fs/promises";
import { type Socket, createConnection, createServer } from "node:net";
import path from "node:path";
import type { DatabaseSync } from "node:sqlite";
import { setTimeout as sleep } from "node:timers/promises";
import { prepareOwnership, tryOwnership } from "./ownership.js";
import { privateDirectory, verifyPrivatePath } from "./private-directory.js";

interface InstanceRecord {
  version: 1 | 2;
  identity: string;
  address: string;
  key: string;
}
const noncePattern = /^[A-Za-z0-9_-]{43}$/;
function mac(key: string, nonce: string, identity: string, timestamp: number) {
  return createHmac("sha256", Buffer.from(key, "hex"))
    .update(`${nonce}:${identity}:${timestamp}`)
    .digest("hex");
}
function sameMac(left: unknown, right: string) {
  return (
    typeof left === "string" &&
    /^[a-f0-9]{64}$/.test(left) &&
    timingSafeEqual(Buffer.from(left), Buffer.from(right))
  );
}
function readLine(socket: Socket, handle: (line: string) => void) {
  let buffer = "";
  socket.setTimeout(3000, () => socket.destroy());
  socket.on("error", () => socket.destroy());
  socket.on("data", (bytes: Buffer) => {
    buffer += bytes.toString();
    if (Buffer.byteLength(buffer) > 4096) {
      socket.destroy();
      return;
    }
    const boundary = buffer.indexOf("\n");
    if (boundary >= 0) {
      socket.removeAllListeners("data");
      handle(buffer.slice(0, boundary));
    }
  });
}
async function requestReopen(record: InstanceRecord): Promise<string> {
  return new Promise((resolve, reject) => {
    const nonce = randomBytes(32).toString("base64url");
    const timestamp = Date.now();
    const socket = createConnection(record.address);
    let completed = false;
    const timer = setTimeout(() => socket.destroy(), 3000);
    socket.once("close", () => {
      clearTimeout(timer);
      if (!completed) reject(new Error("Private instance unavailable"));
    });
    socket.once("connect", () =>
      socket.write(
        `${JSON.stringify({ nonce, timestamp, proof: mac(record.key, nonce, record.identity, timestamp) })}\n`,
      ),
    );
    readLine(socket, (line) => {
      try {
        const response = JSON.parse(line) as { iv: string; tag: string; ciphertext: string };
        if (
          !/^[a-f0-9]{24}$/.test(response.iv) ||
          !/^[a-f0-9]{32}$/.test(response.tag) ||
          !/^[a-f0-9]+$/.test(response.ciphertext)
        )
          throw new Error("Invalid response");
        const cipher = createDecipheriv(
          "aes-256-gcm",
          Buffer.from(record.key, "hex"),
          Buffer.from(response.iv, "hex"),
        );
        cipher.setAAD(Buffer.from(`${nonce}:${record.identity}`));
        cipher.setAuthTag(Buffer.from(response.tag, "hex"));
        const url = Buffer.concat([
          cipher.update(Buffer.from(response.ciphertext, "hex")),
          cipher.final(),
        ]).toString();
        completed = true;
        resolve(url);
      } catch {
        completed = true;
        reject(new Error("Private instance authentication failed"));
      }
      socket.destroy();
    });
  });
}

export class LocalInstance {
  private server = createServer();
  private sockets = new Set<Socket>();
  private seen = new Map<string, number>();
  private closed = false;
  private constructor(
    private file: string,
    private record: InstanceRecord,
    private ownership: DatabaseSync,
  ) {}

  static async acquire(data: string, identity: string): Promise<LocalInstance | string> {
    if (!path.isAbsolute(data)) throw new Error("Private data directory must be absolute");
    await mkdir(data, { recursive: true });
    const directory = path.join(data, ".companion-control");
    await privateDirectory(directory);
    const file = path.join(directory, "instance.json");
    const ownershipFile = path.join(directory, "ownership.sqlite");
    await prepareOwnership(ownershipFile);
    const deadline = Date.now() + 5000;
    while (true) {
      const ownership = tryOwnership(ownershipFile);
      let retained = false;
      try {
        let record: InstanceRecord | undefined;
        try {
          await verifyPrivatePath(file);
          record = JSON.parse(await readFile(file, "utf8")) as InstanceRecord;
          if (!record || typeof record !== "object") throw new Error("Invalid instance record");
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
        }
        if (record) {
          if (
            (record.version !== 1 && record.version !== 2) ||
            record.identity !== identity ||
            !/^[a-f0-9]{64}$/.test(record.key) ||
            typeof record.address !== "string"
          )
            throw new Error("Instance identity mismatch");
          const expectedAddress =
            process.platform === "win32" ? /^\\\\\.\\pipe\\agents-hub-[a-f0-9-]{36}$/ : undefined;
          if (
            expectedAddress
              ? !expectedAddress.test(record.address)
              : record.version === 1
                ? record.address !== path.join(directory, "reopen.sock")
                : path.dirname(record.address) !== directory ||
                  !/^r-[a-f0-9]{16}\.sock$/.test(path.basename(record.address))
          )
            throw new Error("Instance address mismatch");
          // v1 never promised to hold this mutex; absence of response proves nothing.
          if (!ownership || record.version === 1) {
            try {
              return await requestReopen(record);
            } catch {
              if (Date.now() >= deadline)
                throw new Error("Existing private instance is unavailable; no takeover attempted");
              await sleep(100);
              continue;
            }
          }
        }
        if (!ownership) {
          if (Date.now() >= deadline)
            throw new Error("Existing private instance is unavailable; no takeover attempted");
          await sleep(100);
          continue;
        }
        const newRecord: InstanceRecord = {
          version: 2,
          identity,
          key: randomBytes(32).toString("hex"),
          address:
            process.platform === "win32"
              ? `\\\\.\\pipe\\agents-hub-${crypto.randomUUID()}`
              : path.join(directory, `r-${randomBytes(8).toString("hex")}.sock`),
        };
        const temporary = path.join(directory, `entry-${crypto.randomUUID()}.tmp`);
        const handle = await open(temporary, "wx", 0o600);
        try {
          await verifyPrivatePath(temporary, true);
          await handle.writeFile(JSON.stringify(newRecord));
          await handle.sync();
        } finally {
          await handle.close();
        }
        try {
          await rename(temporary, file);
        } finally {
          await unlink(temporary).catch((error: NodeJS.ErrnoException) => {
            if (error.code !== "ENOENT") throw error;
          });
        }
        retained = true;
        return new LocalInstance(file, newRecord, ownership);
      } finally {
        if (!retained) ownership?.close();
      }
    }
  }

  async serve(issueEntry: () => string) {
    this.server.on("connection", (socket) => {
      if (this.sockets.size >= 8) {
        socket.destroy();
        return;
      }
      this.sockets.add(socket);
      socket.once("close", () => this.sockets.delete(socket));
      readLine(socket, (line) => {
        try {
          const request = JSON.parse(line) as { nonce: string; proof: string; timestamp: number };
          const now = Date.now();
          for (const [nonce, expiry] of this.seen) if (expiry < now) this.seen.delete(nonce);
          if (
            !noncePattern.test(request.nonce) ||
            !Number.isSafeInteger(request.timestamp) ||
            Math.abs(now - request.timestamp) > 5000 ||
            this.seen.has(request.nonce) ||
            !sameMac(
              request.proof,
              mac(this.record.key, request.nonce, this.record.identity, request.timestamp),
            )
          ) {
            socket.destroy();
            return;
          }
          if (this.seen.size >= 1024) {
            socket.destroy();
            return;
          }
          this.seen.set(request.nonce, request.timestamp + 5000);
          const iv = randomBytes(12);
          const cipher = createCipheriv("aes-256-gcm", Buffer.from(this.record.key, "hex"), iv);
          cipher.setAAD(Buffer.from(`${request.nonce}:${this.record.identity}`));
          const ciphertext = Buffer.concat([cipher.update(issueEntry(), "utf8"), cipher.final()]);
          socket.end(
            `${JSON.stringify({ iv: iv.toString("hex"), tag: cipher.getAuthTag().toString("hex"), ciphertext: ciphertext.toString("hex") })}\n`,
          );
        } catch {
          socket.destroy();
        }
      });
    });
    await new Promise<void>((resolve, reject) => {
      this.server.once("error", reject);
      this.server.listen(this.record.address, resolve);
    });
  }
  async close() {
    if (this.closed) return;
    this.closed = true;
    try {
      for (const socket of this.sockets) socket.destroy();
      if (this.server.listening)
        await new Promise<void>((resolve, reject) =>
          this.server.close((error) => (error ? reject(error) : resolve())),
        );
      // Never remove another instance's lease, and never recursively remove data.
      const contents = await readFile(this.file, "utf8").catch(() => "");
      if (contents === JSON.stringify(this.record)) await unlink(this.file);
    } finally {
      this.ownership.close();
    }
  }
}
