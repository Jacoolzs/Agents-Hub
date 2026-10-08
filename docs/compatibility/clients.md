# Compatibilidad de clientes MCP

Estado: pendiente de aceptación humana (fase 7.1). Las pruebas del SDK por stdio no acreditan compatibilidad de un producto LLM concreto.

| Participante | Producto y versión | SO y versión | Transporte | Instalación | Escenario completo | Evidencia |
|---|---|---|---|---|---|---|
| Anfitrión | Por elegir | Por registrar | stdio local | Pendiente | Pendiente | — |
| Amigo | Por elegir; distinto del anfitrión | Por registrar | stdio local | Pendiente | Pendiente | — |

Registrar la versión realmente usada, fecha, commit de Hub/adaptador y documentación oficial consultada al configurar cada cliente. No copiar tokens, variables de entorno completas ni prompts privados.

El adaptador usa Node 24, MCP SDK v1, stdin/stdout para JSON-RPC y stderr para diagnóstico. Cada proceso simultáneo necesita un nombre de agente distinto; [ADR-021](../SESSIONS.md) rechaza colisiones, permite reintentos de la misma instancia y conserva checkpoint al rotar la generación tras desconexión. Un agente inactivo no se despierta automáticamente: registrar cuándo la persona tuvo que pedir una consulta del inbox (ADR-006).

Guías generales: [README](../../README.md), [operación](../OPERATIONS.md), [protocolo de aceptación](../acceptance/pilot.md), [recuperación](../RECOVERY.md).

Evidencia automatizada disponible: `e2e/mcp-scenario.spec.ts` ejecuta dos procesos de adaptador por stdio, mensajes dirigidos, ACK/reinicio, cancelación, locks y recuperación tras retención. Debe registrarse como evidencia técnica, separada de los resultados humanos.
