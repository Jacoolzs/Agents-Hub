# 📓 Bitácora de Proyecto: Agents-Hub

Este documento actúa como la **memoria viva y persistente** del proyecto `Agents-Hub`.
Cada avance, idea, decisión de diseño, bloqueo y solución debe registrarse aquí de forma obligatoria y cronológica.

---

## 📌 Metadatos del Proyecto
- **Nombre:** Agents-Hub
- **Repositorio:** [https://github.com/Jacoolzs/Agents-Hub](https://github.com/Jacoolzs/Agents-Hub)
- **Creador / Líder:** Jacoolzs (Orlando)
- **Fecha de inicio:** 2026-10-07
- **Enfoque inicial:** Arquitectura MCP (Model Context Protocol) + Hub Central WebSockets + Dashboard Web en tiempo real.

---

## 🎯 Visión y Misión del Proyecto

### La Idea
Crear una plataforma donde el agente de terminal de un desarrollador se conecte a un chat/sala compartida junto con los agentes de sus amigos/compañeros de equipo.
Los agentes:
1. Trabajan colaborativamente en el mismo proyecto.
2. Hablan entre ellos de forma natural y eficiente (como humanos en un equipo).
3. Comparten sus pensamientos (*Chain of Thought / thoughts* y planes) en tiempo real.
4. Evitan colisiones de código mediante coordinación y bloqueos dinámicos de trabajo.

### Principios Fundamentales
1. **Comportamiento humano y colaborativo:** Comunicación clara, handoffs de tareas y preguntas contextuales entre pares.
2. **Eficiencia de contexto y tokens:** No saturar la ventana de contexto de los modelos con ruido innecesario; filtrar y sintetizar el estado del equipo.
3. **Ecosistema abierto con MCP:** Usar MCP para ser agnóstico del cliente LLM (Claude Code, Antigravity, Cursor, Aider, CLI custom).
4. **Human-in-the-loop:** Visibilidad total para los humanos mediante un Dashboard Web donde pueden seguir la conversación, ver pensamientos y tomar decisiones clave.

---

## 🧭 Registro de Decisiones de Arquitectura (ADR Preliminares)

| ID | Fecha | Decisión | Justificación | Estado |
|---|---|---|---|---|
| ADR-001 | 2026-10-07 | Adoptar **MCP (Model Context Protocol)** como interfaz de agente | Estándar de la industria, permite interoperabilidad con múltiples LLMs/herramientas sin reinventar la rueda de ejecución. | Aceptado |
| ADR-002 | 2026-10-07 | Modelo de **Dashboard Web + Agentes Locales** | Los desarrolladores mantienen su entorno de trabajo y repositorios locales mientras el Hub web actúa de punto de encuentro y orquestación. | Aceptado |
| ADR-003 | 2026-10-07 | Mantener **Bitácora de memoria viva** en el repositorio | Garantizar trazabilidad completa de ideas, investigaciones, bloqueos y avances en cada iteración. | Aceptado |

---

## 📋 Entradas Cronológicas de la Bitácora

### [2026-10-07] — Nacimiento del Proyecto y Definición Inicial

#### 💡 Conceptos explorados
- Se discutieron los 3 enfoques para el MVP:
  1. CLI/Daemon universal wrapper.
  2. Framework multi-agente propietario desde cero.
  3. **Plataforma web + servidor MCP local conectado a un Hub central** (Enfoque seleccionado).
- Se conceptualizó el conjunto preliminar de herramientas MCP requeridas:
  - `send_team_message`: Comunicación activa en el canal de la sala.
  - `ask_teammate`: Preguntas directas punto a punto entre agentes.
  - `broadcast_thought`: Emisión de pensamientos y planes al feed cognitivo sin contaminar el chat principal.
  - `claim_workspace_area` / `release_workspace_area`: Mecanismo de semáforo/lock dinámico de archivos o módulos para evitar conflictos en Git.
  - `get_team_status`: Consulta del estado actual de los miembros conectados y sus asignaciones.

#### 🚀 Acciones Realizadas
- Autenticación configurada con GitHub CLI (`gh`).
- Creación del repositorio público: `Jacoolzs/Agents-Hub`.
- Clonado local en `C:\Users\orlan\Documents\GitHub\Agents-Hub`.
- Creación del `README.md` y estructura de la `BITACORA.md`.

#### 🚧 Bloqueos y Obstáculos
- *Ninguno activo al momento.* El flujo de autenticación de GitHub completó exitosamente.

#### 🔮 Próximos Pasos a Investigar / Definir
- [ ] Definir el stack tecnológico del Hub / Servidor (ej. TypeScript / Node.js con WebSockets o NestJS / Fastify, o Go / Python).
- [ ] Definir el stack del Dashboard Web (Next.js / Vite + React / Tailwind / etc.).
- [ ] Diseñar el esquema de mensajes y eventos WebSocket (contrato entre MCP y Hub).
- [ ] Especificar la implementación del servidor MCP (`team-sync-mcp`).
