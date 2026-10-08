# Agentes lógicos e instancias de conexión

Contrato ADR-021, fase 8.5. `agent_id` es el nombre lógico dentro del proyecto: identifica mensajes dirigidos, estado y locks. `session_id` identifica una generación de conexión; no debe guardarse como ID permanente del agente.

## Una instancia activa

Un proyecto/nombre sólo admite una instancia conectada. Otro usuario sigue sin poder apropiarse de ese nombre. Si una segunda instancia del mismo usuario usa el mismo nombre, el Hub devuelve 409 `STATE_CONFLICT` con una acción: elegir otro nombre, desconectar la instancia actual o esperar su vencimiento. Cerrar el proceso rechazado no desconecta al ganador.

`POST /v1/projects/:projectId/sessions` acepta `{ agent_id, instance_id? }`. `instance_id` es un UUID estable en memoria por proceso o formulario de conexión. Identifica reintentos de join; no es una credencial ni sustituye token/membresía. El mismo identificador sobre una sesión vigente devuelve el mismo `session_id` y checkpoint sin publicar otro `agent.joined`. Cada solicitud aceptada puede dejar una entrada de auditoría; esa auditoría y el join son transaccionales.

El adaptador MCP genera su identificador al arrancar y lo conserva al reintentar una respuesta perdida. La UI lo genera al montar el formulario. No aparece en el catálogo MCP, en snapshots de equipo, ni en almacenamiento del navegador. Un cliente HTTP que omite el campo puede conectar, pero repetir su join contra una sesión vigente devuelve conflicto; debe conservar el `session_id` recibido para sus operaciones o adoptar `instance_id` para reintentos.

## Desconectar, vencer y reanudar

EOF/SIGINT/SIGTERM del adaptador desconecta la sesión. El dashboard desconecta al salir y al recargar mediante `pagehide` y una petición keepalive. Si no se logra entregar esa petición, el lease sigue siendo la vía de recuperación. No se puede tomar una instancia con heartbeat vigente.

Heartbeat del adaptador: 30 segundos. Valores por defecto: idle a los 60 s y vencimiento a los 180 s; `SESSION_EXPIRE_SECONDS` configura el vencimiento (mínimo 90 s). Una sesión idle aún ocupa el nombre. Validación HTTP/WS y join comprueban vencimiento por `last_seen_at`, aunque el mantenimiento todavía no haya cambiado el estado visible.

Después de disconnect o vencimiento, join crea una nueva generación `session_id`, conservando el checkpoint confirmado y la identidad lógica. Tickets efímeros antiguos se retiran de la misma transacción antes de actualizar la clave de sesión. Heartbeat, mensajes, ACK, locks, tickets y otras solicitudes con el ID anterior se rechazan con `SESSION_EXPIRED`; un proceso retrasado no puede desconectar ni avanzar el checkpoint de la nueva generación. Los sockets anteriores se cierran al revalidar.

Los locks permanecen asociados al agente lógico y conservan su TTL; reconectar no los renueva. Los mensajes offline se leen desde el checkpoint conservado. La historia ya eliminada sigue requiriendo la aceptación explícita de [RECOVERY](RECOVERY.md). Esta presencia representa conexión del adaptador, no demuestra actividad del LLM ni despierta agentes inactivos (ADR-006).

La huella idempotente usa el payload de dominio y el agente lógico validado, no el session_id temporal. La misma clave/comando de ese agente puede repetirse después de rotar generación sin duplicar entidad, evento ni auditoría. Un agente distinto, aunque pertenezca al mismo usuario, recibe conflicto al reutilizar esa clave. Una llamada con session_id viejo se rechaza antes de buscar el resultado idempotente.

## Actualización y comprobación

Migración 5 aditiva: `agent_sessions.instance_id`, nullable para sesiones antiguas. Una sesión antigua vigente ocupa el nombre hasta desconectarse o vencer. No se reemplaza una instancia activa durante upgrade. Backup/restore a ruta nueva conserva checkpoint, frontera de retención e identificador de instancia; restaurar no crea un segundo lease automáticamente.

Actualizar Hub y adaptador juntos para adoptar este contrato. Clientes anteriores reciben un conflicto explícito en una colisión; no compartirán sesión silenciosamente. Nuevos clientes requieren un Hub que acepte `instance_id`; no se asume que un binario antiguo implemente ADR-021 ni se garantiza downgrade.

Los registros idempotentes generados por versiones anteriores con session_id en la huella permanecen estrictos: pueden dar IDEMPOTENCY_CONFLICT al reintentar después de actualizar, hasta su TTL de 24 horas. No se reconstruye el payload original desde un hash ni se generan claves nuevas automáticamente; verificar primero si el comando anterior fue aceptado.

`session-instances.test.ts` verifica colisiones HTTP, respuesta perdida, lease configurado, IDs/tickets obsoletos, rollback de auditoría, socket real y upgrade/reapertura desde backup v4. `e2e/mcp-scenario.spec.ts` prueba dos procesos del mismo usuario/nombre, cierre del rechazado y recuperación del ganador. `e2e/dashboard.spec.ts` prueba dos pestañas y recarga con nueva generación.
