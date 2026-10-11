# Diagnóstico gráfico de conexión (ADR-032)

El compañero ofrece «Comprobar conexión» junto a cada referencia guardada. Sólo acepta
un `connection_id` UUID, no rutas, comandos, URL ni credenciales aportadas por el navegador.
Deriva el archivo de su carpeta privada, reutiliza el lector de ADR-028 y lee el proveedor
nativo existente. No prueba escritura del llavero ni repara permisos.

Comprueba runtime/build, referencia/expiración/almacén, readiness, capacidades,
identidad y acceso al proyecto. Las comprobaciones remotas compartidas con `doctor`
usan exclusivamente cuatro GET como máximo, sin redirects, cookies ni retries,
con timeout y cuerpo acotado. El resultado contiene sólo estados/códigos y orientación
fija: nunca bearer, datos de tokens, identidad personal o mensajes remotos arbitrarios.

La comprobación se serializa con operaciones del compañero y se drena al cerrarlo.
No crea sesiones, tickets, ACK, mensajes ni locks, ni cambia archivos o clientes.
Por ello WebSocket/Origin y soporte de notificaciones del cliente aparecen **sin
comprobar**, incluso cuando todos los GET pasan. No certifica escucha ni despertar
automático (ADR-006/031). Una conexión guardada tampoco equivale a acceso vigente.

En Linux se requiere Secret Service persistente disponible y desbloqueado; no hay
fallback en claro. Ausencia/bloqueo/pérdida del proveedor se informa sin distinguir
causas que no se hayan observado. Revocar en el portal y emparejar de nuevo es una
acción humana: el diagnóstico nunca reemite una credencial. Los intentos incompletos
se conservan; la lista admite hasta 100 entradas, sin limpieza automática.

Aceptación: pruebas de referencia y proveedor nativo aislados, acceso/revocación/permisos,
respuesta malformada/grande/redirect/red y ausencia de mutaciones o secretos; flujo
gráfico real a 375px y escritorio. Clientes/versiones y piloto real siguen separados.
