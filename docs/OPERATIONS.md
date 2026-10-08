# Operación del MVP desde el PC

Requiere Windows x64, Node 24 y pnpm. El servidor no carga `.env` automáticamente: establecer variables en PowerShell o arrancar Node con `--env-file`. El directorio de arranque debe ser la raíz del repositorio.

## Instalar y comprobar

```powershell
pnpm install --frozen-lockfile
pnpm check
pnpm build
pnpm test:e2e
pnpm audit --prod
```

E2E utiliza el bundle estático de Vite; en una máquina nueva instalar antes Chromium con `pnpm exec playwright install chromium`. CI pasó en Linux y Windows para `8870c28`: [ejecución verificada](https://github.com/Jacoolzs/Agents-Hub/actions/runs/37722402150). El código está publicado en `main`.

## Compartir por Internet

En la primera terminal, crear tu identidad (una sola vez) y arrancar:

```powershell
$env:AUTH_TOKEN_TTL_SECONDS = "28800"
pnpm admin create-user orlando
pnpm share
```

La variable del ejemplo emite tokens de ocho horas y usa sintaxis de PowerShell. Si ya existe el usuario, emitir otro token con `issue-token` en lugar de repetir `create-user`.

`create-user` imprime `user_id` y un token personal sólo en esa salida. Conservarlo por privado; el Hub guarda su hash. El token vence en una hora por defecto. Para otra duración, establecer `AUTH_TOKEN_TTL_SECONDS` antes de emitirlo. `pnpm admin list-users` permite recuperar IDs y `pnpm admin issue-token <user-id>` emite otro token.

`pnpm share` descarga cloudflared portable oficial 2026.10.0 a `.tools/`, verifica SHA-256, crea un túnel HTTPS/WSS, obtiene su URL y arranca el Hub en loopback. Sirve el dashboard compilado en el mismo origen y configura CORS exclusivamente para esa URL. Guarda logs redactados en `logs/`. No abre puertos del router ni instala un servicio global. La URL cambia en cada arranque; mantener el PC y la terminal encendidos. Ctrl+C cierra Hub, SQLite y túnel; si un hijo termina, el supervisor detiene el otro. Ante cierre atascado, aplica parada forzosa tras 5 segundos.

Abrir la URL impresa, pegar tu token y pulsar **Crear Proyecto**. El dashboard muestra el ID del proyecto. Para cada amigo, en otra terminal:

```powershell
pnpm admin create-user amigo1
```

Compartir por privado su token personal. En tu dashboard abrir **Miembros → Crear invitación** y compartir la invitación de un solo uso, la URL y el ID del proyecto. El amigo pega su propio token, ID e invitación en **Conectar Proyecto**. En posteriores conexiones sólo requiere su token y el ID. No compartir tu token con el equipo.

Cloudflare Quick Tunnels es temporal, no requiere cuenta/dominio y no garantiza disponibilidad; limita a 200 peticiones simultáneas. Para una URL estable y servicio continuo, configurar un túnel con dominio y supervisor persistente. Fuente: [documentación oficial](https://developers.cloudflare.com/tunnel/get-started/quick-tunnels/). La prueba pública automatizada usa datos efímeros y cierra el túnel al finalizar:

```powershell
pnpm test:share
```

El script usa el puerto 8790. No ejecutar sobre otro servicio que ya ocupe ese puerto.

## MCP local de cada persona

Cada participante que conecte un agente debe clonar o actualizar `main`, ejecutar `pnpm install --frozen-lockfile` y `pnpm build` en su propia máquina con Node 24. Sólo el anfitrión ejecuta `pnpm share`; para usar únicamente el dashboard basta el navegador. Hay un ejemplo de configuración JSON en el [README](../README.md#4-conectar-los-agentes-por-mcp).

Configurar el cliente MCP con `command: node`, `args: [ruta-absoluta/packages/mcp-server/dist/main.js]` y variables `AGENTS_HUB_URL` (URL HTTPS compartida), `AGENTS_HUB_TOKEN` (token personal), `AGENTS_HUB_PROJECT_ID` y `AGENTS_HUB_AGENT_NAME` (nombre propio, distinto por proceso). Ejecutar `join_project` antes de trabajar.

`check_inbox` lee desde el checkpoint confirmado. Después de consumir una página, confirmar su `next_cursor` con `ack_inbox` o con el próximo `check_inbox({cursor})`. Nunca confirmar antes de consumir. El nuevo proceso obtiene el checkpoint en `join_project`; la entrega puede repetirse hasta confirmación, por diseño. `wait_for_messages` se cancela con el cliente MCP y tiene máximo 60 segundos. Heartbeat cada 30 segundos; EOF/SIGINT/SIGTERM desconecta. Si se mata forzosamente el proceso, la presencia vence en el Hub.

Un nombre admite una sola instancia vigente. MCP usa un `instance_id` interno para repetir join tras respuesta perdida; otro proceso recibe 409 y debe usar un nombre distinto o esperar desconexión/vencimiento (180 s por defecto). Reanudar conserva checkpoint y locks según TTL, pero cambia `session_id`; llamadas y tickets antiguos se invalidan. Dashboard envía disconnect keepalive al recargar. Consulta [sesiones](SESSIONS.md) y [recuperación tras retención](RECOVERY.md).

Mensajes/estado/claim aceptan `idempotency_key`; reutilizarla únicamente con la misma petición. MCP genera una por llamada cuando se omite y la mantiene en los reintentos HTTP. Para reintentar otra llamada de herramienta, pasar la misma clave. Registros persistidos 24 horas, ligados a usuario/proyecto/operación y hash de payload. Payload diferente devuelve 409. Liberación por `lock_id` y legacy por `paths`.

## Acceso y revocación

| Rol | Acceso |
|---|---|
| reader | Lecturas y presencia propia |
| collaborator | Lo anterior, mensajes/estado y locks propios |
| maintainer | Lo anterior y administración de reader/collaborator |
| owner | Todos los roles, transferencia explícita de ownership y override de locks ajenos |

Scopes y roles se intersectan; token `*` no evita roles. Invitaciones guardan hash, vencen, se revocan y se consumen una vez. No existe registro público/OAuth. La CLI local es una herramienta administrativa de quien controla el PC.

Miembros se retiran/cambian en el dashboard o mediante `PATCH/DELETE /v1/projects/:projectId/members/:userId`. Ownership usa `POST /v1/projects/:projectId/ownership` con `{user_id}`; sólo owner y destinatario miembro. Conserva el creador histórico.

`GET /v1/tokens` lista IDs/metadatos propios y `DELETE /v1/tokens/:tokenId` revoca; la CLI `pnpm admin revoke-token <token-id>` también lo permite. Token ligado a proyecto no administra tokens generales; `issue-token <user-id> <project-id>` requiere membresía y emite un token limitado. El WebSocket verifica membresía, sesión y token al conectar, ante eventos y cada mantenimiento (15 segundos por defecto). Revocación HTTP cierra inmediatamente; revocación CLI se refleja como máximo en ese intervalo si no hay eventos.

## Persistencia, backup y restore

Base por defecto `./data/agents-hub.sqlite`, SQLite/WAL con migraciones versionadas. Evitar suspensión del PC durante sesiones compartidas. Antes de actualizar, crear backup:

```powershell
pnpm admin backup ./data/backup-2026-10-07.sqlite
```

`VACUUM INTO` crea snapshot consistente. La operación síncrona puede pausar el proceso que la ejecuta; para bases grandes usar ventana operativa. Destino debe ser nuevo y distinto de DB activa.

Detener el Hub antes de cambiar la base. Restore verifica integridad y sólo copia a una ruta nueva, sin sobrescribir base ni WAL/SHM existentes:

```powershell
pnpm admin restore ./data/backup-2026-10-07.sqlite ./data/restored.sqlite
$env:DATABASE_URL = './data/restored.sqlite'
pnpm share
```

Conservar el conjunto anterior para rollback y copias fuera del PC. No copiar sólo `.sqlite` mientras un Hub activo tiene WAL.

## Salud, límites y evidencia

`/health/live` comprueba el proceso; `/health/ready` consulta SQLite. En producción devuelve estado mínimo; los diagnósticos detallados se reservan al entorno local de desarrollo/pruebas. Logs JSON contienen request ID validado y actor/proyecto pseudonimizados, sin cuerpos, credenciales ni queries de tickets.

Configurar variables de `.env.example`: presencia idle a 60 segundos y desconectada a 180; mantenimiento 15 segundos; locks TTL 300, máximo 3600; eventos/mensajes retenidos 30 días, última situación de cada agente conservada. Secuencia por proyecto no se reinicia al limpiar eventos. Rate limit en memoria: 60000/min/IP y 3000/min/sujeto autenticado; cuentas con varios tokens comparten cuota. La IP del proxy se comparte y no se confía globalmente en `X-Forwarded-For`. Ajustar cuotas si hay muchos dashboards activos.

```powershell
pnpm benchmark
```

Runner: 100 conexiones HTTP/WS reales, emisor espaciado a 50 ms (máximo cinco peticiones en vuelo), inbox/ACK cada 1 s y DB en disco/WAL. Última medición: 600 mensajes + 60 eventos de locks en 30.36 s, 21.74 eventos/s (19.76 mensajes/s), sin pérdidas/duplicados/errores. Resultado en [evidence/network-benchmark.json](evidence/network-benchmark.json). La variante de envío secuencial con polling cada 500 ms bajó a 14.02 mensajes/s; se conserva el resultado y no se garantiza capacidad para esa variante. Prueba HTTPS/WSS, navegador, redacción, cierre por IPC y reinicio íntegro en [evidence/share-smoke.json](evidence/share-smoke.json). Métricas locales no garantizan latencia de Internet ni capacidad permanente del túnel.

Los locks coordinan intención y no impiden ediciones físicas de Git. Un agente inactivo no se despierta solo (ADR-006). No se introduce Docker, orquestación activa ni daemon.
