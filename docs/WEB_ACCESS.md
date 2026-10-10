# Acceso humano al portal

ADR-023 implementa el núcleo común y ADR-024 la primera invitación. El usuario acepta cuentas locales con contraseña el 2026-10-10 (ADR-025). No hay OAuth, correo, proveedor externo ni dependencia nueva. La entrega de cuentas está en implementación; no equivale a cerrar instalador/MCP/listener/operación.

## Cuenta local y regreso al portal (ADR-025)

Después de aceptar una entrada válida, `POST /v1/web/account {password}` permite establecer la primera contraseña con cookie humana vigente. No hay registro público ni selección de otra identidad; una cuenta existente no se sobrescribe desde otro enlace. `GET /v1/web/account` devuelve sólo si la cuenta actual tiene contraseña. Entrada de un uso sigue siendo alternativa de acceso autorizada por el anfitrión; no se elimina compatibilidad previa.

`POST /v1/web/login {username,password,project_id?}` verifica contraseña antes de revelar proyectos. Si hay uno, inicia sesión; si hay varios, devuelve sólo su lista para elegir y repetir login con proyecto. Nunca emite sesión general ni acepta proyectos ajenos. Usuario inexistente, contraseña incorrecta y acceso retirado usan el mismo error. La UI conserva contraseña sólo durante el envío/selección, permite pegar/autocompletar y la borra al terminar/cancelar. Cookie, audiencias, scopes y logout de ADR-023 se conservan.

Migración10 añade web_accounts sin cambiar usuarios, membresías ni tokens MCP. Hash scrypt versionado por este esquema, N=131072/r=8/p=1, sal aleatoria16bytes y salida64bytes; asíncrono, maxmem160MiB, una derivación concurrente por proceso sin cola ilimitada. Contraseñas15–128 puntos de código Unicode sin recorte/normalización ni reglas artificiales de símbolos; el límite de entrada256 unidades UTF-16 permite caracteres suplementarios sin truncarlos. IP15/min y cuenta5/5min antes de hashing; errores de saturación429 y reintento manual. Límites son por proceso y no sobreviven reinicio; no se afirma protección distribuida ni MFA/lista de contraseñas comprometidas. Referencias verificadas: [almacenamiento OWASP](https://cheatsheetseries.owasp.org/cheatsheets/Password_Storage_Cheat_Sheet.html) y [autenticación OWASP](https://cheatsheetseries.owasp.org/cheatsheets/Authentication_Cheat_Sheet.html).

Recuperación sólo desde administración privada: `POST /local-api/users/:userId/reset-web-account` elimina hash, revoca todas las cookies humanas de la persona y entradas pendientes, conserva membresías y MCP, todo con auditoría/transacción. Después emitir entrada nueva para un proyecto existente; usuario elige otra contraseña. No se muestra ni entrega contraseña al administrador. Revocación durante hashing impide alta/login por revalidación dentro de la transacción; rollback conserva estado previo. Revalidación WS existente invalida sockets/tickets asociados. Actualización requiere backup y no ofrece downgrade automático.

## Autoridad y credenciales

La administración local puede emitir una entrada de cinco minutos para una persona existente que ya pertenece a un proyecto. El secreto aleatorio se entrega una vez; el enlace lo transporta en fragmento, retirado por la UI antes de llamar a la API. No es un token MCP ni una invitación que cree membresía. El Hub almacena sólo su hash en una tabla aditiva; consumo condicionado por TTL/uso/revocación, emisión de sesión y auditoría comparten transacción. Revalidar membresía al canjear, sin deducir identidad de un nombre público.

La sesión humana usa cookie `__Host-ah_web` en HTTPS, Secure, HttpOnly, SameSite=Strict, Path=/, ocho horas absolutas. HTTP sólo para loopback, con cookie distinta `ah_web` y Path=/v1/. Sin Domain, credencial en JSON, URL, web storage ni logs. El prefijo __Host impide plantación por subdominios; la cookie HTTP local no autentica el portal HTTPS. Se reutiliza auth_tokens con audiencia `agents-hub-browser`; bearer de MCP sigue exigiendo `agents-hub`. Sesión ligada a un proyecto, scopes sin proyectos:write ni comodín, intersectados con rol vigente. Cookie de navegador no sustituye bearer MCP ni administración global.

API con cookie exige Host que corresponda a un origen exacto configurado, Origin exacto del mismo host en mutaciones, rechazo de Origin externo y Sec-Fetch-Site externo. Sin confiar en Forwarded/X-Forwarded-* para crear autoridad. El origen HTTPS se configura explícitamente en CORS_ORIGINS; despliegue/túnel debe conservar Host. Los endpoints de canje/logout tienen la misma protección incluso antes de autenticarse. Rate limit específico para canje. Bearer legacy sigue funcionando; header inválido no cae silenciosamente a cookie válida.

WebSocket conserva tickets efímeros de uso único ligados a sesión/agente/proyecto/token. Cookie sólo autentica la petición HTTP que emite ticket; no reemplaza el ticket del handshake. La revalidación acepta exclusivamente las dos audiencias propias, comprueba revocación/expiración/membresía y sigue cerrando sockets al retirar permisos. Logout revoca sólo la sesión humana actual, sin revocar credenciales MCP independientes.

## Primera invitación unificada

Autoridad exclusivamente local: `POST /local-api/web-invitations` recibe proyecto, rol reader/collaborator/maintainer, duración60–604800 segundos (default3600) y persona explícita: `{kind:"new", username}` o `{kind:"existing", user_id}`. Un nombre ocupado requiere seleccionar la persona existente; nunca se reutiliza automáticamente ni se abre registro público. La nueva identidad se reserva al emitir, sin contraseña ni token MCP; no obtiene membresía hasta confirmar el canje. Una persona ya miembro usa la entrada existente, sin cambiar su rol por invitación.

Migración9 añade `pending_role` nullable a web_entries: null conserva entradas para miembros; valor identifica invitación ligada a persona/proyecto/rol. Preview muestra el permiso propuesto sin concederlo. Canje consume entrada, comprueba ausencia de membresía, crea membresía, registra evento/auditoría y emite cookie en la misma transacción. Si otro flujo añadió la membresía, se rechaza sin alterar permisos; rollback conserva la entrada sin consumir. No se admite owner ni transferencia implícita.

`GET /local-api/web-invitations` lista metadata sin hashes/secretos, incluidos estados de consumo/revocación para control. `DELETE /local-api/web-invitations/:entryId` revoca sólo una invitación pendiente, sin retirar una membresía ya aceptada. Cancelar preview no consume. Expiración/revocación no borra la identidad reservada; puede seleccionarse explícitamente para otra invitación. El enlace conserva secreto de un uso en fragmento y depende del origen disponible. Cambiar túnel no convierte URL temporal en estable.

En **Proyectos e invitaciones**, usa **Invitar con un enlace**: persona nueva o selección explícita de existente, proyecto y permisos. Duración de una hora por defecto, un día o siete días en opciones adicionales. Inicia el Hub y comparte por Internet antes de invitar a otro PC; sin compartir, la UI avisa que el enlace sólo funciona en este PC. El resultado oculto recibe foco y ofrece Mostrar/Copiar/Descartar. Si falla la actualización posterior, el enlace emitido se conserva en pantalla; no vuelvas a crear la persona automáticamente.

La lista muestra Pendiente/Aceptada/Revocada/Vencida y el permiso; **Actualizar estado** consulta cambios. Revocar pide confirmación y retira el enlace de pantalla si es el mismo. No se recupera el secreto desde la lista: para reemitir, revoca la pendiente y selecciona explícitamente la identidad existente. El formulario legacy continúa plegado como opción avanzada, no como recorrido principal.

Este contrato resuelve primera entrada; ADR-025 añade contraseña para volver, sin conectar la IA. Reutiliza SQLite, eventos y autoridad cookie, sin dependencia/servicio nuevo. HTTP/DB cubre revocación, TTL, reuso, conflictos/carreras, rollback sin eventos fantasma y upgrade8/backup. E2E del formulario usa nuevo participante sin token/UUID/comandos, consentimiento, mensaje/recarga/logout, metadata y revocación, teclado/móvil y privacidad.

## Contrato del núcleo

- POST /local-api/users/:userId/web-entry `{project_id}`: autoridad local, persona/membresía existentes, respuesta `{entry_id, secret, expires_at}` de un uso; nunca en Hub público.
- POST /v1/web/entry `{secret}`: canje explícito sin bearer, cookie humana y metadata validada de persona/proyecto/rol/expiración, nunca credencial duradera en el body.
- POST /v1/web/entry/preview `{secret}`: confirma persona/proyecto/rol y TTL del enlace sin consumir ni iniciar sesión. La UI muestra quién entra y pide clic explícito antes del canje; abrir el enlace no cambia la identidad automáticamente.
- GET /v1/web/session: metadata de sesión humana vigente; no acepta bearer personal como login humano.
- POST /v1/web/logout: revoca sesión humana actual y limpia cookie; idempotente si no hay sesión/venció. No cambia membresía, locks ni ACK.

El núcleo no abre registro público ni instala/configura MCP. Las cuentas se añaden mediante ADR-025, sin cambiar el canje atómico original. La invitación legacy continúa exigiendo identidad provisionada y token personal; el nuevo canje web admite una identidad reservada desde administración local sin token MCP.

## Recorrido gráfico para miembros existentes

En el panel privado, selecciona una persona y el proyecto, inicia el Hub y pulsa **Crear entrada al portal**. Para alguien en otro PC comparte primero por Internet; una dirección loopback sólo funciona en el PC anfitrión. El enlace se mantiene oculto, permite mostrar/copiar y descartar, vence en cinco minutos y depende de la dirección actual del túnel.

Al abrirlo, el portal muestra persona, proyecto y permisos antes de **Entrar al proyecto**. Cancelar no consume la entrada ni modifica una sesión humana previa. Si ya existe una sesión, el portal avisa que se cerrará antes de canjear. También se manejan nuevos fragmentos abiertos en la misma pestaña sin recargar; cada entrada requiere confirmación propia.

Después del canje, todas las peticiones humanas usan cookie del mismo origen sin Authorization ni credenciales en JavaScript. Al recargar se consulta metadata y se abre una vista nueva, con nombre de agente `portal-<nombre abreviado>-<sufijo aleatorio>` por página; no se persiste ese identificador. Las pestañas no colisionan ni toman una sesión MCP. La vista nueva lee historial retenido y mantiene su propio ACK; no promete conservar el checkpoint de la vista cerrada. Pagehide intenta desconectar la presencia anterior; si la red lo impide, vence por lease existente.

Al conectar una identidad nueva se destruye el transporte anterior y se limpian eventos, errores y cache de consultas antes de renderizar la vista. No se reutilizan datos administrativos cargados por una persona anterior, incluso dentro del mismo proyecto y mientras se espera la respuesta nueva. Las autorizaciones del servidor siguen siendo la autoridad.

**Cerrar sesión** desconecta la presencia de esta vista y revoca la cookie humana. Un fallo de logout se muestra y no limpia el estado como si hubiera tenido éxito; se puede reintentar o recargar con la cookie aún vigente. No se revocan los tokens personales MCP. Sin cookie/enlace, se ofrece usuario/contraseña; conexión manual queda plegada como avanzada. Si el servidor no soporta API humana, permanece el formulario legacy.

## Aceptación y actualización

Pruebas reales de HTTP/SQLite para fronteras de audiencia, Origin/Host/Fetch-Site, TTL/reuso/carrera/revocación/rollback, aislamiento por proyecto y WS real; logout no afecta token MCP. Migración8 aditiva y backup/reapertura de esquema7; migración9 conserva entradas de esquema8 con rol pendiente null y permite backup/reapertura de invitaciones ligadas. Sin cambios a datos operativos. Antes de actualizar DB real crear backup; no prometer downgrade automático: restaurar copia anterior a ruta nueva para volver al código viejo.

Gates: pnpm check, pnpm build, pnpm test:e2e y git diff --check. e2e/web-access.spec.ts comprueba panel real y entrada/cancelación/reuso/recarga/logout/fallo de logout, ausencia de bearer/storage, teclado y móvil. e2e/web-invitation.spec.ts incluye alta, vuelta con contraseña, recuperación local, rechazo de contraseña anterior y nueva entrada. HTTP/SQLite/crypto cubren migración9→10/backup/reopen, hash real, proyectos autorizados, límites y fencing/rollback. Ver bitácora para resultados observados de cada versión; no atribuir evidencia anterior a cambios posteriores.
