# Respuestas y destinatarios (10.3)

Contrato aditivo sobre mensajes e historial existentes. Sin dependencias nuevas.

## Referencia y conversación

`reply_to_message_id` es un UUID opcional en HTTP `POST /messages` y MCP `send_team_message`. El servidor busca el padre retenido dentro del proyecto y visible para el agente autenticado antes de aceptar la respuesta. Ausente, privado ajeno o de otro proyecto producen el mismo `INVALID_INPUT` sin detalles del padre. El canal debe coincidir con el del padre.

Responder exige scopes messages:write y messages:read además del rol/membresía. Ejemplo MCP: send_team_message con body, channel del original y reply_to_message_id recibido en inbox; omitir recipient_agent_ids conserva la audiencia privada. Mantener una idempotency_key estable sólo al reintentar el mismo payload.

La respuesta conserva `reply_to_message_id` y recibe `thread_id` del servidor (el del padre o su message_id si es raíz). No se aceptan thread_id del cliente ni referencias deducidas del correlation_id. `correlation_id` mantiene su contrato libre de 1–100 caracteres y no prueba autorización; en una respuesta que lo omite se propaga el del padre o se usa el thread_id como correlación. Una correlación explícita permanece libre y no modifica el hilo canónico.

El historial admite filtro `thread` UUID: raíz y respuestas de ese hilo, siempre con visibilidad previa a paginación y cursor ligado a filtros. No confirma inbox. `GET /messages/:messageId?session_id=...` permite consultar un padre visible sin ACK; usa el mismo error genérico para una referencia no disponible. Si la retención borró el padre, se puede leer el resto visible del hilo pero no responder al padre borrado ni reconstruir su contenido.

## Privacidad

La audiencia de un mensaje privado es remitente más destinatarios. La audiencia de una respuesta debe ser subconjunto de la del padre inmediato, incluyendo al remitente de la respuesta. Omitir destinatarios infiere los demás participantes autorizados; si sólo queda el propio remitente, conserva un destinatario propio para evitar broadcast accidental. Una lista vacía explícita o un destinatario fuera de la audiencia de un padre privado se rechaza. Respuestas a broadcast pueden ser públicas o privadas. Cada respuesta restringida reduce la audiencia de sus descendientes.

Las comprobaciones del padre, destinatarios y la escritura/evento suceden en la misma transacción. Auditoría e idempotencia siguen usando el comando existente. Un retry confirmado conserva la respuesta original aunque haya cambiado la retención; nunca reutilizar su clave con payload distinto.

## Directorio y UI

`team-status.known_agents` añade `{agent_id,status}` de agentes registrados con membresía vigente, incluidos desconectados. No cambia `active_agents` ni promete que un agente inactivo reciba avisos automáticos (ADR-006). El servidor valida destinatarios otra vez al enviar.

UI: selección múltiple etiquetada, público/privado explícitos, Responder con contexto y audiencia limitada, cancelar respuesta y Ver conversación. El original se muestra desde mensajes ya cargados o una consulta autorizada al expandirlo. No se guardan contenido ni credenciales en almacenamiento web.

Migración 7 añade columnas nullable reply_to_message_id/thread_id e índice de hilo. No usa FK al padre: la retención puede borrar el original sin borrar respuestas retenidas. Mensajes anteriores mantienen correlaciones y no se transforman en respuestas. Clientes anteriores siguen enviando mensajes sin campos nuevos; clientes con esquemas de salida estrictos deben actualizarse para leer respuestas. Capacidad anunciada: message_replies.

Validar: privados→broadcast/terceros, parent inexistente/cruzado/privado, descendientes restringidos, lectores y scopes, destinatarios desconectados/revocados, paginación/cursor de hilo sin ACK, rollback/idempotencia, migración 6→7, HTTP/MCP stdio/UI y diseño responsive.
