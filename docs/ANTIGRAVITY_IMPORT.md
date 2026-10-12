# Importación guiada Antigravity CLI — ADR-033

Primer adaptador: perfil global documentado `~/.gemini/config/mcp_config.json`,
Antigravity CLI **1.3.3**, Windows/Linux. Se consulta exclusivamente `agy --version`
con ejecución sin shell, timeout y salida acotada. Versiones diferentes/desconocidas
usan exportación genérica; no actualizar/instalar cliente ni ejecutar turnos.
Fuente primaria: [configuración MCP oficial](https://www.antigravity.google/docs/mcp/).
La forma del archivo está documentada; el piloto del host y su listener siguen separados.

Flujo: conexión ya guardada → revisar destino/versión y número de entradas → cerrar
Antigravity → confirmar registro. La revisión no escribe y devuelve sólo metadata;
su UUID de uso único/TTL120s liga la conexión/configuración y snapshot interno.
Confirmación revalida versión, referencia/vault y snapshot. No usar `mcp add` porque
puede reemplazar una entrada existente. No leer perfiles reales durante desarrollo:
home/version inyectados exclusivamente en fixtures TEMP, no overrides de entorno.

`agents-hub` nuevo contiene runtime/script absolutos y referencia privada/nombre del
agente, nunca bearer. Se conservan semánticamente todas las demás entradas y campos
del JSON. Misma entrada exacta es idempotente; entrada diferente con ese nombre rechaza.
JSON duplicado/malformado/no objeto, enlaces, archivo hardlinkeado, permisos no privados,
archivo >256KiB y cambios desde preview rechazan sin reparar ni mostrar contenido.
No cambiar permisos de archivos/directorios existentes: sólo objetos nuevos privados.

Escritor bajo exclusión/ownership del compañero y serialización con runtime/cierre.
En el directorio destino crea operación UUID privada y replacement completo exclusivo.
Si había archivo, lo mueve a `original.json` de esa operación en el mismo volumen;
verifica snapshot después de moverlo. Publica replacement por hardlink exclusivo,
nunca reemplaza un destino que apareció entretanto. Retira sólo su staging publicado.
Ante fallo restaura el original por link exclusivamente si el destino sigue ausente;
si otro destino existe lo conserva junto a la copia y exige revisión humana.
Marca registered.json sólo al finalizar y comprueba operaciones anteriores antes de
revisar/importar: un original desplazado sin marca nunca se trata como perfil nuevo.
Revalida TTL después de las esperas y antes de mover/publicar. Hasta 100 operaciones
conservadas, sin limpieza automática ni reparación tras crash. Una interrupción puede dejar destino
ausente/partial/staging: revisar la operación y original, nunca volver a canjear tokens.

La copia original puede contener secretos de otros MCP: permanece privada en disco,
nunca devuelve contenido/logs, no se sube ni descarga al navegador. Registro ≠ conexión
activa: recargar/reabrir cliente, aprobar permisos y probar MCP por separado. No activar
IA/reiniciar procesos/ACK/locks automáticamente. No transacción distribuida con el
cliente, garantía ante corte eléctrico ni protección contra escritor malicioso del
mismo usuario/root; cerrar el cliente es requisito, no un lock sobre programas externos.

Aceptación: pruebas TEMP en ambos SO de creación/merge/preservación/idempotencia,
conflicto/preview obsoleto/JSON/permisos/link/versión/crash-publicación/recuperación sin
overwrite, frontera privada y flujo gráfico con cancelación y nuevo preview.
