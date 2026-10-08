# Inventario vigente de contratos

Revisión de fase 8.6: contrastado con `app.ts`, `http/routes`, catálogo MCP y schemas compartidos. API `/v1`; MCP stdio; envelope de evento `payload_version: 1`. Campos de respuesta normales: `{ data, request_id }`; errores: `{ error: { code, message, request_id, details? }, request_id }`. Health devuelve estado directamente. Un `request_id` no es una credencial.

## HTTP

`P` significa `/v1/projects/:projectId`. Cada ruta de proyecto aplica pertenencia/rol además del scope; tokens ligados a un proyecto no acceden a otro. Mutaciones de agente derivan identidad de una sesión propia validada, nunca del nombre remitente declarado.

| Método/ruta | Scope mínimo | Contrato o restricción |
|---|---|---|
| GET `/health/live`, `/health/ready` | Público | Readiness productivo oculta diagnósticos internos |
| GET `/v1/capabilities` | Público | `HubCapabilitiesSchema`: API/revisión y features de protocolo sin datos del equipo |
| POST `/v1/projects` | `projects:write` | `CreateProjectInputSchema`; crea owner |
| GET `P` | `projects:read` | Proyecto autorizado |
| POST `P/sessions` | `sessions:write` | `JoinSessionInputSchema`; instance_id opcional para retry, conflicto si otra instancia activa ocupa el nombre |
| POST `/v1/sessions/:sessionId/heartbeat` | `sessions:write` | `SessionActionInputSchema`; sesión/proyecto/usuario coinciden |
| DELETE `/v1/sessions/:sessionId` | `sessions:write` | Mismas validaciones; desconecta presencia |
| POST `P/ws-ticket` | `messages:read` | Sesión propia; ticket 30 s, uso único y token emisor vinculado |
| GET `P/inbox` | `messages:read` | `session_id`, `after?`, `limit` 1–100; eventos visibles ordenados |
| GET `P/inbox/recovery` | `messages:read` | Snapshot autorizado y cursor de frontera; no confirma historia |
| POST `P/inbox/ack` | `messages:read` | `session_id`, `cursor`; `accept_history_gap: true` sólo para recuperación explícita |
| GET `P/events` (WS) | `messages:read` | Origin, sesión y token/ticket autorizado; token query prohibido en producción |
| POST `P/messages` | `messages:write` (+ `messages:read` al responder) | `SendMessageInputSchema` + sesión; máx. 16 KiB; reply_to_message_id autoriza padre y restringe audiencia. Ver [respuestas](MESSAGE_REPLIES.md) |
| GET `P/messages/history` | `messages:read` | `MessageHistoryQuerySchema`; texto/canal/remitente/destinatario/rango UTC/thread, cursor ligado a filtros, visibilidad previa a paginación y cero cambios al ACK. Ver [historial](MESSAGE_HISTORY.md) |
| GET `P/messages/:messageId` | `messages:read` | Sesión propia; sólo mensaje visible y retenido; ausente/privado ajeno/cruzado devuelven el mismo error sin ACK |
| POST `P/status` | `messages:write` | `ReportStatusInputSchema` + sesión |
| GET `P/status` | `messages:read` | Último estado por agente |
| POST `P/locks/claim` | `locks:write` | `ClaimLockInputSchema` + sesión; conflicto de rutas jerárquico |
| POST `P/locks/:lockId/renew` | `locks:write` | Sesión, TTL entero 1–3600; propietario u owner |
| DELETE `P/locks/:lockId` | `locks:write` | Sesión; propietario u owner |
| DELETE `P/locks` | `locks:write` | Sesión y rutas canónicas; compatibilidad de liberación por paths |
| GET `P/locks` | `locks:read` | Locks activos; expiración transaccional |
| GET `P/team-status` | `projects:read` | Resumen de agentes, estados y locks; known_agents incluye nombre/estado efectivo/last_seen_at de miembros vigentes, incluidos desconectados. Umbrales existentes, sin mutaciones. Ver [presencia](PRESENCE.md) |
| POST `P/invitations` | `members:write` | `CreateInvitationInputSchema`; owner/maintainer, límites de rol |
| GET `P/invitations` | `members:read` | Administración; no devuelve secreto almacenado |
| DELETE `P/invitations/:invitationId` | `members:write` | Revocación administrativa |
| POST `P/invitations/accept` | `projects:read` | `AcceptInvitationInputSchema`; identidad propia, uso único/TTL/hash |
| GET `P/members` | `members:read` | Miembros del proyecto |
| PATCH `P/members/:userId` | `members:write` | `ChangeMemberInputSchema`; matriz de administración |
| DELETE `P/members/:userId` | `members:write` | Matriz de administración y revocación WS |
| POST `P/ownership` | `members:write` | UUID de miembro destino; sólo owner actual |
| GET `/v1/tokens` | Identidad autenticada | Tokens propios; token de proyecto limita listado al mismo proyecto |
| DELETE `/v1/tokens/:tokenId` | Identidad autenticada | Revoca sólo propio y dentro del binding del token |
| GET `/*` | Público | Bundle estático opcional; no es una API de datos |

`reader` mantiene presencia y lee; no muta mensajes/estado/locks. `collaborator` escribe y administra locks propios. `maintainer` administra reader/collaborator, sin elevar a owner. `owner` administra roles, transfiere ownership y puede intervenir locks ajenos. El rol no concede scopes ausentes.

Mensajes, estados y locks admiten `idempotency-key` HTTP. Crear mensajes/estado/claim también admite `idempotency_key` en body. La clave se asocia a identidad, proyecto y operación; reutilizarla con otro payload devuelve conflicto. Entidad/evento/auditoría/resultado idempotente comparten commit. El ACK es monotónico y tiene su propio contrato en [RECOVERY](RECOVERY.md).

Huella de comandos: payload de dominio + agente lógico derivado de sesión validada, excluyendo el session_id temporal. Reintentar desde una nueva generación del mismo agente conserva resultado; otro agente/payload entra en conflicto. Compatibilidad de registros antiguos y TTL: [sesiones](SESSIONS.md).

## MCP

Todas las herramientas de proyecto requieren `join_project` antes. Inputs se validan con schemas Zod; catálogo declara `additionalProperties: false`. Mensajes MCP tienen además un máximo de 4096 caracteres y rechazo de credenciales evidentes.

| Herramienta | Entrada principal | Resultado / efecto |
|---|---|---|
| `join_project` | Proyecto UUID, nombre, capacidades opcionales | Sesión, cursor confirmado y reglas; heartbeat del adaptador |
| `check_inbox` | Cursor opcional, límite | Omitir cursor hace replay del checkpoint; pasarlo confirma página anterior antes de leer |
| `ack_inbox` | Cursor de página consumida | Confirma sin nueva lectura |
| `wait_for_messages` | Cursor opcional, timeout 1–60 s | Misma confirmación; espera activa cancelable, no despierta agente inactivo |
| `get_inbox_recovery` | Sin argumentos | Snapshot y frontera; no ACK |
| `resync_inbox` | Cursor de snapshot y aceptación literal true | Acepta pérdida y devuelve página retenida aún sin confirmar |
| `send_team_message` | Body, canal, destinos, prioridad, correlación, reply_to_message_id y clave opcionales | Mensaje validado; idempotencia y respuesta sin ampliar audiencia |
| `report_status` | Objetivo, progreso, decisión/bloqueo/siguiente paso, clave opcional | Estado validado; idempotencia |
| `claim_module_lock` | Paths, motivo, TTL, clave opcional | Lock validado; idempotencia |
| `renew_module_lock` | Lock UUID, TTL 1–3600 (default 300), clave opcional | `RenewModuleLockInputSchema`; lock validado y renovación autorizada/idempotente |
| `release_module_lock` | Lock UUID o paths legacy | Liberación autorizada; idempotencia HTTP del adaptador |
| `get_team_status` | Sin argumentos | Resumen de equipo |

Renovación explícita expuesta en MCP y UI (10.5): propietario del lock u owner del proyecto, siempre con scope `locks:write`; un lock vencido debe reclamarse de nuevo. HTTP admite clave en header o body, y su respuesta se valida con `WorkspaceLockSchema`. Repetir una clave ya confirmada devuelve el resultado anterior, sin extender el TTL otra vez. El resultado MCP de retención usa `isError: true` y contenido JSON con código/cursor/siguiente paso; otros errores usan texto redactado. Validación completa de todas las salidas sigue pendiente.

## Errores y eventos

| HTTP | Código |
|---|---|
| 400 | `CURSOR_INVALID` |
| 401 | `UNAUTHENTICATED`, `SESSION_EXPIRED` |
| 403 | `FORBIDDEN`, `LOCK_NOT_OWNER` |
| 404 | `PROJECT_NOT_FOUND` |
| 409 | `LOCK_CONFLICT`, `IDEMPOTENCY_CONFLICT`, `STATE_CONFLICT` |
| 410 | `CURSOR_EXPIRED` |
| 413 | `MESSAGE_TOO_LARGE` |
| 422 | `INVALID_INPUT` |
| 429 | `RATE_LIMITED` |
| 500 | `INTERNAL_ERROR` |

Eventos definidos por `EventTypeSchema`: `project.created`, `membership.updated`, `agent.joined`, `agent.heartbeat`, `agent.idle`, `agent.left`, `message.created`, `status.updated`, `lock.acquired`, `lock.released`, `lock.expired`. Renovar lock emite `lock.acquired` con motivo `renewed`; no existe evento separado de renovación. En WS el frame es `{ type: "event", data: envelope }`; bienvenida `{ type: "connected", projectId, agentId }`. WebSocket despierta recuperación ordenada por inbox, no permite saltar a una secuencia viva y omitir eventos anteriores.

Envelope: UUID de evento/proyecto, secuencia positiva por proyecto, tipo, actor, fecha UTC, versión 1 y payload de hasta 64 KiB. `EventEnvelopeSchema` valida estructura y tamaño; la validación de cada payload específico en runtime aún debe completarse. No confundir catálogo tipado con validación semántica exhaustiva.

## Evidencia y pendientes

Regresiones API/dominio: `app.test.ts`, `remediation.test.ts`, `multiuser-operations.test.ts`, `recovery.test.ts`, `security-isolation.test.ts`, `infrastructure/repositories/contracts.test.ts`. E2E de bundle productivo y adaptadores stdio: `e2e/`. Los tests de SDK no acreditan dos productos reales (fase 7).

Instancias simultáneas (8.5) siguen [ADR-021](SESSIONS.md); rutas/herramientas están separadas (8.3). Quedan explícitos: validación exhaustiva de salidas/payloads, instalación distribuible, operación permanente y capacidades posteriores. Ver [ROADMAP](ROADMAP.md) y bitácora para estado por tarea.
