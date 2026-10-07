# Agents-Hub — plan de desarrollo ejecutable

Este documento es una guía de implementación para Gemini o cualquier agente de desarrollo que trabaje en el repositorio. Debe ejecutarse por fases, en el orden indicado. No se debe saltar directamente al dashboard ni añadir funcionalidades futuras antes de completar los contratos y pruebas del dominio.

## 0. Instrucciones obligatorias para el agente implementador

Antes de tocar código:

1. Leer completamente `AGENTS.md`.
2. Leer completamente `BITACORA.md`.
3. Leer completamente `ARCHITECTURE.md`.
4. Leer este `DEVELOPMENT_PLAN.md`.
5. Ejecutar `git status --short --branch` y no sobrescribir cambios ajenos.
6. Confirmar que el entorno usa Node 24.x y pnpm.

Durante el trabajo:

- Ejecutar sólo la fase solicitada; no implementar fases posteriores “por adelantado”.
- No cambiar el stack, nombres de herramientas, contratos o alcance sin registrar primero una propuesta en `BITACORA.md`.
- No usar Docker, Redis, PostgreSQL, Kafka, Kubernetes, P2P, merge automático ni ejecución de comandos del workspace desde el Hub.
- No almacenar Chain of Thought, prompts privados completos, tokens, cookies ni variables de entorno en logs o base de datos.
- No imprimir nada distinto de mensajes JSON-RPC válidos en `stdout` del servidor MCP; usar `stderr` para diagnóstico local.
- Cada fase debe terminar con tests, `pnpm lint`, `pnpm typecheck`, `pnpm test` y una actualización de la bitácora.
- Si un test falla, corregirlo antes de continuar. No marcar una fase como terminada con tests omitidos.
- Antes de cada commit, revisar `git diff`, `git diff --check` y los archivos modificados.

Formato de commits:

```text
feat(scope): short description
fix(scope): short description
test(scope): short description
docs(scope): short description
chore(scope): short description
```

## 1. Resultado final del MVP

El MVP está terminado únicamente cuando dos procesos MCP locales pueden conectarse al mismo proyecto y completar este escenario reproducible:

1. El agente A se registra y publica su estado.
2. El agente B se registra y consulta el estado del proyecto.
3. A reclama un módulo; B recibe que está ocupado y no puede reclamarlo.
4. A envía un mensaje dirigido a B.
5. B consulta el inbox usando el cursor recibido y responde.
6. A se desconecta; B publica otro mensaje.
7. A se reconecta y recupera el mensaje posterior al último cursor confirmado.
8. El lock de A expira y queda disponible.
9. Un agente de otro proyecto no puede leer mensajes, estados ni locks del proyecto.
10. El dashboard muestra los eventos sin convertirse en la autoridad del sistema.

## 2. Estructura exacta del repositorio

Crear esta estructura y mantener la separación de responsabilidades:

```text
apps/
  hub-server/
    src/
      app.ts                 # composición de plugins y rutas
      server.ts              # arranque, señales y shutdown
      config.ts              # env validado
      http/
        routes/
        websocket/
        auth/
      domain/
        projects/
        messages/
        statuses/
        locks/
        sessions/
      application/
        services/
        policies/
      infrastructure/
        db/
        repositories/
        event-bus/
        logging/
      errors/
    tests/
  web/
    src/
      app/
      components/
      features/messages/
      features/status/
      features/locks/
      lib/api.ts
      lib/events.ts
      main.tsx
    tests/
packages/
  shared/
    src/
      ids.ts
      time.ts
      pagination.ts
      errors.ts
      events.ts
      schemas/
        project.ts
        message.ts
        status.ts
        lock.ts
        session.ts
      index.ts
    tests/
  mcp-server/
    src/
      main.ts
      client/hub-client.ts
      client/retry.ts
      tools/
        join-project.ts
        check-inbox.ts
        send-team-message.ts
        report-status.ts
        claim-module-lock.ts
        release-module-lock.ts
        get-team-status.ts
      protocol/errors.ts
    tests/
  config/
    src/index.ts
  testkit/
    src/
      fake-hub.ts
      fake-agent.ts
      fixtures.ts
infra/
  migrations/
docs/
  ARCHITECTURE.md
  DEVELOPMENT_PLAN.md
AGENTS.md
BITACORA.md
README.md
package.json
pnpm-workspace.yaml
pnpm-lock.yaml
tsconfig.json
biome.json
vitest.workspace.ts
playwright.config.ts
.env.example
.gitignore
```

Regla: `shared` no puede importar nada de `apps` ni de `mcp-server`. El dominio no puede importar Fastify, WebSocket, Drizzle ni React. Los adaptadores dependen del dominio; el dominio no depende de los adaptadores.

## 3. Fase 0 — bootstrap y calidad

### Objetivo

Crear un monorepo ejecutable, compilable y testeable antes de implementar negocio.

### Pasos

1. Verificar herramientas:

   ```powershell
   node --version
   pnpm --version
   git status --short --branch
   ```

   Si Node no es 24.x, detenerse y reportar el bloqueo. No cambiar la instalación global silenciosamente.

2. Crear `pnpm-workspace.yaml` con `apps/*` y `packages/*`.
3. Crear el `package.json` raíz con scripts:

   ```json
   {
     "scripts": {
       "build": "pnpm -r build",
       "dev": "pnpm --parallel --filter @agents-hub/hub-server --filter @agents-hub/web dev",
       "lint": "biome check .",
       "format": "biome format --write .",
       "typecheck": "tsc -b --pretty false",
       "test": "vitest run",
       "test:watch": "vitest",
       "test:e2e": "playwright test",
       "check": "pnpm lint && pnpm typecheck && pnpm test"
     }
   }
   ```

4. Configurar TypeScript con `strict`, `noUncheckedIndexedAccess`, `exactOptionalPropertyTypes`, `noImplicitOverride`, `noFallthroughCasesInSwitch`, `verbatimModuleSyntax` y `noEmit` en la configuración raíz. Cada paquete define su salida de build.
5. Configurar Biome sin formatear archivos generados, migraciones compiladas, `dist` ni `node_modules`.
6. Configurar Vitest para tests de todos los paquetes y un proyecto separado para Playwright.
7. Crear `.env.example` sin valores reales:

   ```text
   NODE_ENV=development
   HOST=127.0.0.1
   PORT=8787
   DATABASE_URL=./data/agents-hub.sqlite
   CORS_ORIGINS=http://localhost:5173
   AUTH_TOKEN_TTL_SECONDS=3600
   LOCK_DEFAULT_TTL_SECONDS=300
   LOG_LEVEL=info
   ```

8. Implementar `packages/config` con Zod. El proceso debe fallar al iniciar si falta una variable obligatoria o tiene un formato inválido.
9. Añadir `.gitignore` para `.env`, `data/`, `dist/`, `coverage/`, `playwright-report/`, `test-results/` y logs.
10. Crear un test que importe cada workspace y confirme que la compilación base funciona.

### Aceptación de la Fase 0

- `pnpm install --frozen-lockfile` funciona.
- `pnpm lint`, `pnpm typecheck` y `pnpm test` pasan.
- El Hub puede arrancar y apagarse sin errores.
- No hay secretos en el repositorio.

## 4. Fase 1 — contratos compartidos

### Objetivo

Definir una única fuente de verdad para IDs, comandos, respuestas, errores y eventos.

### Reglas de datos

- IDs: UUID generados por el servidor con `crypto.randomUUID()`.
- Fechas: ISO 8601 en UTC, serializadas como strings.
- Secuencias: entero positivo monotónico por `project_id`.
- Cursor: string opaco que representa la última secuencia confirmada; el cliente no puede fabricar permisos con él.
- Payloads: tamaño máximo inicial de 16 KiB por mensaje y 64 KiB por evento.
- Versionado: cada payload incluye `payload_version: 1`.

### Implementar en `packages/shared`

Crear schemas Zod y tipos inferidos para:

- `Project`, `Membership`, `AgentSession`.
- `Message` con `message_id`, `project_id`, `sender_id`, `recipient_agent_ids`, `channel`, `body`, `priority`, `correlation_id`, `created_at`.
- `StatusReport` con `objective`, `progress`, `decision`, `blocked_by` y `next_step`.
- `WorkspaceLock` con `lock_id`, `project_id`, `owner_agent_id`, `paths`, `reason`, `expires_at`.
- `EventEnvelope` con `event_id`, `project_id`, `sequence`, `type`, `actor_id`, `occurred_at`, `payload_version`, `payload`.
- `ApiError` con `code`, `message`, `request_id`, `details` opcional.

Errores mínimos: `UNAUTHENTICATED`, `FORBIDDEN`, `PROJECT_NOT_FOUND`, `INVALID_INPUT`, `MESSAGE_TOO_LARGE`, `CURSOR_INVALID`, `LOCK_CONFLICT`, `LOCK_NOT_OWNER`, `SESSION_EXPIRED`, `RATE_LIMITED`, `INTERNAL_ERROR`.

Crear tests para inputs válidos, campos faltantes, strings vacíos, tamaños excesivos, IDs inválidos y fechas no UTC.

### Aceptación de la Fase 1

- Ningún tipo de dominio se duplica en otro paquete.
- Los schemas rechazan payloads desconocidos o inválidos según la política elegida.
- Los tests cubren cada error público.

## 5. Fase 2 — base de datos y dominio del Hub

### Objetivo

Implementar el núcleo sin HTTP para poder probarlo con rapidez y aislar reglas de negocio.

### Tablas iniciales

Crear migraciones para:

1. `users`: identidad humana.
2. `projects`: proyecto y timestamps.
3. `memberships`: usuario, proyecto, rol y estado.
4. `agent_sessions`: agente, proyecto, usuario, last_seen, cursor confirmado y estado.
5. `messages`: mensaje persistente e índices por proyecto/fecha y destinatario.
6. `status_reports`: último estado o historial según el caso de uso.
7. `workspace_locks`: rutas, propietario, motivo, TTL e índices por proyecto/ruta/expiración.
8. `events`: envelope persistente, secuencia única por proyecto y payload JSON.
9. `audit_entries`: actor, acción, recurso, resultado, request ID y timestamp.
10. `auth_tokens`: hash, subject, audience, scopes, expiración, revocación y timestamps.

No guardar tokens en claro. No guardar prompts completos ni razonamiento privado.

### Servicios de dominio

Implementar servicios puros con repositorios como interfaces:

- `ProjectService`: crear proyecto, comprobar membresía y resolver rol.
- `SessionService`: registrar heartbeat, desconectar y actualizar cursor.
- `MessageService`: validar destinatarios, persistir mensaje, emitir evento y consultar inbox.
- `StatusService`: publicar estado y emitir `status.updated`.
- `LockService`: reclamar, renovar, liberar y expirar locks dentro de transacciones.
- `AuditService`: registrar acciones sensibles sin datos secretos.

### Semántica de locks

- Una ruta se normaliza a formato POSIX relativo al workspace lógico.
- Rechazar `..`, rutas absolutas, bytes nulos, paths vacíos y más de 100 rutas por operación.
- Dos locks se consideran conflictivos si una ruta es igual o prefijo de la otra.
- El TTL por defecto es 300 segundos; máximo 3600 segundos.
- Sólo el propietario puede renovar/liberar, salvo `owner` del proyecto.
- La expiración se evalúa al leer y también mediante un job periódico de baja frecuencia.
- Un lock no impide cambios físicos en Git; sólo coordina la intención.

### Aceptación de la Fase 2

- Tests de dominio sin levantar servidor.
- Transacciones verificadas para mensaje + evento y lock + evento.
- Test de concurrencia que demuestra que sólo un agente obtiene un lock conflictivo.
- Test de aislamiento entre dos proyectos.

## 6. Fase 3 — API HTTP y WebSocket

### Objetivo

Exponer el dominio con una API versionada, autenticada y documentada.

### Rutas

Todas bajo `/v1` y con `x-request-id` generado o propagado de forma segura.

```text
GET  /health/live
GET  /health/ready

POST /v1/projects
GET  /v1/projects/:projectId
POST /v1/projects/:projectId/invitations

POST /v1/projects/:projectId/sessions
POST /v1/sessions/:sessionId/heartbeat
DELETE /v1/sessions/:sessionId

GET  /v1/projects/:projectId/inbox?after=<cursor>&limit=<n>
POST /v1/projects/:projectId/messages
POST /v1/projects/:projectId/status
GET  /v1/projects/:projectId/status

POST /v1/projects/:projectId/locks/claim
POST /v1/projects/:projectId/locks/:lockId/renew
DELETE /v1/projects/:projectId/locks/:lockId
GET  /v1/projects/:projectId/locks
GET  /v1/projects/:projectId/team-status

GET  /v1/projects/:projectId/events  # WebSocket upgrade
```

### Reglas HTTP

- `401` sin identidad válida; `403` con identidad pero sin permiso; `404` sin revelar recursos de otro proyecto.
- `409` para conflicto de lock o estado; `422` para input inválido; `429` para rate limit; `500` sólo para fallos no controlados.
- Respuesta JSON uniforme: `{ data, request_id }` o `{ error, request_id }`.
- Nunca incluir stack traces en producción.
- CORS con allowlist exacta, nunca `*` junto con credenciales.
- Validar `Origin` en WebSocket; cerrar conexiones no autorizadas.
- Autenticar el WebSocket antes de suscribirlo a un proyecto.
- El WebSocket sólo emite eventos compactos; nunca se usa para autorizar comandos.

### Inbox

`GET /inbox` debe:

1. validar membresía;
2. decodificar el cursor;
3. consultar eventos con `sequence > cursor`;
4. filtrar por visibilidad del actor/destinatario;
5. devolver máximo `limit` eventos;
6. devolver `next_cursor` y `has_more`;
7. registrar el cursor sólo cuando el cliente lo confirme explícitamente.

El servidor no borra eventos sólo porque un cliente los leyó.

### Aceptación de la Fase 3

- Contract tests para cada ruta.
- Tests de autenticación, autorización, CORS, Origin, payload demasiado grande y rate limit.
- Dos clientes HTTP pueden ejecutar el escenario completo del MVP.
- WebSocket desconecta clientes no autorizados y no pierde la recuperación por inbox.

## 7. Fase 4 — servidor MCP local

### Objetivo

Hacer que un agente compatible con MCP use el Hub sin conocer detalles HTTP ni de la base de datos.

### Transporte y comportamiento

- Iniciar `packages/mcp-server/src/main.ts` por `stdio`.
- Todo log va a `stderr`.
- Configuración mínima: `AGENTS_HUB_URL`, `AGENTS_HUB_TOKEN`, `AGENTS_HUB_PROJECT_ID` y `AGENTS_HUB_AGENT_NAME`.
- No imprimir el token en errores.
- Timeout HTTP de 10 segundos para comandos normales.
- `wait_for_messages` usa timeout máximo de 60 segundos y se cancela limpiamente.
- Retry sólo en `408`, `429`, `502`, `503`, `504` y errores de red; backoff 250 ms, 500 ms, 1 s, máximo tres intentos.
- Nunca reintentar `claim_module_lock` sin `idempotency_key`.

### Herramientas exactas

`join_project({ project_id, agent_name, capabilities? })`

- Devuelve `session_id`, `agent_id`, `project_id`, `cursor` y reglas de uso.
- Debe ejecutarse antes de cualquier herramienta de proyecto.

`check_inbox({ cursor?, limit? })`

- `limit` entre 1 y 100; por defecto 50.
- Devuelve eventos estructurados, `next_cursor` y resumen legible.

`wait_for_messages({ cursor?, timeout_seconds? })`

- Sólo espera eventos visibles para la sesión.
- Máximo 60 segundos; al expirar devuelve lista vacía y cursor actual.

`send_team_message({ channel, body, recipient_agent_ids?, priority?, correlation_id? })`

- `body` entre 1 y 4096 caracteres.
- Rechaza secretos obvios sólo como defensa básica; no pretende ser DLP completo.

`report_status({ objective, progress, decision?, blocked_by?, next_step })`

- Publica un resumen humano, no pensamiento interno crudo.

`claim_module_lock({ paths, reason, ttl_seconds?, idempotency_key })`

- Devuelve locks adquiridos o conflicto con propietario visible y expiración.
- No revela datos privados del propietario.

`release_module_lock({ lock_id })`

- Sólo libera locks propios o autorizados.

`get_team_status({})`

- Devuelve agentes visibles, estado resumido y locks activos.

Cada herramienta debe tener tests de schema, autorización, error y resultado exitoso.

### Aceptación de la Fase 4

- MCP Inspector o un cliente MCP real puede listar y ejecutar las herramientas.
- `stdout` contiene exclusivamente JSON-RPC válido.
- Desconectar/reconectar recupera eventos desde el cursor.
- El servidor MCP no contiene reglas de negocio duplicadas del Hub.

## 8. Fase 5 — dashboard web

### Orden de implementación de UI

1. Shell con proyecto seleccionado y estado de conexión.
2. Feed de mensajes con canal, remitente, fecha, prioridad y destinatario.
3. Panel de agentes con presencia, objetivo y bloqueo resumido.
4. Lista de locks con ruta, propietario, motivo y expiración.
5. Reconexión WebSocket y recuperación vía inbox.
6. Estados vacíos, loading, error y rate limit.

La UI nunca debe:

- calcular permisos por sí misma;
- ocultar errores del backend;
- enviar eventos sin confirmación de respuesta;
- mostrar Chain of Thought;
- ejecutar comandos del workspace.

### Aceptación de la Fase 5

- Playwright cubre login/invitación, selección de proyecto, mensaje, lock y reconexión.
- La vista funciona aunque WebSocket falle, usando polling/inbox de recuperación.
- La UI no expone tokens en URL, localStorage inseguro o logs del navegador.

## 9. Fase 6 — seguridad, rendimiento y operación

### Seguridad

- Crear threat model con STRIDE para identidad, proyecto, mensajes, locks, WebSocket y dashboard.
- Añadir pruebas negativas de aislamiento entre proyectos.
- Añadir rate limit por IP y por identidad.
- Redactar tokens, cookies, `Authorization`, `AGENTS_HUB_TOKEN` y campos sensibles de logs.
- Auditar invitaciones, membresías, sesiones, locks y eliminaciones.
- Ejecutar auditoría de dependencias en CI.

### Rendimiento

- Crear benchmark de inbox con 100 agentes simulados y 20 eventos/segundo.
- Medir p50/p95/p99 de crear mensaje, consultar inbox, reclamar lock y entregar WebSocket.
- Confirmar índices SQL con `EXPLAIN QUERY PLAN`.
- Limitar tamaño de colas WebSocket y desconectar consumidores lentos.
- No optimizar con Redis ni workers hasta tener una medición que demuestre el cuello de botella.

### Operación

- Endpoints `/health/live` y `/health/ready`.
- Shutdown graceful: dejar de aceptar conexiones, cerrar WebSocket, terminar transacciones y cerrar SQLite.
- Backups documentados de SQLite antes de cualquier migración destructiva.
- Logs JSON con `request_id`, `project_id` y `actor_id` pseudonimizados cuando sea posible.

## 10. Flujo de trabajo de Gemini por cada fase

Gemini debe responder y trabajar con esta secuencia:

1. **Estado inicial:** listar archivos, rama, fase objetivo y riesgos.
2. **Plan corto:** enumerar archivos que creará/modificará.
3. **Implementación incremental:** cambios pequeños, compilables.
4. **Verificación:** ejecutar los comandos de aceptación de la fase.
5. **Revisión:** inspeccionar diff y buscar secretos, imports incorrectos y scope creep.
6. **Bitácora:** registrar resultado, decisiones, bloqueos, métricas y siguiente paso.
7. **Commit:** un commit enfocado por fase o subfase.
8. **Reporte:** indicar exactamente qué funciona, qué no y cómo reproducirlo.

Plantilla de reporte:

```text
Fase:
Objetivo:
Archivos modificados:
Comandos ejecutados:
Tests: PASS/FAIL
Decisiones:
Bloqueos:
Riesgos pendientes:
Siguiente paso:
Commit:
```

## 11. Orden exacto recomendado

No alterar este orden salvo una decisión registrada:

1. Fase 0: monorepo y calidad.
2. Fase 1: contratos compartidos.
3. Fase 2: SQLite, migraciones y dominio.
4. Fase 3: API HTTP/WebSocket.
5. Fase 4: servidor MCP y dos agentes simulados.
6. Fase 5: dashboard.
7. Fase 6: seguridad, rendimiento y operación.
8. Prueba final del escenario completo del MVP.

El primer entregable de código debe ser la Fase 0. Si la Fase 0 no compila y no tiene tests verdes, no comenzar la implementación del Hub.
