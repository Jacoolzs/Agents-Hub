# Compatibilidad de clientes MCP

Estado: piloto humano parcial registrado el 2026-10-08; ambos participantes usaron Antigravity CLI según confirmación del usuario. Pendiente de aceptación completa (fase 7.1), que exige productos distintos. Las pruebas del SDK por stdio no acreditan compatibilidad de un producto LLM concreto.

| Participante | Producto y versión | SO y versión | Transporte | Instalación | Escenario completo | Evidencia |
|---|---|---|---|---|---|---|
| Anfitrión | Antigravity CLI; instalación actual 1.3.2, versión de ayer no confirmada | Windows; versión por registrar | stdio local | Conectado en piloto | Parcial: mensajes/hilos/locks | BITACORA.md, piloto 2026-10-08; `agy --version` comprobado 2026-10-09 |
| Amigo | Antigravity CLI; versión por registrar | Linux; distribución/versión por registrar | stdio local | Conectado en piloto | Parcial: mensajes/hilos/locks | BITACORA.md, piloto 2026-10-08; producto confirmado por usuario 2026-10-09 |

## Inspección local del anfitrión — 2026-10-09

`agy --version` devuelve `1.3.2`; ejecutable `C:/Users/orlan/AppData/Local/agy/bin/agy.exe`. `antigravity --version` devuelve `1.104.0` para el lanzador del editor, producto distinto del CLI; no confundir sus versiones.

`agy mcp add --help` permite registrar/actualizar servidores stdio o HTTP y variables de entorno; un asistente puede usar este mecanismo sin pedir edición manual de JSON. Como también actualiza nombres existentes, debe preservar la configuración previa y detectar colisiones antes de escribir. No se ejecutó `mcp add` ni se inspeccionaron configuraciones con credenciales en esta revisión.

`agy --help` declara `--input-format stream-json`: en print mode recibe NDJSON por stdin y ejecuta un turno por mensaje, requiriendo `--output-format stream-json`. `agy changelog` atribuye esta capacidad a 1.1.15 y describe un driver persistente con una conversación. Es evidencia de una vía de integración para un launcher que gestione su propio proceso CLI; no se ha probado recepción real, formato de payload, permisos, concurrencia, ACK, consumo de cuota ni control de una TUI ya abierta. Tampoco acredita activación por notificación MCP. Mantener ADR-006 hasta decidir y verificar esa integración.

Fuentes oficiales consultadas: [MCP](https://www.antigravity.google/docs/mcp/), [referencia CLI](https://www.antigravity.google/docs/cli/reference/) y ayuda/changelog del binario instalado. [Sidecars](https://www.antigravity.google/docs/sidecars/) declara disponibilidad en Antigravity 2.0; no extrapolar al CLI. No se iniciaron turnos de IA ni se cambiaron configuración, credenciales o sesiones del usuario.

Registrar la versión realmente usada, fecha, commit de Hub/adaptador y documentación oficial consultada al configurar cada cliente. No copiar tokens, variables de entorno completas ni prompts privados.

El adaptador usa Node 24, MCP SDK v1, stdin/stdout para JSON-RPC y stderr para diagnóstico. Cada proceso simultáneo necesita un nombre de agente distinto; [ADR-021](../SESSIONS.md) rechaza colisiones, permite reintentos de la misma instancia y conserva checkpoint al rotar la generación tras desconexión. Un agente inactivo no se despierta automáticamente: registrar cuándo la persona tuvo que pedir una consulta del inbox (ADR-006).

Guías generales: [README](../../README.md), [operación](../OPERATIONS.md), [protocolo de aceptación](../acceptance/pilot.md), [recuperación](../RECOVERY.md).

Evidencia automatizada disponible: `e2e/mcp-scenario.spec.ts` ejecuta dos procesos de adaptador por stdio, mensajes dirigidos, ACK/reinicio, cancelación, locks y recuperación tras retención. Debe registrarse como evidencia técnica, separada de los resultados humanos.
