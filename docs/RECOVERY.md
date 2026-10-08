# Recuperación y retención del inbox

Contrato ADR-019/020; incremento de fase 8.4. El inbox es consumo incremental, no navegación histórica. Leer una página no confirma recepción; confirmar sólo después de consumirla. La retención predeterminada sigue siendo 30 días, configurable con `EVENT_RETENTION_DAYS`.

## Frontera y errores

SQLite conserva la última secuencia eliminada (`project_sequences.retained_after`). El mantenimiento elimina un prefijo completo hasta el último evento vencido; esto evita huecos incluso si el reloj cambia. En ese caso excepcional puede retirar también eventos posteriores por fecha pero anteriores por secuencia. Los mensajes se retienen según su fecha; un mensaje cuyo evento desapareció no podrá recuperarse por inbox. Historial navegable es trabajo separado de fase 10.

Un cursor menor que la frontera devuelve HTTP 410 `CURSOR_EXPIRED`, con `details.resume_cursor` y `details.recovery_path`. No cambia checkpoint ni entrega una página vacía como prueba de recepción completa. Un cursor mal formado o futuro devuelve 400 `CURSOR_INVALID`. En una página sin eventos visibles se conserva el cursor anterior y `has_more: false`; mensajes privados no se entregan ni confirman. Las lecturas buscan eventos visibles más allá de batches ocultos.

## Procedimiento HTTP

1. `GET /v1/projects/:projectId/inbox/recovery?session_id=...`: revisar `snapshot` y `resume_cursor`. Requiere membresía, sesión propia y `messages:read`. Incluye estados; incluye agentes sólo con `projects:read` y locks sólo con `locks:read`. Leer este snapshot no confirma historia.
2. Aceptar explícitamente que lo eliminado no se recuperará: `POST /v1/projects/:projectId/inbox/ack` con `{ session_id, cursor: resume_cursor, accept_history_gap: true }`.
3. Consultar inbox desde el cursor confirmado de la respuesta. Consumir los eventos retenidos y confirmar esa página normalmente.

El cursor aceptado debe coincidir con la frontera actual; si el mantenimiento la movió, volver a revisar snapshot. Nunca se salta al evento más reciente: eventos retenidos posteriores siguen disponibles. Si el checkpoint ya estaba más adelantado, no retrocede. El ACK repetido de una página ya confirmada sigue siendo válido tras retención; no implica aceptar nuevos huecos. La aceptación queda auditada, sin cuerpos ni credenciales.

No usar este mecanismo como confirmación de mensajes que nunca se consumieron. Clientes anteriores reciben el error explícito y deben actualizarse o seguir el procedimiento HTTP; no se cambia silenciosamente su ACK.

## MCP y dashboard

MCP expone `get_inbox_recovery` (inspección) y `resync_inbox(cursor, accept_history_gap: true)` (aceptación). La segunda devuelve la primera página retenida sin confirmarla; usar después `ack_inbox` o `check_inbox(cursor)` sólo tras consumirla. `wait_for_messages` propaga el error de retención, no lo transforma en timeout vacío.

El dashboard muestra el aviso en todas las pestañas. «Revisar estado actual» permite inspeccionar agentes, rutas y objetivos autorizados; «Aceptar historial perdido y continuar» reanuda lectura. No hay aceptación automática ni bucle de polling ante este error. Los tokens permanecen en memoria.

## Upgrade y límites

Migración SQL 4 aditiva. Reconstruye frontera desde secuencias persistidas/eventos existentes, incluyendo prefijo, huecos interiores y sufijo ausente de bases anteriores. La frontera se coloca tras el último hueco para no prometer historial completo. No reconstruye datos borrados. Backup antes de actualizar; restore a archivo nuevo conserva frontera, checkpoints y secuencias. No asumir downgrade del binario compatible con este contrato.

Las pruebas `recovery.test.ts` cubren HTTP, permisos, páginas filtradas, ACK explícito/reintento, frontera obsoleta, rollback, cambio de reloj, upgrade desde esquema 3 y backup/reapertura. E2E cubre procesos MCP reales y aceptación en navegador de producción.

El contrato de [instancias](SESSIONS.md) rechaza conexiones simultáneas con el mismo nombre. Reanudar después de desconexión/vencimiento conserva el checkpoint pero rota session_id, invalidando solicitudes antiguas. Usar nombres distintos para procesos simultáneos. La recuperación tampoco despierta agentes inactivos (ADR-006).
