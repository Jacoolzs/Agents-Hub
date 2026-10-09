# Panel local del anfitrión

Primer incremento de la experiencia sencilla: administrar usuarios/accesos/proyectos y controlar Hub/túnel desde una interfaz web local reutilizada. El instalador sin requisitos de desarrollo, invitaciones con onboarding humano, emparejamiento MCP, listener y operación permanente siguen como incrementos del mismo objetivo.

## Uso de desarrollo

En `feat/easy-onboarding`, instalar dependencias y ejecutar `pnpm build`, después `pnpm companion` desde la raíz. Abre el navegador con entrada privada y mantiene el panel en 127.0.0.1:8791; el Hub permanece detenido hasta pulsar Iniciar o Compartir. Usa DATABASE_URL/PORT existentes y LOCAL_CONTROL_PORT opcional (distinto, 1024–65535). Compartir está disponible inicialmente en Windows x64; el Hub/panel local no requiere túnel. No ejecutar simultáneamente el launcher anterior sobre la misma DB. Ctrl+C cierra el compañero y sus procesos propios.

Después de cerrar sesión o vencer las ocho horas, detener y arrancar de nuevo el compañero para obtener bootstrap nuevo. La reapertura de una instancia existente sin terminal es trabajo pendiente del empaquetado; no se anuncia como resuelta.

## Frontera de autoridad (ADR-022)

El compañero tiene un listener separado ligado a 127.0.0.1. El túnel sólo apunta al puerto del Hub: ninguna ruta administrativa se registra en el Hub público. Owner de proyecto no equivale a administrador de instancia.

Un bootstrap aleatorio abre la interfaz por fragmento, se elimina del historial antes de llamar a la API y se canjea una sola vez dentro de cinco minutos por cookie HttpOnly, SameSite=Strict, path de API, duración ocho horas y sólo memoria de proceso. HTTP se permite exclusivamente en loopback; no trasladar esta cookie local a despliegue remoto. API verifica dirección remota loopback, Host exacto y Origin exacto en mutaciones; rechaza orígenes externos incluso en lecturas. Sesión expirada exige reabrir el compañero; logout invalida el acceso. No logs de cuerpos/cookies/secrets ni almacenamiento web de tokens. Sin CORS ni confianza en forwarded headers. Bootstrap no vuelve a estar válido tras logout.

Personas muestra usuarios y metadatos de accesos, nunca secretos guardados; emisión muestra el token una vez y permite descartar/copiar. Usuario existente es conflicto accionable. Crear usuario y acceso, emitir/revocar y auditoría comparten transacción. UUID/TTL/entradas/salidas validados. Revocación revalida sockets activos inmediatamente si el Hub está ejecutándose.

Hub y túnel tienen estado observado, operaciones serializadas y errores visibles. Detener/reiniciar conserva DB y panel. Sólo se controla el proceso propio, sin tomar un Hub existente ni matar procesos ajenos. Arranque sin compartir es local; compartir requiere acción explícita y transporte oficial/checksum existente. Cierre del compañero detiene hijos y cierra DB. Instalación y permanencia se completan en incrementos posteriores.

## Diseño

UI_DESIGN vigente: navy #14263d, canvas #f4f6fa, superficie #ffffff, tinta #172a41, secundario #52657b, acción #2555db; Bahnschrift/Segoe UI locales. Estado y acción de arranque arriba; Personas y Proyectos en secciones con listas/formularios cortos. Detalles técnicos y TTL avanzados desplegables. Sin métricas ficticias, navegación con foco y errores/credenciales explícitos; responsive y reduced motion.

## Aceptación

- Crear/listar personas, emitir/listar/revocar accesos y crear proyecto/invitación sin CLI de administración ni UUID manual.
- Start/stop/restart del Hub propio, errores de puerto ocupado, compartir y parar túnel sin detener panel o tocar otros procesos.
- Regresiones: autoridad ausente en Hub público; rechazo Host/Origin/cookie/bootstrap inválidos/vencidos/reusados; rollback con auditoría fallida; revocación; lifecycle y DB conservada.
- UI real en navegador con teclado, 375px y desktop, secretos fuera de URL/storage/diagnósticos; no atribuir tests anteriores al código nuevo.
- Gates: pnpm check, pnpm build, pnpm test:e2e, git diff --check; pruebas sólo con datos efímeros.
