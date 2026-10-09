import { type ChildProcess, spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import path from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { AppError } from "@agents-hub/shared";

const version = "2026.10.0";
const checksum = "86aee4017b26625cee8484c113558f48effa4cd47f7aa05fcf425604e5d2b23c";

export class LocalTunnel {
  private child: ChildProcess | undefined;
  private address: string | null = null;
  constructor(
    private root: string,
    private port: number,
  ) {}
  url() {
    return this.address;
  }
  async start() {
    if (this.address) return this.address;
    if (process.platform !== "win32" || process.arch !== "x64")
      throw new AppError(
        "INVALID_INPUT",
        "Compartir desde este panel requiere Windows x64 por ahora. El Hub local funciona en Linux; el empaquetado multiplataforma sigue en desarrollo.",
      );
    const executable = path.join(this.root, ".tools", `cloudflared-${version}.exe`);
    await mkdir(path.dirname(executable), { recursive: true });
    let bytes = await readFile(executable).catch(() => undefined);
    if (!bytes) {
      const response = await fetch(
        `https://github.com/cloudflare/cloudflared/releases/download/${version}/cloudflared-windows-amd64.exe`,
        { signal: AbortSignal.timeout(120000), redirect: "follow" },
      );
      if (!response.ok)
        throw new AppError(
          "STATE_CONFLICT",
          "No se pudo descargar el transporte. Comprueba Internet y vuelve a compartir.",
        );
      bytes = Buffer.from(await response.arrayBuffer());
      if (createHash("sha256").update(bytes).digest("hex") !== checksum)
        throw new AppError("STATE_CONFLICT", "La descarga no pasó la comprobación de integridad.");
      const temporary = `${executable}.${crypto.randomUUID()}.download`;
      await writeFile(temporary, bytes, { flag: "wx" });
      await rename(temporary, executable);
    }
    if (createHash("sha256").update(bytes).digest("hex") !== checksum)
      throw new AppError(
        "STATE_CONFLICT",
        "El transporte local no pasó la comprobación de integridad.",
      );
    const child = spawn(
      executable,
      [
        "tunnel",
        "--no-autoupdate",
        "--protocol",
        "http2",
        "--url",
        `http://127.0.0.1:${this.port}`,
      ],
      { windowsHide: true, stdio: ["ignore", "pipe", "pipe"] },
    );
    this.child = child;
    let failed = false;
    let candidate: string | undefined;
    let connected = false;
    let buffer = "";
    const events = child as unknown as NodeJS.EventEmitter;
    events.once("error", () => {
      failed = true;
    });
    events.once("exit", () => {
      failed = true;
      if (this.child === child) {
        this.child = undefined;
        this.address = null;
      }
    });
    for (const stream of [child.stdout, child.stderr])
      stream?.on("data", (data: Buffer) => {
        buffer = `${buffer}${data.toString()}`.slice(-8192);
        candidate ||= buffer.match(/https:\/\/[a-z0-9-]+\.trycloudflare\.com\b/)?.[0];
        connected ||= buffer.includes("Registered tunnel connection");
      });
    const deadline = Date.now() + 60000;
    while ((!candidate || !connected) && !failed && Date.now() < deadline) await sleep(100);
    if (!candidate || !connected || failed) {
      await this.stop();
      throw new AppError(
        "STATE_CONFLICT",
        "El túnel no pudo abrirse. Comprueba Internet y vuelve a intentarlo.",
      );
    }
    this.address = candidate;
    return candidate;
  }
  async stop() {
    const child = this.child;
    this.child = undefined;
    this.address = null;
    if (child && child.exitCode === null && child.signalCode === null) {
      const exited = new Promise<void>((resolve) =>
        (child as unknown as NodeJS.EventEmitter).once("exit", () => resolve()),
      );
      child.kill();
      await Promise.race([exited, sleep(5000, undefined, { ref: false })]);
      if (child.exitCode === null && child.signalCode === null) {
        child.kill("SIGKILL");
        await exited;
      }
    }
  }
}
