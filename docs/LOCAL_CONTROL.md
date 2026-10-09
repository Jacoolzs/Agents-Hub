# Panel local del anfitrión

Primer incremento de la experiencia sencilla: administrar usuarios/accesos/proyectos y controlar Hub/túnel desde una interfaz web local reutilizada. El instalador sin requisitos de desarrollo, invitaciones con onboarding humano, emparejamiento MCP, listener y operación permanente siguen como incrementos del mismo objetivo.

## Uso de desarrollo

En `feat/easy-onboarding`, instalar dependencias y ejecutar `pnpm build`, después `pnpm companion` desde la raíz. Abre el navegador con entrada privada y mantiene el panel en 127.0.0.1:8791; el Hub permanece detenido hasta pulsar Iniciar o Compartir. Usa DATABASE_URL/PORT existentes y LOCAL_CONTROL_PORT opcional (distinto, 1024–65535). Compartir está disponible inicialmente en Windows x64; el Hub/panel local no requiere túnel. No ejecutar simultáneamente el launcher anterior sobre la misma DB. Ctrl+C cierra el compañero y sus procesos propios.

Después de cerrar sesión o vencer las ocho horas, detener y arrancar de nuevo el compañero para obtener bootstrap nuevo. La reapertura de una instancia existente sin terminal es trabajo pendiente del empaquetado; no se anuncia como resuelta.

## Frontera de autoridad (ADR-022)

El compañero tiene un listener separado ligado a 127.0.0.1. El túnel sólo apunta al puerto del Hub: ninguna ruta administrativa se registra en el Hub público. Owner de proyecto no equivale a administrador de instancia.

Un bootstrap aleatorio abre la interfaz por fragmento, se elimina del historial antes de llamar a la API y se canjea una sola vez dentro de cinco minutos por cookie HttpOnly, SameSite=Strict, path de API, duración ocho horas y sólo memoria de proceso. HTTP se permite exclusivamente en loopback; no trasladar esta cookie local a despliegue remoto. API verifica dirección remota loopback, Host exacto y Origin exacto en mutaciones; rechaza orígenes externos incluso en lecturas. Sesión expirada exige reabrir el compañero; logout invalida el acceso. No logs de cuerpos/cookies/secrets ni almacenamiento web de tokens. Sin CORS ni confianza en forwarded headers. Bootstrap no vuelve a estar válido tras logout.

Personas muestra usuarios y metadatos de accesos, nunca secretos guardados; emisión muestra el token una vez y permite descartar/copiar. Usuario existente es conflicto accionable. Crear usuario y acceso, emitir/revocar y auditoría comparten transacción. UUID/TTL/entradas/salidas validados. Revocación revalida sockets activos inmediatamente si el Hub está ejecutándose.

Hub y túnel tienen estado observado, operaciones serializadas y errores visibles. Detener/reiniciar conserva DB y panel. Sólo se controla el proceso propio, sin tomar un Hub existente ni matar procesos ajenos. Arranque sin compartir es local; compartir requiere acción explícita y transporte oficial/checksum existente, conexión registrada y health público confirmado sin credenciales ni redirects. Propagación DNS puede retrasar la confirmación hasta 90 segundos; fallo restaura el estado anterior del Hub y cierra el túnel propio. Cierre del compañero detiene hijos y cierra DB. Instalación y permanencia se completan en incrementos posteriores.

## Diseño

### Preparación inicial guiada

Con la misma autoridad local privada, `POST /local-api/workspaces` recibe `{name, person}` (persona nueva con username o selección explícita de user_id existente). Reserva una identidad sin emitir acceso MCP, crea proyecto/owner, evento y auditoría en una transacción. Un nombre ocupado se rechaza sin reutilizar identidad; no hay registro público, contraseña, owner global ni arranque/túnel implícito. La salida sólo contiene metadata de usuario/proyecto. Se reutilizan puertos administrativos, ProjectService, SQLite y eventos; servicio de composición necesario para conservar atomicidad sin SQL nuevo en rutas/UI, sin dependencia externa/migración.

Cuando no hay proyectos, el panel prioriza Tu nombre + Nombre del primer proyecto, o selección explícita de persona existente. Tras crear, pasa a Proyectos e invitaciones y enfoca Iniciar Hub para iniciar/compartir e invitar. El flujo anterior permanece para compatibilidad; no es el recorrido inicial recomendado. Preparación no conecta la IA ni crea contraseña. Aceptación: preparación desde cero en un formulario, cero tokens/MCP, nuevo/existente/nombre ocupado, rollback sin entidad/evento/auditoría parcial, frontera local y E2E teclado/móvil; no cierra distribución instalable ni elección de reentrada. En fallo de red, Actualizar estado antes de repetir: no se promete reintento idempotente de creación de proyectos.

UI_DESIGN vigente: navy #14263d, canvas #f4f6fa, superficie #ffffff, tinta #172a41, secundario #52657b, acción #2555db; Bahnschrift/Segoe UI locales. Estado y acción de arranque arriba; Personas y Proyectos en secciones con listas/formularios cortos. Detalles técnicos y TTL avanzados desplegables. Sin métricas ficticias, navegación con foco y errores/credenciales explícitos; responsive y reduced motion.

## Aceptación

- Crear/listar personas, emitir/listar/revocar accesos y crear proyecto/invitación sin CLI de administración ni UUID manual.
- Start/stop/restart del Hub propio, errores de puerto ocupado, compartir y parar túnel sin detener panel o tocar otros procesos.
- Regresiones: autoridad ausente en Hub público; rechazo Host/Origin/cookie/bootstrap inválidos/vencidos/reusados; rollback con auditoría fallida; revocación; lifecycle y DB conservada.
- UI real en navegador con teclado, 375px y desktop, secretos fuera de URL/storage/diagnósticos; no atribuir tests anteriores al código nuevo.
- Gates: pnpm check, pnpm build, pnpm test:e2e, git diff --check; pruebas sólo con datos efímeros.
