# Diagnóstico de conexión

Ejecutar desde el repositorio con Node 24, después de instalar y compilar:

```powershell
$env:AGENTS_HUB_URL = "https://TU-HUB"
$env:AGENTS_HUB_TOKEN = "TU_TOKEN_PERSONAL"
$env:AGENTS_HUB_PROJECT_ID = "UUID-DEL-PROYECTO"
pnpm doctor
pnpm doctor --json
```

El comando no crea proyectos, sesiones, tokens, mensajes ni locks y no confirma cursores. Comprueba runtime, presencia de artefactos locales, URL segura, readiness, compatibilidad, identidad y acceso al proyecto. Sólo emite GET; usa un timeout de cinco segundos por solicitud, valida TLS y rechaza redirecciones para evitar enviar el token a otro destino. La presencia de dist no demuestra que el build corresponda al código más reciente: compilar después de actualizar.

Salida: comprobaciones `ok`, `error` o `skipped`, código y acción; JSON añade `ok` global. Exit code 0 si no hay errores, 1 si existe algún error. Si falta token o identidad válida, membresía se omite explícitamente. Un proyecto accesible acredita `projects:read` y membresía, no todos los scopes de escritura.

| Código | Acción |
|---|---|
| `UNSUPPORTED_RUNTIME` | Instalar Node 24 LTS |
| `BUILD_MISSING` | `pnpm install --frozen-lockfile` y `pnpm build` |
| `URL_INVALID` | Usar HTTPS remoto o HTTP localhost, sin credenciales/query/fragmento |
| `UNREACHABLE`, `HUB_NOT_READY` | Revisar proceso, URL del túnel, red, certificado y readiness |
| `HUB_INCOMPATIBLE` | Actualizar Hub y adaptador juntos; requiere contratos actuales anunciados |
| `TOKEN_MISSING`, `UNAUTHENTICATED` | Configurar token propio o emitir uno nuevo si venció/se revocó |
| `PROJECT_ID_INVALID` | Configurar UUID del proyecto |
| `FORBIDDEN` | Aceptar invitación/revisar membresía, binding del token y scopes |

La ruta pública `GET /v1/capabilities` anuncia API v1, revisión de contrato 1 y soporte de instancias exclusivas, recuperación, ACK explícito e idempotencia. Es metadata de protocolo, no evidencia del piloto ni una lista de datos del equipo. Un Hub anterior sin esta ruta es incompatible con el diagnóstico actual.

Si falla la conexión no se infiere incompatibilidad: resolver primero red/TLS/acceso y repetir la comprobación.

Doctor no muestra token, lista de tokens, identidad, nombre del proyecto, secretos en URL ni mensajes arbitrarios devueltos por el servidor. Puede compartirse su salida de diagnóstico; el fichero/configuración que contiene credenciales debe mantenerse privado.

Este comando prepara instalación genérica (9.1). Guías de productos específicos y aceptación humana siguen pendientes en [clientes](compatibility/clients.md) y [piloto](acceptance/pilot.md). Para conectar el adaptador después de resolver errores, seguir [README](../README.md); para leases y reanudación, [sesiones](SESSIONS.md).
