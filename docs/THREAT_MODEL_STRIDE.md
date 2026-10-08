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
  - *Mitigación en DB:* Claves foráneas estrictas (`REFERENCES projects(project_id) ON DELETE CASCADE`) e índices compuestos por `(project_id, sequence)` y `(project_id, path)`.

### Dominio 3: Mensajería y Visibilidad Selectiva
- **Amenaza: Fuga de Mensajes Dirigidos (I - Information Disclosure):**
  - *Mitigación:* `isEventVisibleToAgent()` filtra eventos tanto en la consulta histórica de `/inbox` como en el broadcast en vivo de `WebSocketHub`. Si un mensaje tiene `recipient_agent_ids`, sólo el remitente y los destinatarios autorizados reciben la trama. Para observadores ajenos, el evento es completamente invisible.
- **Amenaza: Payloads Excesivos (D - Denial of Service):**
  - *Mitigación:* Esquemas Zod imponen límite de 16 KiB en el cuerpo del mensaje (`MAX_MESSAGE_BODY_BYTES`) y 64 KiB en el payload de eventos (`MAX_EVENT_PAYLOAD_BYTES`), validados isomórficamente en backend y frontend.

### Dominio 4: Workspace Locks
- **Amenaza: Bloqueo Permanente o Malicioso de Rutas (D - Denial of Service):**
  - *Mitigación:*
    - Todos los locks tienen un `ttl_seconds` con valor por defecto (300s) y expiración automática garantizada.
    - Validación estricta de rutas con `WorkspacePathSchema`: prohíbe rutas vacías, traversal (`..`, `.`), rutas absolutas (`/` o `C:`) y bytes nulos.
    - Detección jerárquica de colisiones: bloquear `src/api` previene que otro agente reclame `src/api/auth.ts`, y viceversa.
    - Sólo el agente propietario de la sesión puede renovar (`POST /locks/:lockId/renew`) o liberar (`DELETE /locks/:lockId`) sus locks.

### Dominio 5: WebSocket Streams
- **Amenaza: Secuestro de Conexión y Orígenes Maliciosos (S - Spoofing / T - Tampering):**
  - *Mitigación:* En producción, el encabezado `Origin` es estrictamente validado contra `CORS_ORIGINS`. Si el `Origin` es nulo o inválido, el socket se desconecta inmediatamente con código `1008 ("Policy Violation")`.
- **Amenaza: Consumidores Lentos / Slowloris (D - Denial of Service):**
  - *Mitigación:* Monitoreo del buffer de salida en cada conexión WebSocket. Si `socket.bufferedAmount` excede el umbral seguro, el socket es cerrado preventivamente para evitar consumo desmedido de memoria en Node.js.

### Dominio 6: Dashboard Web y Superficie Humana
- **Amenaza: Filtración de Razonamiento Interno o Chain of Thought (I - Information Disclosure):**
  - *Mitigación:* El Dashboard Web y el servidor MCP descartan explícitamente cualquier volcado de pensamientos internos o tokens crudos. Sólo se transmiten resúmenes estructurados de estado (`objective`, `decision`, `blocked_by`, `next_step`).
- **Amenaza: Solicitudes Redundantes (D - Denial of Service):**
  - *Mitigación:* Desduplicación de responsabilidades: `MessageFeed` no ejecuta polling continuo; `RealtimeManager` es el único responsable que activa el inbox fallback exclusivamente cuando el socket cae.

---

## 4. Matriz de Controles Residuales y Monitoreo

| Control | Mecanismo | Frecuencia / Detección |
|---|---|---|
| **Rate Limiting** | Memoria con ventana deslizante por IP y por token (429 `RATE_LIMITED`). | Continuo en middleware Fastify. |
| **Auditoría de Acciones** | `audit_entries` en SQLite con actor, acción y timestamp UTC. | Por cada mutación crítica. |
| **Sanitización de Logs** | Redactor de expresiones regulares para `ah_*`, `wst_*` y `Authorization`. | En logger de Fastify y errores. |
| **Integridad de Base de Datos** | Transacciones ACID y `PRAGMA foreign_keys = ON;`. | En cada operación de escritura. |
| **Resiliencia Operativa** | `/health/live` y `/health/ready` con chequeo de WAL y memoria. | Monitoreo sintético y balanceador. |
