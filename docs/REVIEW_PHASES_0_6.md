# Auditoría de pendientes de las fases 0–6

**Informe histórico anterior a las correcciones.** Estado vigente, evidencia y pendientes residuales: [MVP_CLOSEOUT.md](MVP_CLOSEOUT.md) y `BITACORA.md`.

Fecha: 2026-10-07. Checkout: `feat/phase-6-security-performance-ops`, base `cd5fbc9`, incluidos los cambios locales existentes al comenzar. Esta revisión no implementa funcionalidades, no hace commit, merge ni despliegue.

## Resultado

El núcleo colaborativo funciona localmente: mensajes dirigidos, estado, locks, inbox, WebSocket, dashboard y dos procesos MCP por stdio. **El plan 0–6 todavía no está completamente cerrado.** Hay fallos residuales de locks/autorización/contratos y entregables pendientes de acceso multiusuario, observabilidad, carga y operación.

Las etiquetas históricas de “fase completada” describen entregas anteriores; no acreditan todos los criterios de aceptación actuales.

## Verificación realizada

| Comprobación | Resultado de esta sesión |
|---|---|
| Entorno | Node 24.12.0, pnpm 12.10.1, Windows |
| `pnpm lint` | PASS, 81 archivos |
| `pnpm typecheck` | PASS |
| `pnpm test` | PASS, 74 pruebas en 11 suites |
| `pnpm -r build` | PASS, incluidos Hub, MCP y bundle web |
| `pnpm test:e2e` | PASS, 5 pruebas: 4 dashboard y 1 escenario MCP real |
| `pnpm audit --prod` | Sin vulnerabilidades conocidas reportadas |

El primer `pnpm check` llegó a Vitest y falló al crear procesos dentro del sandbox (`spawn EPERM`). Tests, build y E2E se repitieron con autorización fuera del sandbox y pasaron. La auditoría npm también se repitió fuera del sandbox tras un error de conexión. Estos fallos de entorno no se atribuyen a la aplicación.

No se verificaron instalación limpia/frozen desde un checkout nuevo, ejecución remota de GitHub Actions, despliegue HTTPS/WSS, carga de red con 100 clientes, restore operativo ni una sesión con dos productos de agente distintos. Playwright sirve la web mediante Vite dev; el Hub del dashboard usa configuración de producción. El proceso stdio prueba el SDK MCP real, sin ejecutar un LLM/CLI de desarrollo.

## Matriz por fase

| Fase del plan ejecutable | Implementación comprobada | Qué queda pendiente |
|---|---|---|
| **0 — Bootstrap y calidad** | Workspaces, lockfile, configuración Zod, TypeScript estricto, Biome, Vitest y builds. CI escrito. | Verificar CI remoto e instalación limpia. Alinear versiones documentadas y efectivas. `testkit` sólo ofrece un ID ficticio; el harness real está en E2E. Las variables de TTL/logging se validan, pero no todas gobiernan la composición del Hub. |
| **1 — Contratos compartidos** | Entidades, errores, fechas, IDs, tamaños, rutas y envelope versionado; 13 tests compartidos. | Corregir cursor cero/decodificación estricta y normalización de slash final. Añadir contratos de idempotencia, renovación y herramientas MCP aún sin schema runtime completo. Completar pruebas de errores públicos y payloads inválidos. Reconciliar nombres de eventos/roles de arquitectura con los contratos reales. |
| **2 — SQLite y dominio** | Tablas base, WAL en disco, servicios, eventos post-commit, transacciones mensaje/lock + evento, conflictos y aislamiento. | Validar destinatarios y TTL de renovación; job de expiración con `lock.expired`; cursor confirmado monotónico; excepción del owner para locks prevista en el plan. Lifecycle de presencia sin heartbeat/expiración automáticos. Servicios acoplados a `DatabaseSync` y al event bus concreto, sin repositorios como interfaces; migración inicial sin mecanismo de versiones para upgrades. |
| **3 — API HTTP/WebSocket** | Rutas de proyecto, sesiones, inbox/ACK, mensajes, estado, locks/renew, team-status, salud, scopes, Origin y tickets. | Invitaciones/provisionamiento y administración de membresías/tokens; matriz completa de roles. Revalidar membresía al consumir ticket y revocación de conexiones activas. Validación uniforme de inputs/request ID y códigos de error; corregir ACK regresivo. Completar contract tests por ruta y negativos. |
| **4 — Adaptador MCP** | Ocho herramientas, stdio, validación de mensaje/estado/claim, HTTP timeout, retry de GET; escenario real de dos procesos aprobado. | Idempotencia persistente y clave en claim; ACK/reanudación propios del adaptador; cursor/reglas en join; release por `lock_id`; validación de join/inbox/wait/release y resultados. Cancelación real de espera; heartbeat/disconnect; exigir join también en team-status. Límite de 4096 caracteres y defensa básica ante secretos obvios previstos en el plan; ampliar pruebas por herramienta y retry de errores reales de fetch. |
| **5 — Dashboard** | Conexión por token en memoria, selección/creación de proyecto, feed, estados, locks, WS/ticket, polling, reconexión y ACK; 4 E2E aprobados. | Flujo UI/E2E de invitación. Verificar contra bundle estático. Mejorar recuperación ante error de inbox/ACK con WS abierto y cargas grandes: el feed vuelve a leer todo el historial en cada invalidación. Presencia/desconexión humana deben reflejar lifecycle del Hub. Añadir pruebas de 429, fallo de ACK y WebSocket permanentemente indisponible. |
| **6 — Seguridad, rendimiento y operación** | STRIDE, pruebas negativas, rate limit, redactor, auditoría parcial, salud, cierre de sockets, backup consistente, índices y prueba de backpressure. | Activar logs JSON redactados; ampliar auditoría a lifecycle y futuras invitaciones/membresías. Limitar por identidad verificada sin guardar Bearer como key; configurar cuotas. Limpieza de tickets y retención. Benchmark real 100 clientes/20 eventos por segundo con cuatro latencias. Verificar restore, señales/supervisor, TLS/WSS y CI. Corregir afirmaciones de STRIDE/bitácora que exceden lo implementado. |

“Pendiente” distingue defectos reproducidos, entregables ausentes, desviaciones estructurales y validaciones aún no ejecutadas; no implica que toda la fase deba rehacerse.

## Hallazgos prioritarios y evidencia

### P1 — Corregir antes de declarar cerrado el MVP compartido

1. **Conflicto de locks evadido por slash final.** Claim de `src/api/` por A y de `src/api/file.ts` por B: ambos aceptados. La normalización conserva `/` final y el comparador añade otro `/` al buscar prefijos. Fuentes: `packages/shared/src/schemas/lock.ts:19`, `apps/hub-server/src/application/services/lock-service.ts:12`. Aceptación: representación canónica y tests de conflictos exactos/ancestro/descendiente con slash final, barras repetidas y Windows.

2. **Renovación evade el TTL máximo.** `POST /locks/:lockId/renew` con `ttl_seconds: 86400` devuelve **200** y persiste 86400, aunque el plan exige máximo 3600. Fuentes: `apps/hub-server/src/app.ts:540`, `application/services/lock-service.ts:169`. Aceptación: entero entre 1 y 3600 en todos los caminos; invalidaciones devuelven 422 y no modifican DB/eventos.

3. **Ticket permite conectar después de retirar membresía.** Emitir ticket válido, eliminar membresía y hacer handshake mediante `injectWS` produce **`connected`**, con un suscriptor registrado. La rama de ticket valida sesión pero omite `checkProjectPermission`. Fuente: `apps/hub-server/src/app.ts:716`. Aceptación: revocar membresía antes de handshake impide conexión; definir y verificar el tratamiento de sockets ya abiertos tras revocación/token expirado.

4. **Reanudación MCP asistida, no integrada.** `join_project` no devuelve el cursor persistido; `check_inbox`/`wait_for_messages` no confirman cursor y el adaptador no mantiene un checkpoint confirmado. El E2E usa `hub.inject` para ACK y pasa el cursor explícitamente al proceso nuevo. Fuentes: `packages/mcp-server/src/server.ts:167`, `e2e/mcp-scenario.spec.ts:72`. Aceptación: definir confirmación tras consumo y demostrar reconexión desde cursor confirmado sin manipular directamente el Hub desde el harness; nunca confirmar eventos aún no entregados al cliente.

5. **Idempotencia ausente.** No hay tabla, clave ni resultado persistido de comando; `claim_module_lock` carece de `idempotency_key`. El cliente evita correctamente retry de mutaciones como mitigación temporal. Aceptación: misma clave/payload devuelve el mismo resultado tras respuesta perdida; payload distinto devuelve 409; una sola entidad y evento tras retry.

6. **Acceso multiusuario incompleto.** No existen invitaciones ni CLI inicial de usuario/token, administración/revocación operables ni matriz completa de roles. Reader ya no escribe mensajes/estado/locks con token `*`; **esa corrección sí existe**. Sin embargo, join con `sessions:write` también pasa por el rechazo genérico de reader, y owner no tiene la excepción de renovación/liberación ajena que describe el plan. Aceptación: registrar y probar la matriz, provisionar identidades distintas, invitaciones hash/TTL/uso único y revocación sin secretos en logs/DB.

### P2 — Completar contratos, lifecycle y aceptación

- **ACK puede retroceder.** Confirmar secuencia 2 y después 1 da 200/200 y deja 1 persistido. `SessionService.updateCursor` actualiza sin comparar (`session-service.ts:91`). Aceptación: ACK viejo/repetido no reduce checkpoint, incluidas carreras.
- **Expiración lógica sin limpieza/evento.** Tras vencer un lock, `getActiveLocks` devuelve cero, pero la fila sigue en DB y no existe evento `lock.expired`. El TTL libera la ruta para nuevas reclamaciones; falta el job explícito del plan y actualización del dashboard por expiración.
- **Destinatario inexistente aceptado.** Mensaje dirigido a `nonexistent-agent` devuelve 201. `MessageService` copia IDs sin resolver pertenencia (`message-service.ts:28`). Falta validar destinatarios del proyecto y probar agentes con nombres iguales en proyectos distintos.
- **Errores/inputs inconsistentes.** Crear proyecto con `name: 123` devuelve 500 `INTERNAL_ERROR`; mensaje de 16385 bytes devuelve 422 `INVALID_INPUT`, aunque el contrato expone `MESSAGE_TOO_LARGE`/413. `decodeCursor(encodeCursor(0))` devuelve `null`, pese a que el inbox produce cursor cero cuando no hay eventos; `parseInt` tampoco exige una representación numérica completa. Añadir validación runtime y contract tests.
- **Presencia desactualizada.** Sólo acciones HTTP explícitas actualizan heartbeat/desconexión. Cerrar un proceso MCP o pulsar desconectar en web no publica disconnect; el Hub no transiciona por inactividad a idle/disconnected. Evitar presentar sesiones antiguas como agentes conectados.
- **Validación/cancelación MCP incompleta.** El schema anunciado no sustituye la validación runtime; `wait_for_messages` no conecta la cancelación MCP a fetch/timers. `get_team_status` sólo comprueba project ID, que puede venir del entorno, sin sesión. Completar pruebas exitosas y negativas por herramienta.
- **Recuperación web ante errores sin señal visible.** `RealtimeManager.drainInbox` captura y oculta fallos; con WS abierto el retry puede depender del siguiente evento/reconexión. El feed pagina desde cero en cada invalidación (`MessageFeed.tsx:22`), por lo que no hay polling periódico redundante, pero sí relectura creciente del historial. Medir y probar estos caminos.

## Pendientes específicos de Fase 6

- `app.ts:85` usa `logger: false`; `LOG_LEVEL` no activa logging JSON. Request ID se acepta del cliente sin validar; aplicar serializer/redacción a errores/logs y no registrar la query del ticket.
- `app.ts:110` utiliza el Bearer en claro como clave de rate limit antes de verificarlo. Las cuotas reales son 300/min/IP y 250/min/token, diferentes de las cifras históricas; una IP compartida limita al conjunto de agentes. No equivale a limitación por sujeto autenticado.
- La auditoría existente cubre creación de proyecto, join, tickets y algunos caminos de locks; heartbeat, disconnect y release por paths no tienen la misma cobertura. Invitaciones/membresías/eliminaciones no pueden declararse auditadas mientras no existan sus flujos.
- El benchmark (`benchmarks/performance-benchmark.test.ts:71`) inserta 100 sesiones, hace 50 escrituras, 50 lecturas y 30 ciclos SQL secuenciales en memoria. No conecta esos agentes a WS, no sostiene 20 eventos/s y no mide p50/p95/p99 de entrega WS real. No prueba capacidad concurrente de producción.
- Backup: snapshot y preservación de destino existente sí comprobados. `DatabaseSync` bloquea el hilo durante `VACUUM INTO`; falta restore integral y prueba con el despliegue/supervisor real.
- CI: workflow presente, pero sin evidencia remota obtenida en esta sesión. Falta instalación frozen limpia y pruebas Windows/Linux. TLS/WSS necesita un destino/proxy concreto aún no indicado.

## Documentación y límites

`ARCHITECTURE.md` conserva fases 0–5 con otra numeración y filas de stack para MCP v2/better-sqlite3/Drizzle que contradicen las ADR-011/012. También declara TypeScript 6/Zod 4; el lockfile usa TypeScript 5.9.3 y Zod 3.25.76; MCP resuelve 1.32.1 dentro de `^1.6.0`. Reconciliar lo aceptado y lo instalado antes de nuevas decisiones de arquitectura; esta auditoría no propone cambiar dependencias.

El STRIDE afirma controles más completos que el código en roles, expiración, logs y descarte automático de secretos/razonamiento. Mantener separados controles existentes, uso esperado y controles pendientes.

Docker, orquestación activa, Redis/PostgreSQL, Git automático y daemon que despierta agentes **siguen diferidos**. Un agente inactivo no se reactiva solo (ADR-006); esto es un límite conocido del MVP, no un entregable que deba añadirse para cerrar 0–6.

## Orden recomendado para cerrar

1. Reconciliar documentación y añadir regresiones de los defectos reproducidos: locks, ticket revocado, ACK y validación.
2. Corregir esos defectos, completar lifecycle de locks/sesiones y contratos compartidos/MCP.
3. Completar matriz de roles, provisionamiento/invitaciones y flujo humano E2E con identidades distintas.
4. Implementar idempotencia persistente y reanudación/cancelación MCP; repetir escenario sin ACK inyectado por el harness.
5. Completar logs/auditoría/límites/retención y ejecutar benchmark HTTP/WS en disco.
6. Verificar CI, build estático, restore, apagado y HTTPS/WSS. Registrar evidencia; entonces evaluar el cierre completo del plan.

Este orden es una recomendación de ejecución para pendientes del alcance vigente, no una nueva decisión de arquitectura ni autorización de despliegue.
