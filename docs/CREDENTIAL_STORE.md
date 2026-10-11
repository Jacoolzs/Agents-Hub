# Almacén nativo de credenciales

ADR-027: primer incremento previo a integración MCP y asistente. Se utiliza `@agents-hub/config`, sin nueva dependencia npm ni servicio propio.

Windows: DPAPI `CurrentUser` y ACL exclusiva del usuario; sólo se escribe cifrado. El contexto incluye directorio e identificador, no una clave propia. No se usa `LocalMachine`. Copiar a otro perfil o mover el directorio no es recuperación. [Contrato Microsoft](https://learn.microsoft.com/en-us/dotnet/api/system.security.cryptography.protecteddata?view=netframework-4.8).

Linux: `secret-tool` de libsecret, opcional y provisto por el escritorio. Se usa stdin y la colección persistente predeterminada de Secret Service. El registro local sólo contiene el proveedor. Ausencia, bloqueo, error o timeout fallan sin alternativa en claro, contraseña propia o colección de sesión. El usuario necesita un keyring persistente seguro: su política de cifrado y desbloqueo pertenece al escritorio; no se certifican todos los escritorios ni entornos headless. [Implementación oficial GNOME](https://github.com/GNOME/libsecret/blob/main/tool/secret-tool.c).

API `NativeSecretStore`: directorio absoluto dedicado cuyo padre existe; `put`, `get`, `remove` por UUID. Valores UTF-8 acotados, sin NUL. No enlaces en la cadena de directorios; permisos privados verificados antes de usar. Cada UUID se reserva exclusivamente: nunca se sobrescribe ni repara automáticamente. Escrituras fallidas pueden dejar reserva parcial; ésta se conserva y bloquea reutilización. La eliminación explícita es recuperación local, no revocación del Hub.

Namespace derivado de ruta canónica y UUID; Linux sólo consulta/elimina entradas con reserva local propia, sin enumerar keyring. Error del proveedor conserva el registro. Auxiliares sin shell, ventana oculta, timeout y salida acotada; ningún secreto en argumentos, entorno, temporales ni errores devueltos. DPAPI también usa stdin.

No protege frente a procesos del mismo usuario, administrador/root, memoria, swap o volcados. JavaScript no garantiza borrar strings. No promete resistencia a cambios concurrentes maliciosos de ancestros o archivos remotos. Ante pérdida del perfil/keyring: revocar dispositivo en portal y emparejar de nuevo. Eliminar localmente no revoca el bearer remoto. El futuro asistente debe comprobar disponibilidad antes de canje y explicar revocación si guardar falla después: Hub y escritorio no comparten transacción.

Pruebas con TEMP y valores sintéticos; DPAPI real en Windows. Linux necesita prueba nativa aislada con bus/keyring propios y contraseña no vacía: mocks no son evidencia nativa. Utilidades Linux de CI serían sólo del runner, nunca instalación automática en el escritorio. Integración MCP, pantalla y adaptadores pendientes.
