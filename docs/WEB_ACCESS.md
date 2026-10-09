# Acceso humano al portal

ADR-023 implementa el núcleo común y su interfaz para personas existentes. No cierra el onboarding: cuenta con contraseña vs enlaces sigue abierta y falta la invitación unificada para personas nuevas. No hay OAuth, correo, proveedor externo ni dependencia nueva.

## Autoridad y credenciales

La administración local puede emitir una entrada de cinco minutos para una persona existente que ya pertenece a un proyecto. El secreto aleatorio se entrega una vez; el enlace lo transporta en fragmento, retirado por la UI antes de llamar a la API. No es un token MCP ni una invitación que cree membresía. El Hub almacena sólo su hash en una tabla aditiva; consumo condicionado por TTL/uso/revocación, emisión de sesión y auditoría comparten transacción. Revalidar membresía al canjear, sin deducir identidad de un nombre público.

La sesión humana usa cookie `__Host-ah_web` en HTTPS, Secure, HttpOnly, SameSite=Strict, Path=/, ocho horas absolutas. HTTP sólo para loopback, con cookie distinta `ah_web` y Path=/v1/. Sin Domain, credencial en JSON, URL, web storage ni logs. El prefijo __Host impide plantación por subdominios; la cookie HTTP local no autentica el portal HTTPS. Se reutiliza auth_tokens con audiencia `agents-hub-browser`; bearer de MCP sigue exigiendo `agents-hub`. Sesión ligada a un proyecto, scopes sin proyectos:write ni comodín, intersectados con rol vigente. Cookie de navegador no sustituye bearer MCP ni administración global.

API con cookie exige Host que corresponda a un origen exacto configurado, Origin exacto del mismo host en mutaciones, rechazo de Origin externo y Sec-Fetch-Site externo. Sin confiar en Forwarded/X-Forwarded-* para crear autoridad. El origen HTTPS se configura explícitamente en CORS_ORIGINS; despliegue/túnel debe conservar Host. Los endpoints de canje/logout tienen la misma protección incluso antes de autenticarse. Rate limit específico para canje. Bearer legacy sigue funcionando; header inválido no cae silenciosamente a cookie válida.

WebSocket conserva tickets efímeros de uso único ligados a sesión/agente/proyecto/token. Cookie sólo autentica la petición HTTP que emite ticket; no reemplaza el ticket del handshake. La revalidación acepta exclusivamente las dos audiencias propias, comprueba revocación/expiración/membresía y sigue cerrando sockets al retirar permisos. Logout revoca sólo la sesión humana actual, sin revocar credenciales MCP independientes.

## Contrato del núcleo

- POST /local-api/users/:userId/web-entry `{project_id}`: autoridad local, persona/membresía existentes, respuesta `{entry_id, secret, expires_at}` de un uso; nunca en Hub público.
- POST /v1/web/entry `{secret}`: canje explícito sin bearer, cookie humana y metadata validada de persona/proyecto/rol/expiración, nunca credencial duradera en el body.
- POST /v1/web/entry/preview `{secret}`: confirma persona/proyecto/rol y TTL del enlace sin consumir ni iniciar sesión. La UI muestra quién entra y pide clic explícito antes del canje; abrir el enlace no cambia la identidad automáticamente.
- GET /v1/web/session: metadata de sesión humana vigente; no acepta bearer personal como login humano.
- POST /v1/web/logout: revoca sesión humana actual y limpia cookie; idempotente si no hay sesión/venció. No cambia membresía, locks ni ACK.

El núcleo no abre registro público, no añade contraseñas y no instala/configura MCP. La invitación actual continúa exigiendo identidad provisionada hasta implementar el canje para personas nuevas.

## Recorrido gráfico para miembros existentes

En el panel privado, selecciona una persona y el proyecto, inicia el Hub y pulsa **Crear entrada al portal**. Para alguien en otro PC comparte primero por Internet; una dirección loopback sólo funciona en el PC anfitrión. El enlace se mantiene oculto, permite mostrar/copiar y descartar, vence en cinco minutos y depende de la dirección actual del túnel.

Al abrirlo, el portal muestra persona, proyecto y permisos antes de **Entrar al proyecto**. Cancelar no consume la entrada ni modifica una sesión humana previa. Si ya existe una sesión, el portal avisa que se cerrará antes de canjear. También se manejan nuevos fragmentos abiertos en la misma pestaña sin recargar; cada entrada requiere confirmación propia.

Después del canje, todas las peticiones humanas usan cookie del mismo origen sin Authorization ni credenciales en JavaScript. Al recargar se consulta metadata y se abre una vista nueva, con nombre de agente `portal-<nombre abreviado>-<sufijo aleatorio>` por página; no se persiste ese identificador. Las pestañas no colisionan ni toman una sesión MCP. La vista nueva lee historial retenido y mantiene su propio ACK; no promete conservar el checkpoint de la vista cerrada. Pagehide intenta desconectar la presencia anterior; si la red lo impide, vence por lease existente.

Al conectar una identidad nueva se destruye el transporte anterior y se limpian eventos, errores y cache de consultas antes de renderizar la vista. No se reutilizan datos administrativos cargados por una persona anterior, incluso dentro del mismo proyecto y mientras se espera la respuesta nueva. Las autorizaciones del servidor siguen siendo la autoridad.

**Cerrar sesión** desconecta la presencia de esta vista y revoca la cookie humana. Un fallo de logout se muestra y no limpia el estado como si hubiera tenido éxito; se puede reintentar o recargar con la cookie aún vigente. No se revocan los tokens personales MCP. Sin cookie/enlace, el formulario manual legacy sigue disponible mientras se completa el onboarding unificado; no es la experiencia final.

## Aceptación y actualización

Pruebas reales de HTTP/SQLite para fronteras de audiencia, Origin/Host/Fetch-Site, TTL/reuso/carrera/revocación/rollback, aislamiento por proyecto y WS real; logout no afecta token MCP. Migración 8 aditiva y backup/reapertura de esquema 7, sin cambios a datos operativos. Antes de actualizar DB real crear backup; no prometer downgrade automático: restaurar copia anterior a ruta nueva para volver al código viejo.

Gates: pnpm check, pnpm build, pnpm test:e2e y git diff --check. e2e/web-access.spec.ts comprueba panel real y entrada/cancelación/reuso/recarga/logout/fallo de logout, ausencia de bearer/storage, teclado y móvil. La aceptación de primera invitación/alta y elección de reentrada todavía requiere entrega y E2E posteriores; este flujo sólo cubre personas ya miembros.
