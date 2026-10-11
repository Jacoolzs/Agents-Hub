# Distribución del compañero: requisitos y evidencia inicial

Parte pendiente del incremento3 autorizado. Este documento prepara distribución, no declara un instalador implementado. Reentrada por cuenta con contraseña aceptada en ADR-025; su entrega se verifica antes de este incremento. No se añade dependencia ni framework desktop.

## Estado observado en el repositorio

- `pnpm companion` inicia `apps/hub-server/dist/companion.js`; requiere runtime, instalación del monorepo y compilación previos.
- El launcher deriva root por posición de su módulo y exige `apps/web/dist/index.html`. Ese layout debe conservarse o sustituirse explícitamente, no adivinar rutas al empaquetar.
- Hub/MCP importan paquetes privados `workspace:*`. Copiar sólo los archivos dist no produce una distribución autocontenida: faltan sus dependencias de ejecución y resolución de paquetes.
- Antes del corte de rutas, la DB predeterminada `./data/agents-hub.sqlite` dependía del cwd. El contrato al final de este documento corrige esa ambigüedad para el compañero; no cambia el launcher Hub/CLI histórico ni migra datos.
- `scripts/mcp-config.mjs` deriva root y usa `process.execPath` más ruta absoluta al adaptador. Emite placeholder, no credencial real. El futuro asistente debe conservar exportación MCP genérica y separar credencial de configuración visible.
- El panel mantiene bootstrap de un uso y sesión en memoria. El canal privado descrito al final permite renovar la entrada por segundo lanzamiento sin reiniciar el Hub; no equivale al instalador final ni recuperación automática tras crash.
- Publicar por Internet actualmente depende del transporte Windows x64 y URL temporal. No certifica launcher limpio Linux ni operación permanente.

## Requisitos de la entrega instalable

1. Inicio gráfico sin Git, pnpm, compilación, edición de JSON ni rutas manuales para la persona que instala. Resolver runtime y dependencias en el artefacto; no basta un wrapper que requiera el checkout.
2. Separar código/recursos instalados de datos de usuario (DB, configuración y credenciales); rutas absolutas y deterministas, independientes del cwd. Actualizar no borra ni reemplaza datos.
3. Reabrir el panel de la instancia propia sin tomar un Hub ajeno ni matar procesos de otros usuarios. Bootstrap sigue privado, efímero, sin logs/argumentos inseguros ni archivos legibles públicamente.
4. Emparejamiento guiado desde identidad/proyecto ya autorizados; credencial por dispositivo revocable, nunca copiar cookie del navegador como token MCP. Almacenamiento/recuperación aún deben fijarse antes de código.
5. Exportar MCP genérico stdio y ofrecer adaptadores opcionales para clientes probados. Detectar incompatibilidad y preservar configuraciones existentes; no certificar cualquier versión ni escribir por defecto en clientes desconocidos.
6. Windows y Linux con prueba de instalación limpia, rutas con espacios y lanzamiento desde otro cwd, permisos de datos, stop/reopen, actualización/backup y rechazo de puerto ocupado. No confundir CI de fuente con instalación del artefacto.
7. Inventario/versiones/licencias/checksums de runtime/dependencias y transporte. Decidir formatos/plataformas y firma/distribución antes de publicar artefactos; ningún servicio o dependencia nueva queda aceptado por esta inspección.

## Por dónde implementar tras cerrar el acceso humano

Primero fijar contrato de rutas instaladas/datos y lifecycle de reapertura, manteniendo autoridad ADR-022. Probar en carpeta efímera sin tocar DB del piloto. Después resolver artefacto autocontenido y prueba de ejecución fuera del checkout; finalmente conexión MCP guiada y adaptadores. Reutilizar companion/runtime/control-app, doctor, validación de URL y exportación existente. El listener común queda después y mantiene ADR-006: recibir no garantiza activar un LLM inactivo.

Estrategia de empaquetado y almacén de credenciales siguen sin decidir. Esta inspección no permite afirmar distribución lista ni reemplazar los cinco incrementos por un launcher de desarrollo.

## Contrato de rutas del compañero (primer corte de implementación)

- `AGENTS_HUB_RESOURCE_DIR`, si existe, es un directorio absoluto con el layout actual de recursos (`apps/web/dist`). No se cambia todavía el formato del artefacto.
- `AGENTS_HUB_DATA_DIR`, si existe, es absoluto y aloja `agents-hub.sqlite` y `.tools`. Un lanzamiento con recursos explícitos exige también datos explícitos: nunca escribir por defecto en una instalación.
- En desarrollo sin esas opciones, se conserva la DB histórica `<checkout>/data/agents-hub.sqlite`, pero deja de depender del cwd. No migrar/copiar datos automáticamente ni elegir una carpeta de usuario todavía.
- `DATABASE_URL` absoluto o `:memory:` conserva su semántica. Si es relativo, en desarrollo se resuelve contra el checkout (compatibilidad con `./data/...`); con datos explícitos se resuelve dentro de esa carpeta y se rechaza traversal que salga de ella.
- Validar opciones antes de crear DB/procesos. El transporte descargable usa la carpeta de datos, no recursos instalados. Este corte no concede permisos privados a un almacén de credenciales, no implementa reapertura ni distribuye un runtime.
- Aceptación: resolución independiente del cwd, espacios, rechazo de rutas ambiguas/traversal y recursos explícitos sin datos; lanzamiento compilado desde carpeta efímera, persistencia al reiniciar y recursos sin escrituras. Próximo corte: reapertura segura y artefacto autocontenido.

## Reapertura privada de la instancia propia

Se añade un canal IPC nativo (named pipe Windows/socket Unix), no una ruta HTTP de recuperación. Un segundo lanzamiento con la misma carpeta de datos/DB/puertos solicita una entrada nueva al proceso propio y termina; no abre SQLite ni detiene/reinicia el Hub. Configuración diferente o puerto ocupado se rechaza, sin takeover.

El registro efímero vive en `<datos>/.companion-control/instance.json`, creado exclusivamente antes de abrir DB. Contiene clave aleatoria de proceso y dirección IPC; nunca se publica, imprime ni pasa como argumento. Directorio nuevo privado 0700 y archivo0600 en Unix; propietario y ACL exclusiva del SID actual inicializados en directorio y archivo exclusivamente nuevos en Windows mediante PowerShell nativo, antes de escribir la clave. No se confía en el propietario predeterminado de archivos creados con elevación. Verificar propietario/permisos y rechazar enlaces o permisos inseguros existentes, sin corregir carpetas/archivos ajenos. Lanzamientos concurrentes esperan la inicialización dentro del plazo existente y nunca leen la clave antes de verificar permisos. Requiere carpeta de datos confiable/no compartida con escritores adversarios. No protege frente a procesos del mismo usuario ni administrador/root.

IPC autentica solicitudes mediante HMAC/nonce y cifra la respuesta con AES-GCM; un servidor impostor no obtiene la entrada aunque intercepte/retransmita una solicitud. Mensajes/tiempo/conexiones acotados; navegador/HTTP no tiene acceso a la clave ni al IPC. Nueva entrada invalida sólo la anterior sin canjear, no la cookie vigente; canje conserva la política de sesión local única. Cierre limpio retira sólo el registro propio. Tras cierre abrupto, registro abandonado causa rechazo seguro: recuperación automática queda pendiente, nunca matar PID o borrar estado ajeno por una suposición.

Aceptar reapertura tras logout/entrada vencida con Hub aún activo, dos lanzamientos concurrentes sin doble DB, secretos fuera de diagnósticos, rechazo de identidad distinta/credencial IPC inválida/permisos inseguros/puerto ajeno y limpieza propia. Sin dependencia nueva, instalador final ni almacén de credenciales MCP.

Referencias de mecanismos del sistema: [Node IPC](https://nodejs.org/download/release/latest-v24.x/docs/api/net.html#ipc-support), [FileSystemAccessRule](https://learn.microsoft.com/en-us/dotnet/api/system.security.accesscontrol.filesystemaccessrule). Windows usa DirectoryInfo/FileInfo y ACL de .NET desde PowerShell5.1, sin depender de cargar el módulo Set-Acl. Son primitivas, no una certificación de seguridad del producto.
