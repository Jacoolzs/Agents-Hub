# 📓 Bitácora de Proyecto: Agents-Hub

Este documento actúa como la **memoria viva y persistente** del proyecto `Agents-Hub`.
Cada avance, idea, decisión de diseño, bloqueo y solución debe registrarse aquí de forma obligatoria y cronológica.

---

## 📌 Metadatos del Proyecto
- **Nombre:** Agents-Hub
- **Repositorio:** [https://github.com/Jacoolzs/Agents-Hub](https://github.com/Jacoolzs/Agents-Hub)
- **Creador / Líder:** Jacoolzs (Orlando)
- **Fecha de inicio:** 2026-10-07
- **Enfoque MVP:** Capa de Comunicación Colaborativa + Estado Compartido + Locks de Archivos mediante MCP + WebSockets + Hub Central ligero.

---

## 🎯 Visión y Misión del Proyecto

### La Idea
`Agents-Hub` es una **capa de colaboración entre agentes de desarrollo y sus desarrolladores**.
Permite que cada persona mantenga su entorno local, su terminal y su agente preferido (Claude Code, Antigravity, Cursor, Aider, etc.), mientras `Agents-Hub` facilita:
1. **Comunicación intencional entre agentes:** Diálogo directo (peticiones de contratos, preguntas, handoffs de tareas).
2. **Contexto de trabajo compartido:** Resúmenes estructurados de objetivos, decisiones técnicas, bloqueos y eventos de archivos modificados (evitando saturación de tokens de razonamiento crudo).
3. **Locks de archivos/módulos:** Evitar pisarse el código en Git antes de editar.
4. **Visibilidad humana:** Una interfaz mínima donde los desarrolladores observan la interacción de sus agentes y el estado del proyecto.

---

## 🧭 Registro de Decisiones de Arquitectura (ADRs)

| ID | Fecha | Decisión | Justificación | Estado |
|---|---|---|---|---|
| ADR-001 | 2026-10-07 | Adoptar **MCP (Model Context Protocol)** como interfaz de agente | Estándar abierto; interoperable con agentes existentes sin alterar su motor interno. | Aceptado |
| ADR-002 | 2026-10-07 | Alcance del MVP: **Comunicación + Estado Compartido** (Orquestación activa diferida) | Mantener el MVP simple y viable. Demostrar primero que dos agentes pueden hablar y coordinarse. Orquestación compleja (asignación automática, tech lead autónomo) pasa a Fase 2. | Aceptado (Corregido) |
| ADR-003 | 2026-10-07 | Modelo de **Contexto Compartido Estructurado** (No thoughts crudos) | El dumping de CoT completo satura tokens y genera ruido. Se comparten objetivos, decisiones, contratos y bloqueos. | Aceptado |
| ADR-004 | 2026-10-07 | Sandbox / Docker **diferido a fase futura** | Evitar scope creep en el MVP. Validar primero la coordinación básica antes de introducir entornos de pruebas aislados. | Aceptado (Diferido) |
| ADR-005 | 2026-10-07 | Monorepo en TypeScript con arquitectura simple | `@modelcontextprotocol/sdk` maduro en TS; compartir tipos entre `packages/mcp-server`, `packages/hub-server`, `packages/shared` y `packages/web`. Backend mínimo con SQLite + WebSockets. | Aceptado |
| ADR-006 | 2026-10-07 | Mecanismo de recepción de mensajes en agentes | *En evaluación técnica:* Resolver cómo un agente dormido en terminal recibe o consulta mensajes (ver análisis de alternativas A, B y C). | En discusión |

---

## 🔍 Análisis Técnico Clave: Recepción de Mensajes en Terminal

Un agente de terminal funciona por ciclo de petición/respuesta. No escucha sockets pasivamente a menos que se diseñe un mecanismo explícito:

### Alternativas evaluadas:
1. **Opción A (`check_inbox` + Prompting):** Herramienta MCP donde el agente revisa mensajes entrantes de compañeros al iniciar o finalizar pasos. 
   - *Pros:* 100% compatible con cualquier cliente MCP sin wrappers.
   - *Contras:* Si el agente termina su turno y queda inactivo en la terminal, no se despierta hasta que el usuario le da una orden.
2. **Opción B (Blocking / Long-Polling Tool Call):** Herramienta tipo `wait_for_messages(timeout=30s)` que mantiene el socket abierto mientras espera un mensaje de un compañero.
   - *Pros:* Estándar MCP, mantiene al agente en escucha activa durante una sesión de trabajo colaborativo.
   - *Contras:* Mantiene al LLM ocupado mientras dura el polling.
3. **Opción C (Wrapper / CLI Daemon):** Un script que envuelve el proceso del agente y le inyecta prompts por `stdin` cuando llega un mensaje urgente de la sala.
   - *Pros:* Despierta al agente de forma reactiva real.
   - *Contras:* Acoplado al CLI específico de cada agente.

---

## 🛠️ Herramientas MCP del MVP Inicial (`team-hub-mcp`)

1. `send_team_message(channel, message, mentions?)`: Enviar mensaje al chat general o a un agente en específico.
2. `check_inbox()`: Consultar mensajes pendientes, menciones y novedades del equipo.
3. `report_status(objective, decision, blocked_by?)`: Publicar en qué se está trabajando y decisiones tomadas.
4. `claim_module_lock(paths, reason)`: Bloquear temporalmente archivos para evitar conflictos.
5. `release_module_lock(paths)`: Liberar archivos bloqueados.
6. `get_team_status()`: Consultar quién está conectado y qué áreas están bloqueadas.

---

## 📋 Entradas Cronológicas de la Bitácora

### [2026-10-07] — Regla de contexto obligatorio del repositorio
- Se establece `AGENTS.md` como la guía operativa del repositorio.
- Toda persona o agente debe leer completa `BITACORA.md` antes de planear, decidir arquitectura o modificar el proyecto.
- Todo avance relevante, decisión, bloqueo, solución o cambio de alcance debe registrarse en esta bitácora durante la misma sesión.
- Se conserva como estado vigente el alcance lean del MVP: comunicación, estado compartido y locks; orquestación activa y Docker quedan fuera hasta nueva decisión explícita.

### [2026-10-07] — Corrección de Alcance (MVP Lean) y Reto de Recepción de Mensajes
#### 💡 Correcciones y foco real
- **Ajuste de alcance:** Se corrige ADR-002: el MVP se centra estrictamente en **comunicación y coordinación básica**, no en orquestación automática compleja.
- **Docker diferido:** Se mueve Docker a fase futura para no inflar el alcance (scope creep).
- **Problema de reactividad de terminal:** Identificado formalmente el reto de cómo un agente dormido recibe mensajes. Abierto el análisis de las opciones A (inbox pulling), B (blocking polling) y C (CLI wrapper).
- **Estrategia de prueba local:** Probar el MVP primero con **dos terminales propias** en la misma máquina antes de involucrar a terceros.

#### 🚀 Acciones Realizadas
- Corrección de `BITACORA.md` con ADR-001 a ADR-006.
- Definición lean del stack (TypeScript monorepo, SQLite + WebSockets).
- Plan de testeo inicial local.
