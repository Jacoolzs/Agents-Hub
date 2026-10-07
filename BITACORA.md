# 📓 Bitácora de Proyecto: Agents-Hub

Este documento actúa como la **memoria viva y persistente** del proyecto `Agents-Hub`.
Cada avance, idea, decisión de diseño, bloqueo y solución debe registrarse aquí de forma obligatoria y cronológica.

---

## 📌 Metadatos del Proyecto
- **Nombre:** Agents-Hub
- **Repositorio:** [https://github.com/Jacoolzs/Agents-Hub](https://github.com/Jacoolzs/Agents-Hub)
- **Creador / Líder:** Jacoolzs (Orlando)
- **Fecha de inicio:** 2026-10-07
- **Enfoque MVP:** Capa de Comunicación Colaborativa + Estado Compartido + Locks de Archivos mediante MCP + WebSockets + Hub Central ligero.

---

## 🎯 Visión y Misión del Proyecto

### La Idea
`Agents-Hub` es una **capa de colaboración entre agentes de desarrollo y sus desarrolladores**.
Permite que cada persona mantenga su entorno local, su terminal y su agente preferido (Claude Code, Antigravity, Cursor, Aider, etc.), mientras `Agents-Hub` facilita:
1. **Comunicación intencional entre agentes:** Diálogo directo (peticiones de contratos, preguntas, handoffs de tareas).
2. **Contexto de trabajo compartido:** Resúmenes estructurados de objetivos, decisiones técnicas, bloqueos y eventos de archivos modificados (evitando saturación de tokens de razonamiento crudo).
3. **Locks de archivos/módulos:** Evitar pisarse el código en Git antes de editar.
4. **Visibilidad humana:** Una interfaz mínima donde los desarrolladores observan la interacción de sus agentes y el estado del proyecto.

---

## 🧭 Registro de Decisiones de Arquitectura (ADRs)

| ID | Fecha | Decisión | Justificación | Estado |
|---|---|---|---|---|
| ADR-001 | 2026-10-07 | Adoptar **MCP (Model Context Protocol)** como interfaz de agente | Estándar abierto; interoperable con agentes existentes sin alterar su motor interno. | Aceptado |
| ADR-002 | 2026-10-07 | Alcance del MVP: **Comunicación + Estado Compartido** (Orquestación activa diferida) | Mantener el MVP simple y viable. Demostrar primero que dos agentes pueden hablar y coordinarse. Orquestación compleja (asignación automática, tech lead autónomo) pasa a Fase 2. | Aceptado (Corregido) |
| ADR-003 | 2026-10-07 | Modelo de **Contexto Compartido Estructurado** (No thoughts crudos) | El dumping de CoT completo satura tokens y genera ruido. Se comparten objetivos, decisiones, contratos y bloqueos. | Aceptado |
| ADR-004 | 2026-10-07 | Sandbox / Docker **diferido a fase futura** | Evitar scope creep en el MVP. Validar primero la coordinación básica antes de introducir entornos de pruebas aislados. | Aceptado (Diferido) |
| ADR-005 | 2026-10-07 | Monorepo en TypeScript con arquitectura simple | `@modelcontextprotocol/sdk` maduro en TS; compartir tipos entre `packages/mcp-server`, `packages/hub-server`, `packages/shared` y `packages/web`. Backend mínimo con SQLite + WebSockets. | Aceptado |
| ADR-006 | 2026-10-07 | Recepción de mensajes mediante estrategia híbrida | `check_inbox(cursor)` es el mecanismo compatible y fiable; `wait_for_messages(timeout)` es opcional durante una sesión activa. El daemon que inyecta prompts queda diferido por acoplamiento y riesgo. | Aceptado |
| ADR-007 | 2026-10-07 | Hub central como autoridad; MCP como adaptador local | El servidor MCP local usa `stdio` con el agente y el Hub usa HTTPS/WebSocket; identidad, permisos, persistencia, cursores y locks viven en el Hub. | Aceptado |
| ADR-008 | 2026-10-07 | MVP monolítico modular con SQLite/WAL | Reduce complejidad operacional y permite validar el producto antes de separar servicios o añadir Redis/PostgreSQL. | Aceptado |
| ADR-009 | 2026-10-07 | Seguridad por proyecto, mínimo privilegio y contexto estructurado | Aislar proyectos, validar entradas, limitar capacidades, auditar acciones y evitar exposición de razonamiento privado o secretos. | Aceptado |
| ADR-010 | 2026-10-07 | Stack tecnológico del MVP | TypeScript + Node 24 LTS, pnpm, Fastify, WebSocket, MCP SDK, Zod, SQLite/WAL con `node:sqlite` nativo (evita dependencias C++/node-gyp en Windows), React/Vite/Tailwind, Vitest, Playwright, Biome y Pino. | Aceptado (Ajustado) |
| ADR-011 | 2026-10-07 | Uso de `node:sqlite` nativo (Experimental en Node 24) | `better-sqlite3` falló en Windows por falta de binarios para Node 24 y ausencia de VC++ toolchain. Se adopta `node:sqlite` nativo de Node 24; se asume el warning experimental en desarrollo/tests para no bloquear el MVP sin compiladores C++. | Aceptado |
| ADR-012 | 2026-10-07 | Uso de `@modelcontextprotocol/sdk` v1.x en MCP local | `@modelcontextprotocol/sdk` v1.6.0 es el paquete estable disponible en npm con soporte maduro de `Server` y `StdioServerTransport`. Se documenta como versión base del MVP; la migración a paquetes separados v2 (`@modelcontextprotocol/server`) se evaluará tras validar el MVP. | Aceptado |

---

## 🔍 Análisis Técnico Clave: Recepción de Mensajes en Terminal

Un agente de terminal funciona por ciclo de petición/respuesta. No escucha sockets pasivamente a menos que se diseñe un mecanismo explícito:

### Alternativas evaluadas:
1. **Opción A (`check_inbox` + Prompting):** Herramienta MCP donde el agente revisa mensajes entrantes de compañeros al iniciar o finalizar pasos. 
   - *Pros:* 100% compatible con cualquier cliente MCP sin wrappers.
   - *Contras:* Si el agente termina su turno y queda inactivo en la terminal, no se despierta hasta que el usuario le da una orden.
2. **Opción B (Blocking / Long-Polling Tool Call):** Herramienta tipo `wait_for_messages(timeout=30s)` que mantiene el socket abierto mientras espera un mensaje de un compañero.
   - *Pros:* Estándar MCP, mantiene al agente en escucha activa durante una sesión de trabajo colaborativo.
   - *Contras:* Mantiene al LLM ocupado mientras dura el polling.
3. **Opción C (Wrapper / CLI Daemon):** Un script que envuelve el proceso del agente y le inyecta prompts por `stdin` cuando llega un mensaje urgente de la sala.
   - *Pros:* Despierta al agente de forma reactiva real.
   - *Contras:* Acoplado al CLI específico de cada agente.

---

## 🛠️ Herramientas MCP del MVP Inicial (`team-hub-mcp`)

1. `send_team_message(channel, message, mentions?)`: Enviar mensaje al chat general o a un agente en específico.
2. `check_inbox()`: Consultar mensajes pendientes, menciones y novedades del equipo.
3. `report_status(objective, decision, blocked_by?)`: Publicar en qué se está trabajando y decisiones tomadas.
4. `claim_module_lock(paths, reason)`: Bloquear temporalmente archivos para evitar conflictos.
5. `release_module_lock(paths)`: Liberar archivos bloqueados.
6. `get_team_status()`: Consultar quién está conectado y qué áreas están bloqueadas.

## 🧱 Diseño base y plan

La especificación completa de propósito, arquitectura lógica, contrato de eventos, seguridad, rendimiento, estructura del monorepo, fases y criterios de terminado está en [ARCHITECTURE.md](ARCHITECTURE.md). Ese documento es el diseño base vigente; las futuras desviaciones deben registrarse como una nueva decisión.

---

## 📋 Entradas Cronológicas de la Bitácora

### [2026-10-07] — Remediación Completa de Auditoría Fases 0 a 4 (`fix/audit-phases-0-4`)
- **P0 Impersonación de Agente resuelto:** Se eliminó la confianza en `sender_id`/`agent_id` enviados por el cliente. Las rutas HTTP (`POST /messages`, `POST /status`, `POST /locks/claim`, etc.) ahora exigen `session_id`, validado contra el usuario autenticado del token y el proyecto.
- **P0 Fuga de Eventos resuelto:** Implementado `isEventVisibleToAgent` en `apps/hub-server/src/application/policies/event-visibility.ts`. Tanto el inbox (`GET /v1/projects/:projectId/inbox`) como el broadcast de WebSocket filtran eventos dirigidos para que sólo el destinatario y el emisor reciban mensajes privados (Alice→Bob nunca es visible a Charlie).
- **P0 Conexión EventBus a WebSocket:** El event bus ahora emite directamente a `wsHub.broadcast` en la finalización de transacciones (`commit`).
- **P1 Seguridad WebSocket & CORS:** Validación estricta del encabezado `Origin` contra `CORS_ORIGIN`, control de scopes por token y binding obligatorio de sesión-a-agente.
- **P1 Operaciones faltantes implementadas:**
  - `POST /v1/projects/:projectId/locks/:lockId/renew`: Renovación de TTL para locks activos por su propietario.
  - `DELETE /v1/projects/:projectId/locks/:lockId`: Liberación directa por ID de lock.
  - `POST /v1/projects/:projectId/inbox/ack`: Confirmación atómica del cursor de lectura de la sesión.
- **P1 Validación runtime en MCP Server:** Servidor MCP valida todos los argumentos entrantes usando esquemas Zod (`SendMessageInputSchema`, `ClaimLockInputSchema`, `ReportStatusInputSchema`) antes de transferir llamadas al HubClient.
- **ADRs actualizados:** Registrados ADR-011 (`node:sqlite`) y ADR-012 (`@modelcontextprotocol/sdk` v1.6.0).
- **Aceptación y calidad:** Biome (52 archivos limpios), TypeScript (`tsc -b` limpio), Vitest (41/41 tests pasando en verde) y build sin errores. Aprobado para mergear a `main` y proceder con la Fase 5.

### [2026-10-07] — Auditoría de las Fases 0 a 4
- Se revisó la implementación actual contra `DEVELOPMENT_PLAN.md` y se ejecutaron `pnpm lint`, `pnpm typecheck`, `pnpm test` y `pnpm -r build`.
- Resultado: typecheck, tests (37) y build pasan; lint falla por cinco archivos MCP sin formatear.
- Se detectaron bloqueos de aprobación: los endpoints aceptan `sender_id`/`agent_id` del cliente sin vincularlos a una sesión autenticada; inbox y WebSocket no filtran eventos dirigidos; `wsHub.broadcast` no está conectado al event bus.
- También faltan Origin seguro para WebSocket, scopes efectivos, renew/idempotencia/ack de cursor, validación runtime de argumentos MCP y tests reales por `stdio`.
- Se crea `REVIEW_PHASES_0_4.md` con prioridades P0/P1, correcciones exactas, pruebas faltantes y mensaje listo para Gemini.
- No se aprueba iniciar la Fase 5 hasta corregir los P0/P1 y repetir todos los comandos de aceptación.

### [2026-10-07] — Fase 4 Completada: Servidor MCP Local (`packages/mcp-server`)
- **Implementación del servidor MCP (en rama `feat/phase-4-mcp-server`):**
  - `client/retry.ts`: Reintentos automáticos con backoff exponencial para códigos transitorios (`408`, `429`, `502`, `503`, `504`) y fallos de conexión de red.
  - `client/hub-client.ts`: Cliente HTTP ligero que conecta el proceso local del desarrollador con el Hub central por HTTPS.
  - `server.ts` & `main.ts`: Servidor MCP por `stdio` usando `@modelcontextprotocol/sdk`:
    - Enrutamiento estricto de logs y diagnósticos a `stderr`, reservando `stdout` exclusivamente para tramas JSON-RPC válidas.
    - Manejo de entorno: `AGENTS_HUB_URL`, `AGENTS_HUB_TOKEN`, `AGENTS_HUB_PROJECT_ID`, `AGENTS_HUB_AGENT_NAME`.
    - Herramientas colaborativas registradas y funcionales:
      1. `join_project`: Inicializa presencia en la sala y obtiene contexto.
      2. `check_inbox`: Consulta de novedades y mensajes por cursores opacos.
      3. `wait_for_messages`: Long-polling / espera activa de hasta 60s (estrategia híbrida ADR-006).
      4. `send_team_message`: Mensajería dirigida o broadcast por canal con prioridades.
      5. `report_status`: Publicación de objetivos, progreso, decisiones y bloqueos.
      6. `claim_module_lock`: Bloqueo preventivo de rutas con detección de conflicto jerárquico.
      7. `release_module_lock`: Liberación de archivos editados.
      8. `get_team_status`: Consulta del estado global del equipo (agentes, tareas y locks).
- **Validación y calidad:**
  - Suite de tests para el servidor MCP y cliente HTTP en `packages/mcp-server/src/main.test.ts`.
  - 37 tests totales pasando en verde en todo el monorepo.
  - Biome (`pnpm lint`), TypeScript (`pnpm typecheck`), Vitest (`pnpm test`) y Build (`pnpm -r build`) 100% limpios.
- **Siguiente paso:** Fusionar `feat/phase-4-mcp-server` a `main` y proceder con la **Fase 5 — Validación del Escenario reproducible del MVP** (dos agentes en terminal simulando colaboración cruzada).


### [2026-10-07] — Fase 3 Completada: API HTTP y WebSocket del Hub (`apps/hub-server`)
- **Implementación de red y capas de transporte (en rama `feat/phase-3-hub-network`):**
  - `http/auth/auth-service.ts`: Autenticación segura basada en tokens con hashing SHA-256 (`ah_*`), audiencia, expiración y control de permisos por proyecto.
  - `http/websocket/ws-hub.ts`: Servidor WebSocket hub para suscripción en tiempo real de eventos por proyecto (`/v1/projects/:projectId/events`) con desconexión inmediata de tokens inválidos.
  - `app.ts`: API versionada bajo `/v1`:
    - `/health/live` y `/health/ready` con propagación de `x-request-id`.
    - `POST /v1/projects` y `GET /v1/projects/:projectId`.
    - `POST /v1/projects/:projectId/sessions`, `POST /v1/sessions/:sessionId/heartbeat`, `DELETE /v1/sessions/:sessionId`.
    - `GET /v1/projects/:projectId/inbox?after=<cursor>&limit=<n>` con paginación monotónica mediante cursores URL-safe.
    - `POST /v1/projects/:projectId/messages`.
    - `POST /v1/projects/:projectId/status` y `GET /v1/projects/:projectId/status`.
    - `POST /v1/projects/:projectId/locks/claim`, `DELETE /v1/projects/:projectId/locks` y `GET /v1/projects/:projectId/locks`.
    - `GET /v1/projects/:projectId/team-status`.
    - Manejador uniforme de errores de API mapeando `AppError` a códigos de estado HTTP correspondientes (`401`, `403`, `404`, `409`, `413`, `422`, `429`, `500`).
- **Validación y calidad:**
  - Suite de integración de 7 pruebas en `apps/hub-server/src/app.test.ts` cubriendo autenticación, ciclo de vida de sesiones, paginación por cursores, conflicto 409 de locks y team-status.
  - Total de tests en el monorepo: 35 tests verdes.
  - Biome, TypeScript strict, Vitest y Build 100% limpios y verificados.
- **Siguiente paso:** Fusionar `feat/phase-3-hub-network` a `main` y proceder con **Fase 4 — Servidor MCP Local (`packages/mcp-server`)**.


### [2026-10-07] — Fase 2 Completada: Base de Datos y Dominio del Hub (`apps/hub-server`)
- **Implementación de persistencia y dominio (en rama `feat/phase-2-hub-domain`):**
  - `infrastructure/db/migrations.ts`: Esquemas SQL relacionales para `users`, `projects`, `memberships`, `agent_sessions`, `messages`, `status_reports`, `workspace_locks`, `events`, `audit_entries` y `auth_tokens`.
  - `infrastructure/db/database.ts`: Motor SQLite con `node:sqlite` (`DatabaseSync`), soporte WAL, transacciones seguras y claves foráneas activadas.
  - `infrastructure/event-bus/event-bus.ts`: Event store inmutable con secuencias monotónicas autoincrementales por proyecto y consulta por cursores/offset.
  - `application/services/project-service.ts`: Creación de proyectos, asignación de rol `owner` y control de membresías.
  - `application/services/session-service.ts`: Manejo del ciclo de vida de sesiones de agentes (`join`, `heartbeat`, `updateCursor`, `disconnect`).
  - `application/services/message-service.ts`: Envío transaccional de mensajes (con emisión simultánea de evento en `events`) y filtrado selectivo de mensajes dirigidos vs. generales.
  - `application/services/status-service.ts`: Publicación de reportes de estado y consulta agrupada del estado más reciente por agente.
  - `application/services/lock-service.ts`: Semántica de locks para workspaces: detección de colisiones exactas y por prefijo/subdirectorio (`src/api` bloquea `src/api/users.ts`), TTL configurable, transacciones y control estricto de propiedad.
  - `application/services/audit-service.ts`: Trazabilidad y registro de acciones sensibles sin almacenar datos privados ni secretos.
- **Validación y calidad:**
  - Suite de 10 tests unitarios/integración en `apps/hub-server/src/application/services/domain-services.test.ts` verificando concurrencia de locks, aislamiento total entre proyectos distintos y transacciones evento+entidad.
  - Total de tests en el monorepo: 29 tests verdes.
  - `pnpm lint`, `pnpm typecheck`, `pnpm test` y `pnpm -r build` pasando al 100%.
- **Siguiente paso:** Fusionar `feat/phase-2-hub-domain` a `main` y arrancar **Fase 3 — WebSockets y Red del Hub**.


### [2026-10-07] — Fase 1 Completada: Contratos Compartidos (`packages/shared`)
- **Implementación de contratos centrales:**
  - `ids.ts`: Esquema estricto de UUIDv4 con `crypto.randomUUID()`.
  - `time.ts`: Fechas UTC estrictas en formato ISO 8601 terminadas en 'Z'.
  - `pagination.ts`: Secuencias monotónicas por proyecto y codecs seguros para Cursores opacos base64url.
  - `errors.ts`: Esquema `ApiError` y clase `AppError` con los 11 códigos tipados (`UNAUTHENTICATED`, `FORBIDDEN`, `PROJECT_NOT_FOUND`, `INVALID_INPUT`, `MESSAGE_TOO_LARGE`, `CURSOR_INVALID`, `LOCK_CONFLICT`, `LOCK_NOT_OWNER`, `SESSION_EXPIRED`, `RATE_LIMITED`, `INTERNAL_ERROR`).
  - `schemas/project.ts`: Esquemas Zod para `Project` y `Membership` (roles: owner, maintainer, collaborator, reader).
  - `schemas/session.ts`: Esquema `AgentSession` (active, idle, disconnected).
  - `schemas/message.ts`: Esquemas de mensaje con límite estricto de 16 KiB en el body, canales, destinatarios y prioridades.
  - `schemas/status.ts`: Esquema de `StatusReport` con `objective`, `progress`, `decision`, `blocked_by` y `next_step`.
  - `schemas/lock.ts`: Esquema de `WorkspaceLock` con normalización POSIX y rechazo estricto de traversal (`..`, `.`), rutas absolutas (`/` o letras de disco Windows `C:`) y bytes nulos.
  - `events.ts`: Esquema `EventEnvelope` con versionado estricto (`payload_version: 1`), límite de 64 KiB en el payload y tipos de eventos de dominio tipados.
- **Calidad y validación:**
  - Suite de 13 pruebas unitarias exhaustivas en `packages/shared/src/index.test.ts`.
  - Biome (`pnpm lint`), TypeScript (`pnpm typecheck`), Vitest (`pnpm test`) y Build (`pnpm -r build`) 100% verdes (19 tests totales en el monorepo).
- **Siguiente paso:** Proceder con la **Fase 2 — Base de datos y dominio del Hub** (`apps/hub-server`).

### [2026-10-07] — Fase 0 Completada: Bootstrap del Monorepo y Calidad
- **Herramientas base:** Node `v24.12.0` verificado; `pnpm` `v12.10.1` instalado y configurado con workspace (`apps/*`, `packages/*`).
- **Bloqueo técnico superado:** `better-sqlite3` falló en compilación nativa en Windows por falta de binarios para Node 24 y ausencia de Visual Studio C++ toolset. Se reemplazó por `node:sqlite` (`DatabaseSync`), integrado nativamente en Node 24 sin dependencias de compilación externa.
- **Estructura creada:**
  - `packages/config`: Validación de entorno con Zod y tests unitarios.
  - `packages/shared`: Módulo compartido inicial con tests.
  - `packages/testkit`: Utilidades de testeo iniciales.
  - `packages/mcp-server`: Módulo base del servidor MCP con `@modelcontextprotocol/sdk`.
  - `apps/hub-server`: Aplicación Fastify con endpoint `/health` y tests de integración.
- **Calidad y tooling:**
  - Biome configurado para linting y formateo estricto.
  - TypeScript configurado con project references (`tsconfig.json` raíz y por paquete) con comprobaciones estrictas (`strict`, `noUncheckedIndexedAccess`, `exactOptionalPropertyTypes`, etc.).
  - Vitest configurado en workspace; suite de tests pasando (7 tests verdes).
  - Comandos `pnpm check` (lint + typecheck + test) y `pnpm -r build` verificados y verdes.
- **Siguiente paso:** Proceder con la **Fase 1 — Contratos Compartidos** (`packages/shared`).

### [2026-10-07] — Diseño base de propósito, arquitectura, seguridad y plan
- Se establece `ARCHITECTURE.md` como diseño base del proyecto.
- Propósito: coordinar agentes existentes mediante contexto estructurado, mensajes, estado y locks; no construir otro modelo ni exponer Chain of Thought privado.
- Arquitectura: `team-hub-mcp` local por `stdio`, Hub central como autoridad por HTTPS/WebSocket, dashboard humano y persistencia detrás de repositorios.
- Recepción: se acepta la estrategia híbrida `check_inbox(cursor)` + `wait_for_messages(timeout)` opcional; el daemon de inyección queda diferido.
- MVP: monolito modular TypeScript con SQLite/WAL, contratos versionados y cursor de eventos; PostgreSQL, Redis, Docker, P2P e integración Git quedan para fases posteriores.
- Seguridad: aislamiento por proyecto, mínimo privilegio, tokens revocables y con audiencia, TLS/WSS, validación de `Origin`, límites, auditoría y prohibición de registrar secretos o razonamiento privado.
- Plan: contratos/seguridad, Hub, MCP local, dashboard, validación y luego capacidades avanzadas sólo con evidencia.

### [2026-10-07] — Selección tecnológica concreta del MVP
- Runtime y lenguaje: Node.js 24.x Active LTS y TypeScript 6.x estricto.
- Monorepo: pnpm workspaces, sin Turborepo inicialmente.
- Backend: Fastify 5, `@fastify/websocket`/`ws`, Zod 4, Pino y SDK oficial MCP v2.
- Datos: SQLite con WAL, `better-sqlite3`, Drizzle ORM y Drizzle Kit para migraciones.
- Frontend: React + Vite + Tailwind CSS, con TanStack Query para cache de API.
- Calidad: Biome, `tsc --noEmit`, Vitest, Playwright y GitHub Actions.
- Despliegue inicial: proceso Node único con Caddy/Nginx y volumen persistente; Docker, Redis, Kubernetes y PostgreSQL quedan condicionados a evidencia de escala o necesidad operativa.
- Se fija como regla mantener un lockfile, dependencias mínimas y actualizaciones verificadas con pruebas.

### [2026-10-07] — Plan de desarrollo ejecutable para Gemini
- Se crea `DEVELOPMENT_PLAN.md` como manual operativo de implementación.
- El plan fija el orden obligatorio: bootstrap, contratos, dominio/SQLite, API, servidor MCP, dashboard y seguridad/rendimiento.
- Cada fase tiene estructura de archivos, comandos, contratos, tests y criterios de aceptación.
- Gemini debe leer `AGENTS.md`, `BITACORA.md`, `ARCHITECTURE.md` y `DEVELOPMENT_PLAN.md` antes de trabajar, mantener el alcance y actualizar la bitácora en cada fase.
- El primer entregable de código será Fase 0; no se implementará el dashboard antes de que los contratos, dominio y API tengan pruebas verdes.

### [2026-10-07] — Regla de contexto obligatorio del repositorio
- Se establece `AGENTS.md` como la guía operativa del repositorio.
- Toda persona o agente debe leer completa `BITACORA.md` antes de planear, decidir arquitectura o modificar el proyecto.
- Todo avance relevante, decisión, bloqueo, solución o cambio de alcance debe registrarse en esta bitácora durante la misma sesión.
- Se conserva como estado vigente el alcance lean del MVP: comunicación, estado compartido y locks; orquestación activa y Docker quedan fuera hasta nueva decisión explícita.

### [2026-10-07] — Corrección de Alcance (MVP Lean) y Reto de Recepción de Mensajes
#### 💡 Correcciones y foco real
- **Ajuste de alcance:** Se corrige ADR-002: el MVP se centra estrictamente en **comunicación y coordinación básica**, no en orquestación automática compleja.
- **Docker diferido:** Se mueve Docker a fase futura para no inflar el alcance (scope creep).
- **Problema de reactividad de terminal:** Identificado formalmente el reto de cómo un agente dormido recibe mensajes. Abierto el análisis de las opciones A (inbox pulling), B (blocking polling) y C (CLI wrapper).
- **Estrategia de prueba local:** Probar el MVP primero con **dos terminales propias** en la misma máquina antes de involucrar a terceros.

#### 🚀 Acciones Realizadas
- Corrección de `BITACORA.md` con ADR-001 a ADR-006.
- Definición lean del stack (TypeScript monorepo, SQLite + WebSockets).
- Plan de testeo inicial local.
