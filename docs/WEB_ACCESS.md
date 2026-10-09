# Acceso humano al portal

ADR-023 implementa el núcleo común del segundo incremento. No cierra el onboarding: cuenta con contraseña vs enlaces sigue abierta, y la UI de canje y registro de personas nuevas está pendiente. No hay OAuth, correo, proveedor externo ni dependencia nueva.

## Autoridad y credenciales

La administración local puede emitir una entrada de cinco minutos para una persona existente que ya pertenece a un proyecto. El secreto aleatorio se entrega una vez; el futuro enlace lo transporta en fragmento, que la UI debe retirar antes de llamar a la API. No es un token MCP ni una invitación que cree membresía. El Hub almacena sólo su hash en una tabla aditiva; consumo condicionado por TTL/uso/revocación, emisión de sesión y auditoría comparten transacción. Revalidar membresía al canjear, sin deducir identidad de un nombre público.

La sesión humana usa cookie `__Host-ah_web` en HTTPS, Secure, HttpOnly, SameSite=Strict, Path=/, ocho horas absolutas. HTTP sólo para loopback, con cookie distinta `ah_web` y Path=/v1/. Sin Domain, credencial en JSON, URL, web storage ni logs. El prefijo __Host impide plantación por subdominios; la cookie HTTP local no autentica el portal HTTPS. Se reutiliza auth_tokens con audiencia `agents-hub-browser`; bearer de MCP sigue exigiendo `agents-hub`. Sesión ligada a un proyecto, scopes sin proyectos:write ni comodín, intersectados con rol vigente. Cookie de navegador no sustituye bearer MCP ni administración global.

API con cookie exige Host que corresponda a un origen exacto configurado, Origin exacto del mismo host en mutaciones, rechazo de Origin externo y Sec-Fetch-Site externo. Sin confiar en Forwarded/X-Forwarded-* para crear autoridad. El origen HTTPS se configura explícitamente en CORS_ORIGINS; despliegue/túnel debe conservar Host. Los endpoints de canje/logout tienen la misma protección incluso antes de autenticarse. Rate limit específico para canje. Bearer legacy sigue funcionando; header inválido no cae silenciosamente a cookie válida.

WebSocket conserva tickets efímeros de uso único ligados a sesión/agente/proyecto/token. Cookie sólo autentica la petición HTTP que emite ticket; no reemplaza el ticket del handshake. La revalidación acepta exclusivamente las dos audiencias propias, comprueba revocación/expiración/membresía y sigue cerrando sockets al retirar permisos. Logout revoca sólo la sesión humana actual, sin revocar credenciales MCP independientes.

## Contrato del núcleo

- POST /local-api/users/:userId/web-entry `{project_id}`: autoridad local, persona/membresía existentes, respuesta `{entry_id, secret, expires_at}` de un uso; nunca en Hub público.
- POST /v1/web/entry `{secret}`: canje explícito sin bearer, cookie humana y metadata validada de persona/proyecto/rol/expiración, nunca credencial duradera en el body.
- POST /v1/web/entry/preview `{secret}`: confirma persona/proyecto/rol y TTL del enlace sin consumir ni iniciar sesión. La futura UI debe mostrar quién entra y pedir clic explícito antes del canje; abrir el enlace no cambia la identidad automáticamente.
- GET /v1/web/session: metadata de sesión humana vigente; no acepta bearer personal como login humano.
- POST /v1/web/logout: revoca sesión humana actual y limpia cookie; idempotente si no hay sesión/venció. No cambia membresía, locks ni ACK.

El núcleo no abre registro público, no añade contraseñas y no instala/configura MCP. UI de entrada/invitación y reentrada se completan a continuación; la invitación actual continúa exigiendo identidad provisionada hasta implementar el canje para personas nuevas.

## Aceptación y actualización

Pruebas reales de HTTP/SQLite para fronteras de audiencia, Origin/Host/Fetch-Site, TTL/reuso/carrera/revocación/rollback, aislamiento por proyecto y WS real; logout no afecta token MCP. Migración 8 aditiva y backup/reapertura de esquema 7, sin cambios a datos operativos. Antes de actualizar DB real crear backup; no prometer downgrade automático: restaurar copia anterior a ruta nueva para volver al código viejo.

Gates: pnpm check, pnpm build, pnpm test:e2e y git diff --check. La aceptación gráfica completa no está cubierta por este núcleo y exige E2E posterior con primera invitación, entrada, recarga, navegación y salida sin copiar tokens/UUID.
