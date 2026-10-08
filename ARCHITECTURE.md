# Agents-Hub — propósito, arquitectura y plan

Estado: diseño base del MVP · Fecha: 2026-10-07

La ejecución detallada, paso a paso, está en [DEVELOPMENT_PLAN.md](DEVELOPMENT_PLAN.md). Ese documento debe seguirse por fases y complementa las decisiones arquitectónicas de este archivo.

## 1. Propósito

Agents-Hub es una capa de coordinación para equipos humanos que usan agentes de desarrollo distintos. Cada desarrollador conserva su terminal, workspace y agente; Agents-Hub aporta una sala compartida con mensajes, estado estructurado, decisiones, bloqueos temporales y entregas verificables.

El producto no crea un modelo de IA propio ni sustituye al agente de programación. Su valor es convertir la colaboración entre agentes en eventos estructurados, trazables y seguros.

### Resultado que debe demostrar el MVP

Dos agentes independientes, ejecutándose en dos terminales locales, pueden:

1. conectarse al mismo proyecto;
2. publicar y leer mensajes dirigidos;
3. informar objetivo, estado, decisión y bloqueo;
4. reclamar y liberar archivos o módulos con expiración;
5. recuperar mensajes perdidos mediante un cursor;
6. colaborar sin compartir razonamiento interno crudo ni pisarse intencionalmente.

Fuera del MVP quedan la asignación autónoma de tareas, sincronización de archivos, merge automático, ejecución Docker, P2P, marketplace y soporte profundo específico de cada CLI.

## 2. Principios no negociables

- **Humano en control:** el agente no ejecuta acciones destructivas, publica secretos ni integra código por sí solo.
- **Comunicación estructurada:** se comparten resúmenes, decisiones, contratos, bloqueos y resultados; no se exige ni se almacena Chain of Thought privado.
- **MCP como adaptador, no como backend:** MCP expone capacidades al agente; el Hub mantiene identidad, estado, autorización y eventos.
- **Entrega fiable antes que tiempo real:** cada evento tiene ID, secuencia y cursor; WebSocket acelera la visualización, pero el inbox es la fuente de recuperación.
- **Aislamiento por proyecto:** ningún usuario, agente, mensaje, lock o evento puede cruzar proyectos sin autorización explícita.
- **Seguridad por defecto:** mínimo privilegio, credenciales revocables, validación de entrada, límites de tamaño y auditoría de acciones sensibles.
- **Evolución incremental:** un proceso y una base de datos en el MVP; separar servicios sólo cuando exista una presión medible.
- **Evidencia sobre entusiasmo:** una decisión se acepta con una razón y un criterio de validación; las hipótesis permanecen marcadas como tales.

## 3. Arquitectura lógica

```text
┌───────────────────────────────┐
│ Agente: Claude/Cursor/Aider   │
└───────────────┬───────────────┘
                │ MCP stdio (local)
┌───────────────▼───────────────┐
│ team-hub-mcp local            │  identidad local, validación, retry
└───────────────┬───────────────┘
                │ HTTPS API + WebSocket de eventos
┌───────────────▼───────────────┐
│ Hub Server                    │  auth, rooms, comandos, locks, inbox
│  ├─ API / MCP gateway         │
│  ├─ Event service              │
│  ├─ Policy + audit             │
│  └─ Persistence                │
└───────────────┬───────────────┘
                │
┌───────────────▼───────────────┐
│ Dashboard web                 │  humanos: chat, estado, locks, auditoría
└───────────────────────────────┘
```

### Componentes

**`team-hub-mcp` local.** Se ejecuta como servidor MCP iniciado por el cliente mediante `stdio` utilizando `@modelcontextprotocol/sdk` v1.x (lockfile actual: 1.32.1). No expone un puerto público ni recibe conexiones entrantes. Traduce las llamadas de herramientas a solicitudes autenticadas al Hub, aplica timeouts y no imprime logs en `stdout`.

**Hub Server.** Es la única autoridad para proyectos, miembros, agentes, mensajes, presencia, locks y secuencias de eventos. El MVP puede ejecutarse como un proceso Node.js/TypeScript con módulos internos separados.

**Persistencia.** SQLite con WAL mediante `node:sqlite` nativo de Node 24 (`DatabaseSync`) para desarrollo y primera instalación de un solo nodo (evitando toolchains nativos C++ en Windows). Todos los servicios de aplicación usan interfaces y adaptadores SQLite con una unidad de trabajo síncrona compartida; autorización se consume por un puerto y el adaptador HTTP compone las implementaciones. Autenticación, CLI y algunas rutas todavía acceden directamente a SQL y requieren completar separación por responsabilidades. Redis no es requisito del MVP.

**Dashboard.** Cliente web que consume una API autenticada y un canal WebSocket sólo para eventos de presentación. Nunca es la autoridad de permisos ni de locks.

## 4. Flujo de comunicación y recepción

La solución inicial para el problema de agentes inactivos es híbrida:

- `check_inbox(cursor?)` es obligatorio al conectar, antes de iniciar trabajo y después de completar un paso relevante.
- `wait_for_messages(timeout)` es opcional durante una sesión activa cuando el agente está esperando coordinación.
- Un daemon que inyecte prompts en el CLI queda fuera del MVP por su acoplamiento y riesgos operativos.

El servidor guarda los eventos aunque ningún agente esté conectado. El cliente local mantiene el último cursor confirmado. Al reconectar solicita los eventos posteriores; las respuestas repetidas deben ser inocuas mediante `event_id` e idempotencia.

ADR-021 limita a una instancia vigente por proyecto/nombre de agente. Un UUID interno estable permite repetir join; otro proceso recibe conflicto. Tras desconexión/vencimiento se rota session_id y se conserva checkpoint, invalidando llamadas/tickets de la generación anterior. [Contrato de sesiones](docs/SESSIONS.md).

## 5. Contrato de dominio inicial

Entidades: `User`, `Project`, `Membership`, `AgentSession`, `Message`, `StatusReport`, `WorkspaceLock`, `Event`, `AuditEntry`.

Tipos de evento mínimos:

- `agent.joined` / `agent.heartbeat` / `agent.left`
- `message.created`
- `status.updated`
- `lock.acquired` / `lock.released` / `lock.expired`

Cada evento incluye `event_id`, `project_id`, `type`, `actor_id`, `occurred_at`, `sequence`, `payload_version` y un payload validado por esquema. Los mensajes deben admitir destinatario, canal, prioridad, correlación y expiración opcional.

Herramientas MCP del MVP:

1. `join_project` — registrar la sesión del agente en un proyecto autorizado.
2. `check_inbox` — obtener eventos/mensajes desde un cursor.
3. `send_team_message` — enviar mensaje al canal o agentes mencionados.
4. `report_status` — publicar objetivo, avance, decisión y bloqueo.
5. `claim_module_lock` — reclamar rutas normalizadas con TTL.
6. `release_module_lock` — liberar sólo locks propios o autorizados.
7. `get_team_status` — consultar presencia, estados y locks visibles.
8. `ack_inbox` — confirmar explícitamente una página ya consumida.
9. `wait_for_messages` — espera activa acotada y cancelable.
10. `get_inbox_recovery` — revisar snapshot autorizado tras vencer el cursor.
11. `resync_inbox` — aceptar pérdida de historial y reanudar sin confirmar la nueva página.
12. `renew_module_lock` — renovar explícitamente un lock activo autorizado con TTL y clave idempotente.

La validación completa de inputs/outputs es un requisito del diseño. El adaptador valida inputs y respuestas de mutaciones/inbox/snapshot con schemas compartidos; no se afirma cobertura exhaustiva de todas las salidas ni payloads de eventos. El servidor no confía en nombres enviados por el cliente para autorizar: usa IDs y pertenencia verificada. [Inventario vigente](docs/API_CONTRACT.md) detalla rutas, scopes, errores y límites; [recuperación](docs/RECOVERY.md) especifica ADR-020.

## 6. Seguridad

### Identidad y autorización

- Cada solicitud se asocia a un usuario, proyecto y sesión de agente.
- El MVP puede usar invitaciones de un solo uso y tokens de corta duración; se almacenan hashes, nunca tokens en claro.
- Las acciones se autorizan por proyecto y rol (`owner`, `maintainer`, `collaborator`, `reader`) intersectado con scopes del token.
- Los tokens deben ser revocables, tener audiencia explícita para Agents-Hub y nunca reenviarse a servicios externos.
- La futura autenticación web puede usar OAuth/OIDC; no se inventa un protocolo de autenticación propio.

### Transporte y datos

- Producción sólo por HTTPS/WSS; el transporte/proxy debe configurar HSTS. El dashboard vigente mantiene tokens en memoria; cookies `Secure`, `HttpOnly`, `SameSite` y protección CSRF son requisitos si se adopta sesión web persistente, aún pendiente de ADR.
- Validar `Origin` en conexiones HTTP/WebSocket y rechazar orígenes no permitidos.
- El servidor local se limita a `127.0.0.1` cuando exponga HTTP local.
- Cifrar secretos en reposo cuando se añadan credenciales persistentes; nunca registrar tokens, prompts privados ni variables de entorno.
- Retención configurable: mensajes/eventos limitados por proyecto; el usuario puede eliminar o exportar datos propios cuando corresponda.

### Defensa operacional

- Validación estricta de esquemas, límites de payload, rate limits por usuario/agente/IP y límites de conexiones.
- Normalizar rutas de locks y rechazar traversal, rutas absolutas ambiguas y comodines no soportados.
- Locks con propietario, TTL, renovación explícita y limpieza por mantenimiento; heartbeat no renueva locks. Nunca son una garantía de integridad de Git.
- Confirmación humana para acciones futuras como push, merge, comandos destructivos o ejecución de herramientas.
- Auditoría de login, invitaciones, cambios de membresía, locks, mensajes borrados y acciones sensibles.
- Pruebas de autorización negativas: un agente de proyecto A no puede leer ni escribir datos del proyecto B.

## 7. Rendimiento y resiliencia

- Operaciones normales O(1) o indexadas por `project_id`, `sequence`, destinatario y expiración.
- Inbox y [historial de mensajes](docs/MESSAGE_HISTORY.md) usan cursores distintos: el primero gobierna consumo/ACK y el segundo sólo navegación paginada autorizada.
- WebSocket sólo distribuye eventos compactos; el cliente pide detalle bajo demanda.
- Backpressure: límites por conexión, cola máxima y desconexión controlada de consumidores lentos.
- Reintentos con backoff y jitter sólo para operaciones idempotentes.
- Health/readiness checks, métricas de latencia, tasa de errores, conexiones activas, tamaño de inbox y locks expirados.
- Objetivo inicial, a validar: 100 agentes conectados y 20 eventos/segundo en una instancia local sin degradación visible. No es un SLA de producción.

## 8. Estructura propuesta del monorepo

```text
apps/
  hub-server/       # API, WebSocket, dominio y persistencia
  web/              # dashboard humano
packages/
  mcp-server/       # servidor MCP local por stdio
  shared/           # esquemas, tipos, errores y eventos versionados
  config/           # configuración común y validación de entorno
  testkit/          # fixtures y harness de dos agentes
infra/
  migrations/       # migraciones SQLite/PostgreSQL
docs/
  ARCHITECTURE.md
  adr/
BITACORA.md
AGENTS.md
```

## 8.1 Stack tecnológico decidido

| Capa | Tecnología | Motivo y límite |
|---|---|---|
| Lenguaje | TypeScript 5.9.x, `strict: true` | Versión efectiva del lockfile; tipos compartidos entre Hub, MCP y web. |
| Runtime | Node.js 24.x Active LTS | Línea estable para producción; no se usa Node Current como runtime principal. |
| Monorepo | pnpm workspaces | Dependencias y paquetes internos simples; no añadimos Turborepo hasta tener una necesidad de cache/build distribuido. |
| MCP | `@modelcontextprotocol/sdk` v1.x | ADR-012; SDK oficial, servidor local por `stdio`. |
| Validación | Zod 3.25.x | Versión efectiva del lockfile; validación en límites y contratos compartidos. |
| Hub HTTP | Fastify 5 | Bajo overhead, plugins maduros y buen soporte TypeScript. |
| Eventos | `@fastify/websocket` sobre `ws` | Canal de presencia/UI; no reemplaza el inbox persistente ni la recuperación por cursor. |
| Persistencia MVP | SQLite + WAL con `node:sqlite` | ADR-011; evita toolchain C++ en Windows. |
| Migraciones | SQL versionado en el repositorio | Sin nueva dependencia; upgrades transaccionales. |
| Dashboard | React + Vite + Tailwind CSS | UI rápida y pequeña, sin introducir SSR ni complejidad de Next.js para el MVP. |
| Estado web | TanStack Query + estado local de React | Cache de API; WebSocket invalida/actualiza consultas, no se duplica la lógica del dominio. |
| Pruebas unitarias/integración | Vitest | Tests rápidos para dominio, repositorios, API y protocolo de inbox. |
| Pruebas E2E | Playwright, Chromium primero | Flujo humano completo del dashboard; Firefox/WebKit se añaden si aparece una necesidad real. |
| Logs | Pino, JSON estructurado | Bajo overhead; redacción obligatoria de tokens, secretos y contenido privado sensible. |
| Calidad | Biome + `tsc --noEmit` | Formato y lint rápidos, más verificación estricta del compilador. |
| CI | GitHub Actions | `pnpm install --frozen-lockfile`, lint, typecheck, tests, build y auditoría de dependencias. |
| Desarrollo local | Node directo + SQLite local | Docker no es requisito para desarrollar ni ejecutar el MVP. |
| Producción inicial | Un proceso Node detrás de Caddy/Nginx con TLS y volumen persistente | Sencillo para validar; PostgreSQL y varias réplicas sólo después de medir límites. |

### Reglas de versionado tecnológico

- Usar Node 24 LTS como baseline; no usar APIs disponibles sólo en Node Current.
- Commitear `pnpm-lock.yaml` y usar `--frozen-lockfile` en CI.
- Mantener dependencias directas mínimas; cada nueva dependencia debe justificar seguridad, mantenimiento y tamaño.
- Actualizar por lotes pequeños, con changelog, tests y revisión de vulnerabilidades.
- Separar la compatibilidad del SDK MCP de la lógica de negocio para poder seguir cambios de protocolo.
- No introducir Redis, Kafka, Kubernetes, microservicios ni Docker sandboxing antes de una métrica que justifique su coste.

## 9. Plan de ejecución

La numeración vigente es la de `DEVELOPMENT_PLAN.md`: 0 bootstrap, 1 contratos, 2 dominio/SQLite, 3 HTTP/WebSocket, 4 MCP, 5 dashboard, 6 seguridad/rendimiento/operación. El esquema siguiente se conserva sólo como resumen histórico y no determina el orden de implementación.

### Etapa histórica 0 — Contratos y seguridad mínima

Definir esquemas de eventos, errores, identidad local, roles, cursor e idempotencia. Añadir lint, format, tests, validación de configuración y documentación de amenazas.

### Etapa histórica 1 — Hub mínimo

Implementar proyecto/membresía, mensajes persistentes, inbox por cursor, estado de agente y locks TTL. Probar API con dos clientes simulados.

### Etapa histórica 2 — MCP local

Implementar las siete herramientas, conexión `stdio`, retries, reconexión y recuperación desde cursor. Probar con dos procesos MCP locales y un Hub local.

### Etapa histórica 3 — Dashboard mínimo

Mostrar mensajes, presencia, estados, locks y errores de conexión. La UI no añade permisos propios ni lógica duplicada del dominio.

### Etapa histórica 4 — Seguridad y validación de uso

Invitaciones revocables, TLS de despliegue, rate limiting, auditoría, pruebas de aislamiento y una sesión real con dos agentes distintos. Medir rendimiento antes de optimizar.

### Etapa histórica 5 — Después del MVP

Evaluar tareas/dependencias, integración Git, sandbox Docker, notificaciones activas y adaptadores específicos de CLI sólo si la evidencia del MVP lo justifica.

## 10. Criterios de terminado del MVP

- Dos agentes completan una colaboración reproducible sin intervención del dashboard.
- Un agente desconectado recupera mensajes al reconectar sin duplicados funcionales.
- Un lock expirado se libera automáticamente y un lock ajeno no puede liberarse.
- Las pruebas demuestran aislamiento entre proyectos y rechazo de inputs inválidos.
- No se almacenan pensamientos privados crudos ni secretos en logs.
- La bitácora documenta resultados, límites y decisiones pendientes.
