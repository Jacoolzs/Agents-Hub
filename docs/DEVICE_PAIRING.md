# Emparejamiento MCP: núcleo previo al asistente

## Contrato aceptado de este incremento

Un compañero solicita una vinculación sin crear usuarios ni sesiones de agentes. El Hub devuelve un identificador de solicitud público de 128 bits y un secreto de dispositivo de 256 bits. La persona entra al portal existente, revisa dispositivo/proyecto y confirma explícitamente con su cookie humana vigente. Sólo puede vincular su propia identidad y el proyecto de esa cookie; no hay selección arbitraria de usuario, scopes o rol. La solicitud vence en cinco minutos.

El compañero canjea su secreto por un bearer MCP de audiencia `agents-hub`, limitado a ese proyecto y con duración de 30 días. Scopes explícitos: projects:read, sessions:write, messages:read/write, locks:read/write y members:read; nunca projects:write, members:write o comodín. Se revalida membresía al confirmar y al canjear; las rutas existentes intersectan scopes y rol vigente. La cookie `agents-hub-browser` nunca se convierte ni se transmite al compañero. El secreto de dispositivo y el bearer sólo se persisten como hashes SHA256 en el Hub. Confirmación, consumo, emisión y auditoría usan la unidad transaccional existente: fallo de auditoría revierte todo. El consumo exige TTL/estado en la misma operación SQL.

No es OAuth ni un endpoint MCP remoto: protocolo propio de bootstrap para el adaptador stdio existente. No garantiza que el dispositivo mostrado sea confiable: quien introduce/confirma una solicitud debe reconocerla; compartir el identificador puede inducir una autorización engañosa. La UI posterior debe advertir esto y mostrar identidad/proyecto/etiqueta, nunca aprobar por abrir un enlace. Etiquetas no son prueba de posesión ni attestation. La posesión real para canjear requiere el secreto de dispositivo.

## API de núcleo (sin UI todavía)

- `POST /v1/devices/requests` `{label}`: devuelve `{request_id, device_secret, expires_at}`. Sin autenticación; cuota adicional 10/min por IP compartida con el canje. Etiqueta 1–80 caracteres, sin controles/secretos obvios. No aceptar URL de callback ni scopes elegibles.
- `POST /v1/web/devices/preview` `{request_id}`: cookie humana/Origin; muestra etiqueta, vencimiento y perfil humano actual. No consume ni autoriza.
- `POST /v1/web/devices/approve` `{request_id, confirm:true}`: cookie humana/Origin; asocia persona/proyecto de esa cookie, una sola vez. No devuelve bearer.
- `POST /v1/devices/exchange` `{device_secret}`: canje de un solo uso; pendiente/ausente/revocada/vencida indistinguibles401. Devuelve `{token, token_id, project_id, expires_at}` sólo al poseedor. Sin redirects ni transporte HTTP externo en producción (la terminación TLS del Hub sigue siendo responsabilidad del despliegue).
- `GET /v1/web/devices`: metadatos de credenciales emitidas propias del proyecto de la cookie; sin hashes/secrets.
- `POST /v1/web/devices/:tokenId/revoke` `{confirm:true}`: revoca sólo credencial de dispositivo propia/de ese proyecto y revalida sockets. No cambia contraseña, cuenta, membresía ni otros tokens. Revocar repetidamente es inocuo.

Respuesta `Cache-Control:no-store`; schemas estrictos de entrada/salida; logger existente no registra cuerpos ni secretos. Solicitudes no consumidas quedan inutilizables al vencer; limpieza/retención física pendiente, no se promete límite persistente por una cuota en memoria. Una respuesta de canje perdida no se recupera guardando bearer en claro: solicitar nueva vinculación, revocar la anterior desde la lista. No retry automático que genere otra credencial silenciosamente. Las solicitudes ya aprobadas no dependen de mantener abierta la cookie original; quitar membresía sí impide su canje y revocar el bearer corta futuras llamadas.

## Almacén nativo e integración del asistente

ADR-027 fija el almacén compartido en config: DPAPI CurrentUser/ACL Windows y secret-tool/Secret Service persistente opcional Linux, sin fallback en claro. Contrato, límites y recuperación en [CREDENTIAL_STORE.md](CREDENTIAL_STORE.md). La API de almacenamiento no está todavía integrada con el canje, MCP o pantalla. No configurar clientes reales ni escribir tokens en JSON, argumentos, web storage, logs o URLs.

La próxima UI integra iniciar/confirmar/guardar/diagnosticar/exportar, reutilizando doctor, exportador MCP, runtime y panel. Adaptadores sólo con versión/documentación comprobadas y sin sobrescribir configuración ajena; salida genérica para desconocidos. Este núcleo por sí solo NO entrega una conexión sin comandos. Listener posterior, ADR-006 intacto.

## Aceptación de este corte

SQLite/HTTP con datos efímeros: separación de audiencias, consentimiento explícito, preview sin mutación, idempotencia limitada/uso único, TTL, membresía retirada, aislamiento usuario/proyecto, scopes sin administración de proyectos, rollback de auditoría, revocación, secretos ausentes de DB/listas y upgrade10→11/backup/reapertura. No simula instalación o almacenamiento nativo ni certifica clientes/piloto humano.

Actualizar Hub abre migración aditiva11; hacer backup antes según OPERATIONS. No abrir esa DB con un Hub antiguo para rollback: restaurar el backup previo a una ruta nueva y conservar la DB11. Este corte no migra perfiles personales ni prueba downgrade. Test E2E usa el adaptador compilado en proceso stdio real para enviar y comprobar rechazo tras revocación; aprobación HTTP se ejerce con inyección Fastify, no una pantalla todavía inexistente. Todas las identidades/DB son de pruebas.
