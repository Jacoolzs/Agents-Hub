# Distribución del compañero: requisitos y evidencia inicial

Parte pendiente del incremento3 autorizado. Este documento prepara trabajo común; no elige reentrada por contraseña/enlace, no cambia el orden de entrega y no declara un instalador implementado. No se añade dependencia ni framework desktop.

## Estado observado en el repositorio

- `pnpm companion` inicia `apps/hub-server/dist/companion.js`; requiere runtime, instalación del monorepo y compilación previos.
- El launcher deriva root por posición de su módulo y exige `apps/web/dist/index.html`. Ese layout debe conservarse o sustituirse explícitamente, no adivinar rutas al empaquetar.
- Hub/MCP importan paquetes privados `workspace:*`. Copiar sólo los archivos dist no produce una distribución autocontenida: faltan sus dependencias de ejecución y resolución de paquetes.
- La DB predeterminada es `./data/agents-hub.sqlite`, relativa al directorio de trabajo. Un acceso directo con otro directorio puede abrir otra DB; una actualización de la carpeta instalada no debe perder datos.
- `scripts/mcp-config.mjs` deriva root y usa `process.execPath` más ruta absoluta al adaptador. Emite placeholder, no credencial real. El futuro asistente debe conservar exportación MCP genérica y separar credencial de configuración visible.
- El panel tiene bootstrap de un uso y sesión en memoria. Reabrir después de logout/vencimiento actualmente requiere reiniciar el compañero; no hay reapertura de instancia propia por segundo lanzamiento.
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
