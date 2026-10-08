# Cierre verificado para piloto compartido

Fecha: 2026-10-07. Se corrigieron defectos de locks, cursor/ACK, autorización WebSocket y lifecycle, y se añadieron invitaciones/membresías/tokens operables, idempotencia persistente, migraciones, logging y retención. El PC puede alojar un piloto mediante `pnpm share`. Instrucciones en [OPERATIONS.md](OPERATIONS.md).

## Evidencia

- Vitest: 97 pruebas, locks canónicos y TTL, expiración/evento único, ACK monotónico, idempotencia/rollback/reinicio, roles/scopes, invitaciones/revocación/TTL/uso único, upgrade de DB antigua, límite de frames WS y restore íntegro.
- Instalación frozen, lint/typecheck/tests/build comprobados en copia limpia tras retirar cachés TypeScript versionadas. Auditoría de dependencias de producción sin vulnerabilidades conocidas.
- E2E contra bundle estático: flujo humano, usuarios distintos, aceptación de invitación, mensajes, locks, desconexión/reconexión, polling con WS indisponible y ACK fallido sin duplicados.
- Dos procesos MCP reales por stdio: usuarios distintos, mensaje dirigido, estado, conflicto, expiración, ACK explícito, reanudación propia, idempotencia, EOF y espera cancelable.
- [Carga de red](evidence/network-benchmark.json): 100 clientes, 600 mensajes y 60 eventos de locks en 30.36 s (21.74 eventos/s; 19.76 mensajes/s), 60000 entregas WS de mensajes, cero pérdidas/duplicados/errores. Inbox/ACK cada 1 s y emisor con hasta cinco peticiones en vuelo. p95 local: mensaje 138.58 ms, inbox 233.88 ms, claim 212.42 ms, entrega WS 136 ms. La [variante secuencial](evidence/network-benchmark-serial.json), con polling cada 500 ms, entregó todo pero no alcanzó el ritmo objetivo; no se certifica capacidad para esa carga.
- [Smoke público](evidence/share-smoke.json): HTTPS/WSS con TLS válido, dashboard estático en mismo origen, dos identidades, navegador con ticket, logs sin secretos, cierre por supervisor con WS 1001 y SQLite íntegro tras reinicio. Túnel efímero cerrado al finalizar.

## Límites y pendientes explícitos

El piloto está publicado en `main`. CI Linux/Windows pasó para `8870c28`, incluida instalación frozen, check, build, auditoría y E2E: [ejecución verificada](https://github.com/Jacoolzs/Agents-Hub/actions/runs/37722402150). Falta una sesión humana con dos productos de agente/LLM distintos. La prueba stdio acredita el protocolo/adaptador, no un agente dormido ni el comportamiento del LLM.

Los servicios mantienen SQL directo sobre SQLite; el plan propone repositorios abstractos, todavía pendiente como refactor estructural. No bloquea los controles funcionales del piloto, pero impide afirmar que todos los entregables arquitectónicos 0–6 están terminados. Quick Tunnel es temporal y requiere PC/terminal activos; operación permanente necesita dominio/túnel estable y supervisor persistente. El benchmark es local y no fija un SLO de Internet.

Auditoría histórica previa a correcciones: [REVIEW_PHASES_0_6.md](REVIEW_PHASES_0_6.md). Sus fallos reproducidos describen el estado anterior; estado vigente y decisiones en `BITACORA.md`. Docker, orquestación y daemon siguen diferidos; los locks son coordinación, no exclusión del filesystem.
