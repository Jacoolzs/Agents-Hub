# 🛡️ Modelado de Amenazas STRIDE — Agents-Hub

Este documento establece el modelo formal de análisis y mitigación de amenazas para **Agents-Hub**, siguiendo la metodología **STRIDE** (*Spoofing, Tampering, Repudiation, Information Disclosure, Denial of Service, Elevation of Privilege*).

---

## 1. Alcance y Arquitectura del Sistema

Agents-Hub es un sistema distribuido ligero compuesto por:
1. **Hub Server (`apps/hub-server`):** Autoridad central que expone APIs REST y WebSockets sobre SQLite con WAL.
2. **Servidor MCP Local (`packages/mcp-server`):** Adaptador ejecutado por el desarrollador que comunica el agente local con el Hub a través de `stdio` y HTTPS.
3. **Dashboard Web (`apps/web`):** Aplicación SPA (React/Vite) para supervisión humana e interacción directa.
4. **Contratos Compartidos (`packages/shared`):** Esquemas Zod y validaciones universales isomórficas.

### Fronteras de Confianza (Trust Boundaries)
- **Frontera Externa (WAN / Internet / LAN):** Navegador Web y Agentes locales MCP cruzando hacia el Hub mediante HTTPS / WSS.
- **Frontera de Identidad / Sesión:** Token Bearer (`ah_*`) emitido por usuario autenticado vinculado a sesiones específicas de agentes (`agent_sessions`).
- **Frontera de Proyecto (Tenant Boundary):** Cada proyecto es un espacio completamente aislado. Ningún usuario o agente debe leer o escribir recursos de otro proyecto.
- **Frontera Local de Proceso:** El servidor MCP corre en el host del usuario; se comunica vía `stdio` puro con el LLM y por HTTPS autenticado con el Hub.

---

## 2. Matriz de Amenazas STRIDE por Componente

| Dominio | S (Spoofing) | T (Tampering) | R (Repudiation) | I (Info Disclosure) | D (Denial of Service) | E (Elevation of Privilege) |
|---|---|---|---|---|---|---|
| **1. Identidad y Autenticación** | Suplantación de tokens de usuario o agent_id arbitrario. | Manipulación de payloads de autenticación o tokens en tránsito. | Agente niega haber emitido un token o creado una sesión. | Exposición de Bearer tokens en URLs, logs o storage local. | Ataques de fuerza bruta en emisión de tickets o sesiones. | Uso de sesión ajena para actuar en nombre de otro agente. |
| **2. Proyectos y Aislamiento** | Usuario sin membresía reclama acceso a un proyecto ajeno. | Inyección de mensajes o locks en un proyecto ajeno. | Eliminación o modificación no registrada de un proyecto. | Fuga de eventos, nombres de archivos o agentes de otro proyecto. | Creación masiva de proyectos para agotar SQLite. | Miembro 'reader' ejecuta operaciones de escritura o administración. |
| **3. Mensajes y Coordinación** | Envío de mensaje fingiendo ser otro agente (`sender_id`). | Alteración de mensajes o prioridades en tránsito. | Remitente niega haber enviado una directiva. | Mensajes dirigidos (Alice→Bob) interceptados por Charlie o en WS broadcast. | Envío de mensajes de 100 MB para saturar memoria o buffer de socket. | Forzar broadcast de mensajes clasificados mediante alteración de payload. |
| **4. Workspace Locks** | Agente A libera o roba un lock adquirido por el Agente B. | Modificación arbitraria del TTL para bloquear indefinidamente. | Agente niega haber bloqueado un módulo impidiendo el release. | Revelación de rutas privadas o archivos confidenciales en el lock. | Reclamar todos los directorios raíz (`/`, `.`) paralizando a los demás. | Agente sin rol de escritura adquiere locks críticos. |
| **5. WebSocket Streams** | Conexión WebSocket no autenticada o con sesión suplantada. | Inyección de tramas de control WebSocket desde orígenes no confiables. | Desconexión abrupta sin rastro en el Hub. | Captura de tokens en la query string en logs de proxy o CDN. | Saturación de memoria por consumidores lentos o conexiones infinitas. | Obtención de stream de eventos de otro proyecto sin ticket válido. |
| **6. Dashboard Web** | Sesión secuestrada por lectura de localStorage o XSS. | Manipulación de estado local o inyección de scripts en mensajes. | Acciones no trazadas desde la UI. | Fuga de Chain of Thought o razonamiento privado en la interfaz. | Polling redundante saturando la red o CPU del cliente. | Bypass de interfaz para invocar endpoints restringidos. |

---

## 3. Análisis Detallado y Mitigaciones Implementadas

### Dominio 1: Identidad y Autenticación
- **Amenaza: Exposición de Tokens en URL o Storage (I - Information Disclosure):**
  - *Vulnerabilidad:* Pasar `?token=ah_...` en la URL del WebSocket permite que proxies, balanceadores, historial del navegador y logs capturen el token.
  - *Mitigación:* Se implementó el protocolo de **Tickets WebSocket Efímeros** (ADR-015):
    - La URL nunca recibe el token Bearer.
    - Se solicita previamente vía HTTPS seguro (`POST /ws-ticket`).
    - El ticket dura 30 segundos, tiene prefijo `wst_*`, hash SHA-256 en base de datos y se consume atómicamente en una única sentencia `UPDATE ... RETURNING`.
    - En el Dashboard, los tokens se almacenan **únicamente en memoria de React (`useState`)**, eliminando cualquier persistencia en `localStorage` o `sessionStorage`.
- **Amenaza: Suplantación de Agente (`sender_id`) (S - Spoofing / E - Elevation):**
  - *Mitigación:* Las rutas HTTP (`POST /messages`, `POST /status`, `POST /locks/claim`) prohíben confiar en `sender_id` o `agent_id` provistos en el body. La identidad del agente se deriva obligatoriamente del `session_id`, el cual está validado contra el usuario autenticado y el proyecto (`validateSessionForUser`).

### Dominio 2: Proyectos y Aislamiento Multitenant
- **Amenaza: Acceso Cruzado entre Proyectos (I - Information Disclosure / T - Tampering):**
  - *Mitigación:* Cada operación en el Hub ejecuta invariablemente `authService.checkProjectPermission(userId, projectId)`. Si el usuario no pertenece al proyecto o carece del rol necesario, la llamada falla inmediatamente con `FORBIDDEN` (HTTP 403).
  - *Mitigación en DB:* Claves foráneas estrictas (`REFERENCES projects(project_id) ON DELETE CASCADE`), unicidad e índice `(project_id, sequence)` y lookup de locks por `(project_id, expires_at)`. Rutas son JSON y sus conflictos se comparan en el servicio; no existe índice por path.

### Dominio 3: Mensajería y Visibilidad Selectiva
- **Amenaza: Fuga de Mensajes Dirigidos (I - Information Disclosure):**
  - *Mitigación:* `isEventVisibleToAgent()` filtra eventos tanto en la consulta histórica de `/inbox` como en el broadcast en vivo de `WebSocketHub`. Si un mensaje tiene `recipient_agent_ids`, sólo el remitente y los destinatarios autorizados reciben la trama. Para observadores ajenos, el evento es completamente invisible.
- **Amenaza: Payloads Excesivos (D - Denial of Service):**
  - *Mitigación:* Esquemas compartidos imponen 16 KiB al mensaje y 64 KiB al envelope. Hub valida entradas, limita cuerpos HTTP y frames WS a 64 KiB; MCP valida envelopes recibidos y resultados de mensaje/estado/claim. No se afirma validación runtime universal de cada respuesta del navegador.

### Dominio 4: Workspace Locks
- **Amenaza: Bloqueo Permanente o Malicioso de Rutas (D - Denial of Service):**
  - *Mitigación:*
    - Todos los locks tienen un `ttl_seconds` con valor por defecto (300s) y expiración automática garantizada.
    - Validación estricta con `NormalizedWorkspacePathSchema`: prohíbe rutas vacías, traversal (`..`, `.`), rutas absolutas (`/` o `C:`), bytes nulos y wildcards. Canoniza barras Windows/repetidas y slash final.
    - Detección jerárquica de colisiones: bloquear `src/api` previene que otro agente reclame `src/api/auth.ts`, y viceversa.
    - Propietario controla sus locks; owner del proyecto tiene override explícito. TTL de claim/renew entre 1 y 3600 segundos. Expiración elimina fila y emite evento transaccional una vez.

### Dominio 5: WebSocket Streams
- **Amenaza: Secuestro de Conexión y Orígenes Maliciosos (S - Spoofing / T - Tampering):**
  - *Mitigación:* En producción, el encabezado `Origin` es estrictamente validado contra `CORS_ORIGINS`. Si el `Origin` es nulo o inválido, el socket se desconecta inmediatamente con código `1008 ("Policy Violation")`.
- **Amenaza: Consumidores Lentos / Slowloris (D - Denial of Service):**
  - *Mitigación:* Monitoreo del buffer de salida en cada conexión WebSocket. Si `socket.bufferedAmount` excede el umbral seguro, el socket es cerrado preventivamente para evitar consumo desmedido de memoria en Node.js.

### Dominio 6: Dashboard Web y Superficie Humana
- **Amenaza: Filtración de Razonamiento Interno o Chain of Thought (I - Information Disclosure):**
  - *Mitigación:* Contrato y reglas de uso piden resúmenes (`objective`, `decision`, `blocked_by`, `next_step`) y prohíben razonamiento privado. Se rechazan credenciales con prefijos obvios/Bearer/claves privadas en mensajes, estado y razón de lock. Es defensa básica, sin detector general de secretos ni descarte semántico automático de pensamientos.
- **Amenaza: Solicitudes Redundantes (D - Denial of Service):**
  - *Mitigación:* `RealtimeManager` es la única autoridad del inbox: lectura incremental ordenada, ACK después de entrega al estado UI, deduplicación ante retry, polling cuando WS cae y retry visible si falla inbox/ACK con WS abierto. `MessageFeed` consume ese estado y no relee el historial por evento.

---

## 4. Matriz de Controles Residuales y Monitoreo

| Control | Mecanismo | Frecuencia / Detección |
|---|---|---|
| **Rate Limiting** | Ventana deslizante por IP y sujeto verificado; varios tokens de una cuenta comparten cuota (429 `RATE_LIMITED`). | Continuo en middleware Fastify. |
| **Auditoría de Acciones** | `audit_entries` en SQLite con actor, acción y timestamp UTC. | Por cada mutación crítica. |
| **Sanitización de Logs** | Redactor de expresiones regulares para `ah_*`, `wst_*` y `Authorization`. | En logger de Fastify y errores. |
| **Integridad de Base de Datos** | Transacciones ACID y `PRAGMA foreign_keys = ON;`. | En cada operación de escritura. |
| **Resiliencia Operativa** | Live/readiness SQLite; información de WAL/memoria sólo en desarrollo/test. Supervisor PC probado por IPC, backup/restore y reinicio íntegro. | Smoke público efímero y pruebas locales; sin garantía de servicio continuo. |

Invitaciones: hash SHA-256, TTL, revocación y consumo atómico con membresía; identidades provisionadas por CLI local. Scopes y roles se intersectan. Tickets se vinculan al token emisor y sockets revalidan token/membresía/sesión al conectar, ante eventos y periódicamente; revocación HTTP cierra inmediatamente, CLI al siguiente evento/mantenimiento. CI remoto y sesión con productos LLM diferentes siguen pendientes, según `MVP_CLOSEOUT.md`.
