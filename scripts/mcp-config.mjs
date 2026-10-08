import { existsSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { parseHubUrl } from "./lib/hub-url.mjs";

const projectRoot = fileURLToPath(new URL("../", import.meta.url));

export function createMcpConfig({
  root = projectRoot,
  executable = process.execPath,
  agentName = "mi-agente",
  hubUrl = "https://TU-HUB",
  projectId = "ID_DEL_PROYECTO",
} = {}) {
  const name = agentName.trim();
  if (
    !name ||
    name.length > 100 ||
    /\b(?:ah_|ahi_|wst_|sk-)[A-Za-z0-9_-]{8,}|Bearer\s+\S+/i.test(name)
  )
    throw new Error("Usa un nombre de agente de 1–100 caracteres, sin credenciales.");
  if (
    projectId !== "ID_DEL_PROYECTO" &&
    !/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(projectId)
  )
    throw new Error("Usa el UUID del proyecto.");
  const entry = path.resolve(root, "packages/mcp-server/dist/main.js");
  if (!existsSync(entry)) throw new Error("Falta el adaptador compilado. Ejecuta pnpm build.");
  return {
    mcpServers: {
      "agents-hub": {
        command: path.resolve(executable),
        args: [entry],
        env: {
          AGENTS_HUB_URL: parseHubUrl(hubUrl),
          AGENTS_HUB_TOKEN: "TU_TOKEN_PERSONAL",
          AGENTS_HUB_PROJECT_ID: projectId,
          AGENTS_HUB_AGENT_NAME: name,
        },
      },
    },
  };
}

export function writeNewConfig(destination, config) {
  // Exclusive create also protects against a race after an existence check.
  writeFileSync(path.resolve(destination), `${JSON.stringify(config, null, 2)}\n`, {
    flag: "wx",
    mode: 0o600,
  });
}

if (process.argv[1] && pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url) {
  try {
    const args = process.argv.slice(2);
    const options = {};
    let destination;
    const names = {
      "--agent-name": "agentName",
      "--hub-url": "hubUrl",
      "--project-id": "projectId",
    };
    for (let index = 0; index < args.length; index += 2) {
      const flag = args[index];
      const value = args[index + 1];
      if (!value || value.startsWith("--") || (flag !== "--output" && !Object.hasOwn(names, flag)))
        throw new Error(
          "Uso: pnpm mcp:config [--agent-name nombre] [--hub-url URL] [--project-id UUID] [--output archivo-nuevo]",
        );
      if (flag === "--output") destination = value;
      else options[names[flag]] = value;
    }
    const config = createMcpConfig(options);
    if (destination) {
      try {
        writeNewConfig(destination, config);
      } catch {
        throw new Error(
          "No se creó el archivo. El destino debe ser nuevo, con carpeta existente y acceso de escritura; no se sobrescriben configuraciones.",
        );
      }
      console.log(
        "Plantilla creada con credencial de ejemplo. Revisa el formato de tu cliente antes de usarla.",
      );
    } else console.log(JSON.stringify(config, null, 2));
  } catch (error) {
    console.error(
      error instanceof Error && !/(?:ah_|ahi_|wst_|sk-)|Bearer/i.test(error.message)
        ? error.message
        : "No se pudo generar la plantilla. Revisa los argumentos sin incluir credenciales.",
    );
    process.exitCode = 1;
  }
}
