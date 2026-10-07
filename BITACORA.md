# 📓 Bitácora de Proyecto: Agents-Hub

Este documento actúa como la **memoria viva y persistente** del proyecto `Agents-Hub`.
Cada avance, idea, decisión de diseño, bloqueo y solución debe registrarse aquí de forma obligatoria y cronológica.

---

## 📌 Metadatos del Proyecto
- **Nombre:** Agents-Hub
- **Repositorio:** [https://github.com/Jacoolzs/Agents-Hub](https://github.com/Jacoolzs/Agents-Hub)
- **Creador / Líder:** Jacoolzs (Orlando)
- **Fecha de inicio:** 2026-10-07
- **Enfoque:** Plataforma de Orquestación y Colaboración Multi-Agente basada en MCP + Eventos / Docker Sandbox + Dashboard Web en tiempo real.

---

## 🎯 Visión y Misión del Proyecto

### La Idea
`Agents-Hub` no busca ser otro editor de código ni otro modelo de IA. Es una **capa de orquestación y colaboración entre agentes y desarrolladores**.
Permite que cada desarrollador conserve su propio entorno local, terminal y agente preferido (Claude Code, Antigravity, Cursor, Aider, custom scripts), mientras `Agents-Hub` coordina el trabajo en equipo:
1. **Orquestación inteligente:** Asignación de tareas, dependencias, entregas y resolución de bloqueos.
2. **Contexto de trabajo compartido (en lugar de thoughts en crudo):** Transmisión de objetivos, decisiones técnicas, estado de tareas y eventos relevantes de workspace (no dumping de tokens de razonamiento crudo).
3. **Colaboración como equipo de software real:** Comunicación intencional entre agentes (peticiones de contratos de API, revisiones, handoffs).
4. **Seguridad y aislamiento con Docker:** Aislamiento de entornos y ejecución de pruebas para validar cambios antes de integraciones.
5. **Human-in-the-loop:** Supervisión constante a través del Dashboard Web, con control de aprobaciones y visualización en tiempo real.

---

## 🧭 Registro de Decisiones de Arquitectura (ADRs)

| ID | Fecha | Decisión | Justificación | Estado |
|---|---|---|---|---|
| ADR-001 | 2026-10-07 | Adoptar **MCP (Model Context Protocol)** como interfaz de agente | Estándar abierto de la industria; permite que cualquier agente existente descubra herramientas de colaboración sin wrappers invasivos. | Aceptado |
| ADR-002 | 2026-10-07 | Rol de la plataforma: **Orquestación + Comunicación** | Un chat pasivo genera ruido. La plataforma debe ser el "Project Manager / Tech Lead" que gestiona tareas, dependencias, locks y handoffs. | Aceptado |
| ADR-003 | 2026-10-07 | Modelo de **Contexto Compartido Estructurado** (No thoughts crudos) | El dumping de CoT crudo satura tokens y agrega ruido. Se comparten: Objetivos, Decisiones, Contratos, Bloqueos y Eventos de archivos modificados. | Aceptado |
| ADR-004 | 2026-10-07 | Uso de **Sandboxes / Docker** para entornos de validación y pruebas | Permite validar entregas de agentes, compilar y correr tests de integración de forma segura antes de fusionar código de distintos desarrolladores. | Aceptado |
| ADR-005 | 2026-10-07 | Modelo híbrido: **Hub Central + Daemon/MCP Local + Dashboard Web** | Desacopla la UI de la ejecución local y centraliza la sincronización de estado de la sala. | Aceptado |

---

## 🏗️ Los 4 Componentes Clave de Agents-Hub

```
┌─────────────────────────────────────────────────────────────────┐
│                      1. Dashboard Web                           │
│  - Chat grupal y menciones entre humanos/agentes                │
│  - Tablero de Tareas, Dependencias y Bloqueos (tipo Kanban)    │
│  - Feed de Decisiones y Eventos de Workspace                    │
│  - Panel de Aprobaciones Humanas (Human-in-the-Loop)            │
└────────────────────────────────┬────────────────────────────────┘
                                 │ WebSockets / SSE / REST
┌────────────────────────────────▼────────────────────────────────┐
│                   2. Collaboration Hub Server                   │
│  - Gestión de Salas (Rooms) y Presencia de Miembros             │
│  - State Engine: Asignación de Tareas, Locks de Archivos        │
│  - Event Bus & Router (Eventos de Entrega, Alertas, Handoffs)   │
│  - Sandbox Runner (Docker) para validación de builds/tests      │
└──────────────┬──────────────────────────────────┬───────────────┘
               │                                  │
    TLS / WSS  │                                  │  TLS / WSS
               ▼                                  ▼
┌──────────────────────────────┐  ┌──────────────────────────────┐
│  3. Capa Local / MCP Server  │  │  3. Capa Local / MCP Server  │
│  (Máquina Desarrollador A)   │  │  (Máquina Desarrollador B)   │
└──────────────┬───────────────┘  └──────────────┬───────────────┘
               │ MCP stdio/HTTP                  │ MCP stdio/HTTP
┌──────────────▼───────────────┐  ┌──────────────▼───────────────┐
│     4. Agente de Terminal    │  │     4. Agente de Terminal    │
│   (Claude Code / Cursor /    │  │   (Claude Code / Cursor /    │
│       Antigravity / etc.)    │  │       Antigravity / etc.)    │
└──────────────────────────────┘  └──────────────────────────────┘
```

---

## 🛠️ Especificación de Herramientas MCP (`team-hub-mcp`)

1. **`report_intent_and_decision`**:
   - *Inputs:* `objective` (string), `decision` (string), `files_impacted` (array), `needs_from_others` (string).
   - *Efecto:* Publica la decisión en el Hub y notifica a agentes afectados.
2. **`claim_module_lock`**:
   - *Inputs:* `paths` (array de archivos/directorios), `reason` (string).
   - *Efecto:* Reserva temporalmente un área de trabajo para evitar colisiones.
3. **`release_module_lock`**:
   - *Inputs:* `paths` (array).
   - *Efecto:* Libera el área para otros compañeros.
4. **`send_targeted_message`**:
   - *Inputs:* `to_agent` (string), `message` (string), `context` (object opcional).
   - *Efecto:* Despierta o envía mensaje directo a un compañero específico (ej. pedir contrato de API).
5. **`submit_task_delivery`**:
   - *Inputs:* `task_id` (string), `summary_of_changes` (string), `test_results` (string), `branch_name` (string).
   - *Efecto:* Marca tarea lista para revisión/merge y despierta al agente o humano responsable del siguiente paso.
6. **`get_project_context`**:
   - *Inputs:* `filter` (opcional: 'tasks' | 'decisions' | 'locks' | 'recent_activity').
   - *Efecto:* Retorna el estado sintetizado del proyecto sin saturar tokens.

---

## 📋 Entradas Cronológicas de la Bitácora

### [2026-10-07] — Refinamiento Estratégico y Definición del Core
#### 💡 Decisiones y Giros Estratégicos
- **De Chat a Orquestador:** Confirmado que el valor real de `Agents-Hub` es la **orquestación y coordinación activa**, no solo un canal de chat.
- **Formato del Contexto:** Descartado el streaming en bruto de todos los tokens de pensamiento (`Chain of Thought`). En su lugar, se implementa **Contexto Estructurado Compartido**:
  - Objetivos activos.
  - Decisiones tomadas y contratos acordados.
  - Registro de bloqueos y dependencias.
  - Eventos clave de actividad y herramientas sobre el workspace.
- **Aislamiento y Verificación:** Se integra el concepto de **Docker / Sandbox** para probar de forma aislada las entregas antes de fusionar código entre desarrolladores.
- **Compatibilidad Abierta:** Mantener enfoque en agentes existentes (Claude Code, Cursor, Antigravity, Aider) vía MCP.

#### 🚀 Acciones Realizadas
- Creación de repositorio en GitHub: [Agents-Hub](https://github.com/Jacoolzs/Agents-Hub).
- Creación y sincronización de `README.md` y `BITACORA.md`.
- Registro formal de ADR-001 a ADR-005.
- Definición formal de la arquitectura de 4 capas y el contrato de herramientas MCP iniciales.

#### 🔮 Próximos Pasos (Fase 1 del MVP: Sala Compartida y Coordinación Básica)
- [ ] Definir el stack tecnológico del **Hub Server** (ej. Node.js/TypeScript con WebSockets o FastAPI).
- [ ] Definir el stack del **Dashboard Web** (Next.js / Tailwind CSS / Lucide / Socket.io client).
- [ ] Implementar el paquete del **Servidor MCP** (`team-hub-mcp`) para conectar a clientes locales.
- [ ] Diseñar el modelo de datos de la Sala: Tareas, Locks, Miembros, Eventos y Decisiones.
