# Distribución del compañero: requisitos y evidencia inicial

Parte pendiente del incremento3 autorizado. Este documento prepara distribución, no declara un instalador implementado. Reentrada por cuenta con contraseña aceptada en ADR-025; su entrega se verifica antes de este incremento. No se añade dependencia ni framework desktop.

## Estado observado en el repositorio

- `pnpm companion` inicia `apps/hub-server/dist/companion.js`; requiere runtime, instalación del monorepo y compilación previos.
- El launcher deriva root por posición de su módulo y exige `apps/web/dist/index.html`. Ese layout debe conservarse o sustituirse explícitamente, no adivinar rutas al empaquetar.
- Hub/MCP importan paquetes privados `workspace:*`. Copiar sólo los archivos dist no produce una distribución autocontenida: faltan sus dependencias de ejecución y resolución de paquetes.
- Antes del corte de rutas, la DB predeterminada `./data/agents-hub.sqlite` dependía del cwd. El contrato al final de este documento corrige esa ambigüedad para el compañero; no cambia el launcher Hub/CLI histórico ni migra datos.
- `scripts/mcp-config.mjs` deriva root y usa `process.execPath` más ruta absoluta al adaptador. Emite placeholder, no credencial real. El futuro asistente debe conservar exportación MCP genérica y separar credencial de configuración visible.
- El panel mantiene bootstrap de un uso y sesión en memoria. El canal privado descrito al final permite renovar la entrada por segundo lanzamiento sin reiniciar el Hub; v2 recupera tras crash bajo el contrato de mutex, pero no equivale al instalador final.
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

El primer corte de empaquetado se fija abajo. Almacén de credenciales e instalador nativo siguen sin decidir; no reemplazar los cinco incrementos por un launcher de desarrollo.

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

IPC autentica solicitudes mediante HMAC/nonce y cifra la respuesta con AES-GCM; un servidor impostor no obtiene la entrada aunque intercepte/retransmita una solicitud. Mensajes/tiempo/conexiones acotados; navegador/HTTP no tiene acceso a la clave ni al IPC. Nueva entrada invalida sólo la anterior sin canjear, no la cookie vigente; canje conserva la política de sesión local única. Cierre limpio retira sólo el registro propio. La recuperación automática siguiente no usa PID ni ausencia de respuesta como prueba de abandono.

Aceptar reapertura tras logout/entrada vencida con Hub aún activo, dos lanzamientos concurrentes sin doble DB, secretos fuera de diagnósticos, rechazo de identidad distinta/credencial IPC inválida/permisos inseguros/puerto ajeno y limpieza propia. Sin dependencia nueva, instalador final ni almacén de credenciales MCP.

Referencias de mecanismos del sistema: [Node IPC](https://nodejs.org/download/release/latest-v24.x/docs/api/net.html#ipc-support), [FileSystemAccessRule](https://learn.microsoft.com/en-us/dotnet/api/system.security.accesscontrol.filesystemaccessrule). Windows usa DirectoryInfo/FileInfo y ACL de .NET desde PowerShell5.1, sin depender de cargar el módulo Set-Acl. Son primitivas, no una certificación de seguridad del producto.

## Recuperación tras cierre abrupto: contrato v2

Se reutiliza `node:sqlite`, ya requerido por el Hub, para un mutex entre procesos en el archivo privado persistente `.companion-control/ownership.sqlite`. Una conexión dedicada mantiene `BEGIN EXCLUSIVE` sin escribir tablas ni datos, desde antes de publicar el registro hasta después de cerrar la DB operativa y retirar el registro propio. El sistema libera sus locks al morir el proceso. Este archivo no es la DB del usuario y nunca se borra/reemplaza para recuperar una instancia. No se añade dependencia, servicio ni migración.

Sólo quien adquiere ese mutex puede publicar/reemplazar un registro v2 de identidad coincidente. Publicación mediante archivo temporal privado y rename; clave y dirección IPC nuevas en cada adquisición. Si el mutex está ocupado, únicamente intentar reentrada autenticada, esperar acotadamente o rechazar: nunca takeover por timeout. Un registro incompatible, corrupto, con permisos inseguros o identidad distinta se rechaza sin sobrescribirlo. Registros v1 no acreditan participación en el mutex: permiten reentrada autenticada si siguen activos, pero no recuperación automática si no responden.

Unix usa una dirección nueva por instancia; no borrar sockets antiguos para recuperar. Tras crash pueden quedar sockets o temporales privados, sin credencial reutilizable en la instancia nueva; su limpieza no forma parte de este corte. Carpeta de datos local y confiable, no filesystem de red con semántica de locks desconocida. No protege frente al mismo usuario/root ni recupera automáticamente túneles/procesos huérfanos, ni reinicia el Hub compartido: la instancia nueva conserva los datos y comienza con Hub detenido.

Aceptación: muerte forzada de un proceso de prueba propio y recuperación real, dos procesos concurrentes con un solo propietario, rotación del registro, persistencia de datos, rechazo de propietario vivo no disponible/identidad distinta/v1 abandonado/permisos inseguros. Referencias: [transacciones SQLite](https://www.sqlite.org/lang_transaction.html), [locks del pager](https://www.sqlite.org/lockingv3.html), [SQLite nativo de Node](https://nodejs.org/download/release/latest-v24.x/docs/api/sqlite.html). Prueba preliminar Windows entre procesos: `BEGIN EXCLUSIVE` bloquea al segundo con SQLITE_BUSY (5); tras cerrar la conexión, adquisición nueva correcta. Gate local de este corte: check184/27, build y18E2E PASS; incluye muerte forzada del companion completo con persistencia y pruebas multiproceso de recuperación concurrente/crash antes de servir IPC. CI Windows/Ubuntu del cambio aún pendiente al registrar el gate, sin certificación de artefacto instalado ni fallo eléctrico.

## Primer artefacto autocontenido (preview privado)

Corte de cierre gráfico: el panel ya ofrece `Cerrar Agents-Hub` con confirmación privada (ver LOCAL_CONTROL); cierra sólo sus servicios/DB/mutex. No se oculta todavía la consola ni se entrega instalador/acceso integrado. La aceptación comprueba salida real y reentrada con datos conservados, incluyendo pestaña reutilizada;202 sólo acredita solicitud aceptada.

Formato inicial: carpeta portable por plataforma, Windows x64/Linux x64 glibc, construida en el mismo sistema de destino. No Electron/Tauri, dependencia npm ni servicio nuevo. El productor necesita el entorno de desarrollo; quien ejecuta la carpeta no necesita Git/Node/pnpm ni compilar. Instalador nativo, accesos directos integrados, firma y publicación de binarios quedan para el siguiente corte; no declarar instalación guiada final ni doble clic Linux universal.

`pnpm package:companion --output <carpeta-absoluta-nueva>` exige build previo, pnpm12.10.1 del productor y destino nuevo; nunca sobrescribe ni limpia destinos del usuario. Usa `pnpm deploy --prod --node-linker=hoisted --ignore-scripts --frozen-lockfile` para Hub/MCP aislados, preservando versiones del lockfile, y copia sólo dist/manifest/dependencias y web compilada. El artefacto no contiene checkout, pruebas del proyecto, pnpm, configuración personal ni DB; paquetes de terceros conservan sus archivos publicados. Se rechazan symlinks y módulos nativos de dependencias en este corte. Licencias/avisos distribuidos con las dependencias se conservan; inventario por nombre/versión/licencia declarada y hashes de todos los archivos, no certificación legal exhaustiva.

Runtime fijo Node24.21.0, observado en fuente oficial al implementar (no `latest` flotante durante builds): ZIP Windows/tar.gz Linux oficiales, SHA-256 fijado en código contra [SHASUMS oficial v24.21.0](https://nodejs.org/download/release/v24.21.0/SHASUMS256.txt), binario y LICENSE completo conservados. TLS/checksum, sin prometer verificación GPG ni firma del producto. [pnpm deploy](https://pnpm.io/cli/deploy) documenta el paquete portable con dependencias workspace; la inspección propia debe comprobar que el grafo resultante no referencia el checkout.

Launcher de paquete determina recursos por su ubicación y datos por usuario: LOCALAPPDATA/Agents-Hub en Windows; XDG_DATA_HOME/agents-hub o ~/.local/share/agents-hub en Linux. Override absoluto AGENTS_HUB_DATA_DIR sigue disponible para pruebas/uso avanzado; no migrar DB histórica automáticamente. Inicio Windows por Abrir Agents-Hub.cmd, Linux por abrir-agents-hub.sh según escritorio/permisos; consola sigue siendo el control de cierre con Ctrl+C, no background invisible sin salida. Datos fuera de la carpeta versionada; reinstalar/mover recursos no sustituye DB. El asistente MCP/almacén de credenciales todavía no está implementado.

No se encontró LICENSE del proyecto: no elegir una licencia por el usuario ni subir/publicar binarios todavía. Este corte produce preview privado local/CI, sin release público. Aceptación: ejecutar con runtime empaquetado desde copia TEMP con espacios/cwd ajeno, sin resolución de dependencias hacia checkout, reapertura/crash y conservación de datos tras cambiar carpeta de recursos; comprobar MCP stdio con su runtime incluido y manifest/ausencia de secretos/datos. Fuera de alcance macOS/ARM/musl, firma/actualización automática/instalador del sistema, credenciales y listener.

Prueba del productor: `pnpm build`, luego `pnpm package:companion --output <ruta-absoluta-nueva>` y `AGENTS_HUB_PORTABLE_ARTIFACT=<esa-ruta> pnpm test:portable` (asignar env según shell). Sin esa variable las dos pruebas del artefacto se omiten explícitamente; CI construye la carpeta y la define antes del E2E completo, sin subir binarios. Pruebas dirigidas Windows PASS: inventario/hashes y Hub/MCP con runtime incluido desde copia ajena al checkout, NODE_PATH/NODE_OPTIONS vacíos, reentrada con Hub activo, crash propio, recursos reubicados y datos conservados. Son pruebas headless; falta arranque del launcher mediante doble clic real y actualización entre versiones, además de instalador/signing.
