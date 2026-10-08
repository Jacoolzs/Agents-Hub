# Revisión de implementación — Fases 0 a 4

**Informe histórico previo a las correcciones.** La remediación y sus verificaciones están registradas en [BITACORA.md](BITACORA.md). Para el estado vigente y los pendientes, consultar [docs/MVP_CLOSEOUT.md](docs/MVP_CLOSEOUT.md).

Fecha: 2026-10-07  
Estado: **NO APROBADA para iniciar Fase 5**

## Resumen ejecutivo

La implementación tiene una base funcional: `pnpm typecheck`, `pnpm test` y `pnpm -r build` pasan, con 37 tests verdes. Las capas principales existen y SQLite, contratos, servicios, API y servidor MCP están conectados.

Sin embargo, los tests actuales no cubren varias fronteras de seguridad. Antes de seguir al dashboard o declarar la Fase 4 terminada deben corregirse los hallazgos P0/P1 de este documento. El problema más grave es que el actor (`sender_id`/`agent_id`) llega desde el body y no se deriva de la sesión autenticada; un usuario miembro puede suplantar otro agente del mismo proyecto. Además, el inbox y WebSocket no filtran eventos dirigidos.

## Verificación ejecutada

| Comando | Resultado |
|---|---|
| `pnpm typecheck` | PASS |
| `pnpm test` | PASS: 37 tests |
| `pnpm -r build` | PASS |
| `pnpm lint` | FAIL: Biome reporta 5 archivos sin formatear en `packages/mcp-server` |

El warning de `node:sqlite` como API experimental también aparece durante los tests. No rompe la ejecución, pero debe documentarse como decisión consciente.

## Hallazgos críticos

### P0 — Suplantación de agentes en la API

Archivos: `apps/hub-server/src/app.ts:241`, `apps/hub-server/src/app.ts:262`, `apps/hub-server/src/app.ts:295`, `apps/hub-server/src/app.ts:315`.

Los endpoints aceptan `sender_id` o `agent_id` enviados por el cliente y sólo verifican que el usuario tenga membresía en el proyecto. El token no se vincula a una `AgentSession` concreta.

Un miembro autenticado podría enviar:

```json
{
  "sender_id": "otro-agente",
  "body": "mensaje falso"
}
```

### Corrección obligatoria

1. Crear/usar una `session_id` autenticada como identidad del agente.
2. Validar que la sesión pertenece al `user_id` del token, al `project_id` de la ruta y que no está desconectada/expirada.
3. Eliminar `sender_id` y `agent_id` de los bodies de mensaje, estado, locks, heartbeat y disconnect.
4. Derivar `actor_id`/`agent_id` exclusivamente de la sesión autenticada.
5. Añadir tests negativos: Alice no puede publicar como Bob, liberar locks de Bob ni reportar estado como Bob.

## Hallazgos de aislamiento de información

### P0 — El inbox filtra eventos dirigidos a otros agentes

`apps/hub-server/src/app.ts:205-224` consulta todos los eventos del proyecto. El query acepta `agent_id`, pero no lo usa. `SqliteEventBus.getEventsAfter()` devuelve el proyecto completo, incluyendo mensajes dirigidos a otros agentes.

### P0 — WebSocket filtra sólo por proyecto

`apps/hub-server/src/http/websocket/ws-hub.ts:35-41` envía todos los eventos del proyecto a todas las suscripciones. Además, `wsHub.broadcast()` no aparece invocado en ningún servicio ni en `app.ts`, así que el canal WebSocket actualmente no recibe eventos de dominio.

### Corrección obligatoria

1. Crear una única función de autorización/visibilidad de eventos.
2. Un evento de mensaje es visible para el emisor, los destinatarios y los miembros autorizados según política explícita; los mensajes dirigidos no son broadcast.
3. Aplicar exactamente la misma política al inbox y al WebSocket.
4. Conectar la publicación de eventos al WebSocket después de confirmar la transacción.
5. Añadir tests con Alice, Bob y Charlie: un mensaje Alice→Bob no debe aparecer en el inbox ni WebSocket de Charlie.

## Hallazgos de transporte y autenticación

### P1 — Token en query string del WebSocket

`apps/hub-server/src/app.ts:354-368` acepta `?token=...`. Los tokens en URL pueden terminar en historial, proxies, logs y herramientas de observabilidad.

### Corrección

- Preferir cookie `HttpOnly; Secure; SameSite` para el dashboard o un mecanismo de handshake de corta duración.
- Si temporalmente se admite query string para pruebas locales, debe estar deshabilitado en producción, tener TTL muy corto y nunca registrarse.
- Validar `Origin` contra una allowlist antes de registrar el socket.
- Añadir pruebas de Origin válido, Origin inválido, token expirado, proyecto ajeno y cierre con código 1008.

### P1 — Scopes y audiencia no se aplican completamente

`AuthService.verifyToken()` valida la audiencia, pero devuelve `userId` sin scopes y no hay comprobaciones de scopes por operación. También acepta audiencia `*`, lo cual contradice el mínimo privilegio definido en la arquitectura.

### Corrección

- Eliminar wildcard de audiencia para producción.
- Devolver scopes parseados y requerir scopes por operación.
- Añadir revocación, expiración y audiencia a tests.
- Mantener tokens fuera de logs y errores.

## Hallazgos de contrato incompleto

### P1 — Faltan operaciones definidas en el plan

El plan exige:

- `POST /v1/projects/:projectId/locks/:lockId/renew`;
- liberación por `lock_id`;
- `idempotency_key` en `claim_module_lock`;
- actualización/confirmación explícita de cursor;
- invitaciones o mecanismo real para crear/entregar tokens.

La implementación actual sólo libera por paths, no tiene renew, no tiene idempotency key y `SessionService.updateCursor()` nunca se invoca desde API/MCP.

### Corrección

Implementar `renew(lock_id, session_id, ttl)`, `release(lock_id, session_id)`, `ack_inbox(session_id, cursor)` y una clave de idempotencia persistente para claims/mensajes. Si se elige otra semántica, actualizar primero `DEVELOPMENT_PLAN.md` y `BITACORA.md` con una nueva ADR.

## Hallazgos del servidor MCP

### P1 — El MCP no valida argumentos con schemas

`packages/mcp-server/src/server.ts` usa casts como `args as { ... }`. Eso no valida runtime. Un cliente puede enviar strings vacíos, números fuera de rango, paths peligrosos o estructuras inesperadas.

### Corrección

- Usar los schemas compartidos de Zod antes de cada herramienta.
- Convertir errores de validación en respuestas MCP `isError: true` sin stack trace ni secretos.
- Añadir tests por herramienta para input válido, input inválido, no autenticado, no unido al proyecto y error del Hub.

### P1 — La sesión MCP no se usa como identidad persistente

`currentSessionId` se asigna en `join_project` pero no se utiliza después. `check_inbox` no confirma cursor y el cliente no mantiene estado de sesión de forma segura.

### Corrección

- Guardar `session_id`, `agent_id`, `project_id` y cursor actual en un contexto de sesión.
- Exigir sesión para todas las herramientas.
- Añadir `ack_inbox` o actualizar la API para confirmar cursor explícitamente.
- Añadir heartbeat periódico o antes de cada operación si la sesión está cerca de expirar.

### P1 — SDK MCP desactualizado respecto al stack decidido

`packages/mcp-server/package.json` usa `@modelcontextprotocol/sdk` v1.x, mientras que la arquitectura y el plan fijan el SDK v2 (`@modelcontextprotocol/server` y `@modelcontextprotocol/client`).

### Corrección

Migrar al SDK v2 o registrar una ADR temporal que explique por qué se mantiene v1, qué compatibilidad se pierde y cuál es el plazo de migración. No dejar la discrepancia sin documentar.

## Calidad y consistencia

### P1 — `pnpm lint` está roto

Biome reporta formato pendiente en:

- `packages/mcp-server/src/client/hub-client.ts`
- `packages/mcp-server/src/client/retry.ts`
- `packages/mcp-server/src/main.ts`
- `packages/mcp-server/src/server.ts`
- `packages/mcp-server/src/main.test.ts`

### Corrección

Ejecutar `pnpm format`, revisar el diff y volver a ejecutar `pnpm lint`, `pnpm typecheck`, `pnpm test` y `pnpm -r build`.

### P1 — Documentación y código no coinciden en persistencia

`ARCHITECTURE.md` fija `better-sqlite3` + Drizzle, mientras el código usa `node:sqlite` directamente. La bitácora registra el ajuste, pero `ARCHITECTURE.md` no está actualizado.

### Corrección

Elegir una de las dos opciones y documentarla coherentemente:

- mantener `node:sqlite`, aceptar y cubrir el warning experimental, actualizar arquitectura y plan; o
- migrar a `better-sqlite3`/Drizzle cuando el entorno de compilación esté resuelto.

No mezclar la decisión documentada con la implementación real.

## Pruebas que faltan antes de aprobar Fase 4

1. Test real con `Client` MCP y `StdioClientTransport`, no sólo tests directos de `HubClient`.
2. Test de `stdout`: sólo JSON-RPC válido.
3. Test de dos agentes y dos sesiones simultáneas.
4. Tests de suplantación de `agent_id`.
5. Tests de fuga de mensajes dirigidos en inbox y WebSocket.
6. Tests de Origin y tokens WebSocket.
7. Tests de rate limiting o, si no está implementado aún, documentar el bloqueo antes de avanzar.
8. Test de reconexión y recuperación posterior al cursor.
9. Test de expiración y renovación de locks.
10. Test de idempotencia de reintentos.

## Orden de corrección para Gemini

1. Corregir formato y dejar `pnpm lint` verde.
2. Corregir identidad: actor derivado de sesión autenticada.
3. Corregir aislamiento de inbox y WebSocket.
4. Conectar publicación real del event bus al WebSocket.
5. Corregir autenticación WebSocket, Origin y scopes.
6. Completar renew/release/idempotencia/ack de cursor.
7. Validar argumentos MCP con schemas compartidos.
8. Resolver la versión del SDK MCP y la decisión SQLite.
9. Añadir los tests de seguridad y protocolo listados arriba.
10. Repetir todos los comandos de aceptación y actualizar `BITACORA.md`.

## Mensaje listo para enviar a Gemini

```text
La auditoría de las Fases 0-4 encontró que typecheck, tests y build pasan, pero la Fase 4 NO está aprobada.

Lee REVIEW_PHASES_0_4.md y corrige en este orden:
1. pnpm lint roto.
2. Suplantación: no aceptes sender_id/agent_id del body; deriva el actor de session_id autenticada y vinculada al usuario/proyecto.
3. Filtrado: un evento dirigido Alice→Bob no puede aparecer para Charlie en inbox ni WebSocket.
4. Conecta wsHub.broadcast al event bus después del commit transaccional.
5. No envíes tokens en query string en producción; valida Origin y aplica scopes/audience.
6. Implementa renew/release por lock_id, idempotency_key y confirmación de cursor.
7. Valida todos los argumentos MCP con schemas compartidos; elimina casts inseguros.
8. Decide y documenta SDK MCP v1 vs v2 y node:sqlite vs better-sqlite3/Drizzle.
9. Añade los tests de seguridad, WebSocket, MCP real por stdio, reconexión e idempotencia.

No avances a Fase 5. No modifiques el alcance. Después de corregir, ejecuta pnpm lint, pnpm typecheck, pnpm test y pnpm -r build; actualiza BITACORA.md y reporta archivos, tests y commit.
```

## Segunda verificación del supuesto cierre

La afirmación de que todos los hallazgos quedaron remediados no se confirma completamente:

- `pnpm typecheck`: PASS.
- `pnpm test`: PASS, 49 tests.
- `pnpm -r build`: PASS.
- `pnpm lint`: FAIL; Biome todavía reporta `packages/mcp-server/src/main.test.ts`, `apps/hub-server/src/app.test.ts` y `apps/hub-server/src/app.ts`.

Además, siguen pendientes estos problemas funcionales:

1. `GET /inbox` permite omitir `session_id`. En ese caso `requestingAgentId` queda `undefined` y `isEventVisibleToAgent` devuelve `true`, por lo que un miembro puede ver mensajes dirigidos a otros agentes.
2. WebSocket permite omitir `session_id` y registra la suscripción con `agentId` indefinido; la misma política concede visibilidad completa.
3. `Origin` sólo se rechaza cuando existe y es inválido; un `Origin` ausente se acepta. Además, el token sigue admitiéndose en query string.
4. `SqliteEventBus.recordEvent()` ejecuta los listeners inmediatamente después del INSERT, incluso cuando el llamador está dentro de una transacción que todavía no hizo `COMMIT`. Por tanto, WebSocket puede emitir un evento que posteriormente se revierte.
5. El ACK del cursor guarda cualquier string recibido sin verificar que el cursor sea válido, que no avance más allá de la secuencia existente ni que el agente haya podido ver esos eventos.
6. Los scopes se parsean desde el token, pero no se comprueba ningún scope en las rutas.
7. La implementación sigue usando el SDK MCP v1.6.0; esto está documentado como ADR-012, pero sigue siendo una desviación del stack v2 y debe considerarse deuda explícita.
