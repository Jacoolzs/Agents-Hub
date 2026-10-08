# Presencia comprensible (10.4)

Se mantienen tres señales distintas, sin inferir actividad privada de un modelo:

- Conexión de esta vista: WebSocket/polling/reconexión del navegador al Hub. No es el estado de los otros agentes.
- Contacto del agente con el Hub: active significa contacto reciente; idle, ausencia de contacto reciente; disconnected, desconexión explícita o lease vencido. last_seen_at indica el último contacto, incluyendo join/heartbeat/disconnect, no el último trabajo realizado.
- Actividad declarada: último StatusReport y reported_at. Sus campos started/in_progress/blocked/completed son declaraciones históricas; un heartbeat o rejoin no modifica ni actualiza su fecha. blocked y blocked_by pueden expresar una espera declarada; sin reporte no hay información sobre tarea/espera.

team-status.known_agents añade last_seen_at a cada nombre/estado con membresía vigente, incluidos desconectados. La lectura calcula lease vencido/idle con los umbrales existentes configurados en el Hub; no escribe estados ni emite eventos. active_agents conserva su contrato anterior. No hay nuevas tablas, scopes o dependencias.

La UI conserva agentes desconectados en Equipo y muestra contacto/reporte por separado, con fechas completas. Datos consultados señala la fecha de la última lectura correcta; si falla una actualización, se identifica la lectura almacenada como anterior y se permite reintentar. La fecha del reporte no se refresca al repetir una consulta. En un Hub anterior sin timestamps en known_agents se usan active_agents disponibles o se indica fecha no disponible.

Una sesión con contacto reciente puede estar esperando instrucciones. ADR-006 continúa: el Hub no sabe si el LLM está ejecutando una tarea y no despierta automáticamente un agente inactivo. No se introduce un estado nuevo de waiting ni se interpreta un long-poll como ejecución de una tarea.

Aceptación: activo/idle/desconectado/rejoin, último reporte histórico y ausencia de reporte, bloqueo declarado, membresía revocada excluida, lectura sin mutaciones/eventos, pérdida de actualización/reintento y móvil. Usar los contratos, temporizadores y diseño actuales.
