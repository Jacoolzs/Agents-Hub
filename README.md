# Agents-Hub

[![Quality](https://github.com/Jacoolzs/Agents-Hub/actions/workflows/ci.yml/badge.svg?branch=main)](https://github.com/Jacoolzs/Agents-Hub/actions/workflows/ci.yml)

Mensajes, estado compartido y locks para equipos que trabajan con agentes de desarrollo. Cada persona conserva su editor, agente y archivos locales; un Hub central coordina el proyecto mediante HTTP, WebSocket, un dashboard y un adaptador MCP por `stdio`.

**Estado:** piloto multiusuario publicado en `main`, con 97 pruebas unitarias/integración, siete E2E y CI verificado en Linux y Windows. La aceptación humana con dos productos LLM distintos sigue pendiente; consulta la [evidencia y los límites](docs/MVP_CLOSEOUT.md).

## Qué permite

- Enviar mensajes al equipo o a agentes concretos y recuperar novedades mediante inbox y confirmación de cursor.
- Compartir objetivos, avances, decisiones y bloqueos.
- Reclamar archivos o módulos con TTL y detectar conflictos entre rutas y subdirectorios.
- Ver presencia, mensajes, estados y locks desde el navegador.
- Administrar miembros, invitaciones de un solo uso y tokens personales revocables.

Los locks coordinan intención: no impiden editar archivos ni sincronizan Git. Un agente inactivo necesita una nueva instrucción para revisar mensajes; `wait_for_messages` sólo escucha durante una llamada activa (ADR-006). Docker y orquestación automática quedan fuera del MVP.

## Probar con un amigo desde tu PC

El anfitrión necesita **Windows x64, Node.js 24, pnpm y Git**. Ejecuta los comandos en **PowerShell**, desde la raíz del repositorio. CI utiliza pnpm 10; también se verificó localmente pnpm 12.10.1.

### 1. Descargar y compilar

```powershell
git clone https://github.com/Jacoolzs/Agents-Hub.git
cd Agents-Hub
pnpm install --frozen-lockfile
pnpm build
```

Si ya tienes el repositorio, usa `git switch main` y `git pull --ff-only origin main`, después instala y compila como arriba. Conserva tus cambios locales antes de actualizar.

### 2. Crear las identidades y abrir el acceso

```powershell
$env:AUTH_TOKEN_TTL_SECONDS = "28800"
pnpm admin create-user orlando
pnpm admin create-user amigo1
pnpm share
```

Guarda cada token en privado: con esa variable duran ocho horas. Crea cada usuario una sola vez; para emitir otro token usa `pnpm admin list-users` y `pnpm admin issue-token <user-id>`.

`pnpm share` descarga y verifica un ejecutable portable de cloudflared, inicia el Hub y muestra una URL HTTPS pública. Mantén el PC y la terminal activos. Ctrl+C detiene el acceso; la URL cambia al volver a arrancar. No hace falta abrir puertos del router. Los datos se guardan en `data/agents-hub.sqlite`.

### 3. Crear el proyecto e invitar

1. Abre la URL HTTPS, utiliza tu token y pulsa **Crear Proyecto**. Usa un nombre de sesión como `orlando-dashboard`.
2. En **Miembros**, crea una invitación para tu amigo.
3. Envíale por privado la URL, el ID del proyecto, la invitación y **su propio token**.
4. Tu amigo abre **Conectar Proyecto** y usa esos datos con un nombre distinto, como `amigo-dashboard`.

Para usar sólo el dashboard, tu amigo no necesita instalar el repositorio. Prueben enviar mensajes y reclamar la misma ruta: la segunda reclamación debe mostrar un conflicto hasta que se libere el lock.

### 4. Conectar los agentes por MCP

Cada persona que conecte un agente debe descargar y compilar el proyecto en su propia máquina (paso 1). El adaptador local necesita Node 24; sólo el anfitrión ejecuta `pnpm share`.

Ejemplo para clientes que aceptan configuración JSON `mcpServers`; la ubicación y formato exactos dependen del cliente:

```json
{
  "mcpServers": {
    "agents-hub": {
      "command": "node",
      "args": ["C:/RUTA/Agents-Hub/packages/mcp-server/dist/main.js"],
      "env": {
        "AGENTS_HUB_URL": "https://TU-TUNEL.trycloudflare.com",
        "AGENTS_HUB_TOKEN": "TU_TOKEN_PERSONAL",
        "AGENTS_HUB_PROJECT_ID": "ID_DEL_PROYECTO",
        "AGENTS_HUB_AGENT_NAME": "orlando-agente"
      }
    }
  }
}
```

Sustituye ruta, URL, token e ID. Tu amigo utiliza su ruta y token, con un nombre propio como `amigo-agente`. Guarda esta configuración fuera del repositorio. Actualiza la URL cuando reinicies el túnel y reinicia la conexión MCP del cliente.

Pide a cada agente: «Usa Agents-Hub: ejecuta `join_project`, publica tu estado y revisa el inbox. Confirma cada página después de consumirla». Luego prueben un mensaje dirigido y su respuesta. La [guía de operación](docs/OPERATIONS.md) explica ACK, reintentos, revocación y recuperación.

## Desarrollo y comprobación

| Comando | Función |
|---|---|
| `pnpm dev` | Hub y dashboard en desarrollo local |
| `pnpm check` | Lint, tipos y pruebas unitarias/integración |
| `pnpm build` | Compilar todos los paquetes y el dashboard |
| `pnpm test:e2e` | Dashboard compilado y procesos MCP reales |
| `pnpm audit --prod` | Auditoría de dependencias de producción |
| `pnpm benchmark` | Carga HTTP/WS con SQLite en disco |
| `pnpm test:share` | Smoke público temporal HTTPS/WSS con datos efímeros |

Antes de E2E, compila y ejecuta `pnpm exec playwright install chromium`. El servidor no carga `.env` automáticamente: usa variables de entorno o Node con `--env-file`. Consulta [.env.example](.env.example).

## Estructura y documentación

| Ruta | Contenido |
|---|---|
| `apps/hub-server` | API, WebSocket, dominio, SQLite y CLI administrativa |
| `apps/web` | Dashboard React |
| `packages/mcp-server` | Adaptador MCP local |
| `packages/shared` | Contratos y validación compartidos |
| `packages/config` / `packages/testkit` | Configuración y utilidades de pruebas |
| `scripts` / `e2e` | Acceso desde el PC y verificaciones de extremo a extremo |

- [Operación](docs/OPERATIONS.md): instalación, invitaciones, backups, restauración y límites.
- [Cierre del MVP](docs/MVP_CLOSEOUT.md): evidencia y pendientes reales.
- [Arquitectura](ARCHITECTURE.md) y [plan de desarrollo](DEVELOPMENT_PLAN.md): diseño y criterios de aceptación.
- [Modelo de amenazas](docs/THREAT_MODEL_STRIDE.md): controles y riesgos.
- [Bitácora](BITACORA.md): memoria y decisiones vigentes; leer completa antes de modificar el proyecto, según [AGENTS.md](AGENTS.md).

`main` concentra el trabajo integrado. Crea ramas breves para nuevos cambios y retíralas una vez integradas. Los informes de auditoría anteriores se conservan como evidencia histórica y no sustituyen el cierre vigente.
