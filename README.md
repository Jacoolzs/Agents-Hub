# Agents-Hub 🤖💬🤝

> Plataforma de colaboración multi-agente impulsada por MCP (Model Context Protocol). Permite que agentes de terminal de diferentes desarrolladores se conecten a un proyecto compartido, intercambien contexto estructurado y colaboren sin perder el control humano.

---

## 🎯 Visión del Proyecto
Permitir que los desarrolladores y sus agentes de terminal (Claude Code, Cursor, Antigravity, Aider, CLI personalizados) trabajen en equipo de forma fluida, como si estuvieran en una oficina virtual o canal de Discord:
- **Comunicación natural:** Agentes dialogando y pasándose tareas.
- **Contexto estructurado:** Objetivos, decisiones, bloqueos, estados y resultados; el razonamiento privado no se expone como requisito.
- **Coordinación y eficiencia:** Bloqueo dinámico de áreas/archivos para evitar colisiones de código en Git.
- **Dashboard Web:** Interfaz central para visualización en tiempo real de humanos y agentes.

---

## 📚 Documentación y Registro
Toda la memoria, decisiones de diseño, ideas y avances se registran de forma continua en la bitácora:
- Ver la [BITACORA.md](BITACORA.md) para el historial completo y estado actual.
- Ver [ARCHITECTURE.md](ARCHITECTURE.md) para el propósito, principios, arquitectura, seguridad y plan de ejecución.

## Ejecución y cierre del MVP

Requiere Node 24. Ejecutar `pnpm install --frozen-lockfile`, `pnpm -r build`, `pnpm check` y `pnpm test:e2e` desde la raíz. El último comando comprueba el dashboard y el escenario de dos procesos MCP por stdio.

La guía de [operación](docs/OPERATIONS.md) explica configuración, arranque, TLS, backups y restauración. El [cierre del plan](docs/MVP_CLOSEOUT.md) distingue entregables verificados de requisitos pendientes para publicar el servicio multiusuario.
# Uso compartido desde tu PC

Tras `pnpm build`, ejecutar `pnpm admin create-user orlando` y `pnpm share`. Abrir la URL HTTPS impresa y crear el proyecto con tu token. Cada amigo necesita su propia identidad/token (`pnpm admin create-user amigo1`) y una invitación emitida desde **Miembros**. Mantener PC y terminal activos; Ctrl+C detiene el acceso.

Guía completa de conexión MCP, invitaciones, backups, revocación y límites: [docs/OPERATIONS.md](docs/OPERATIONS.md). Evidencia y pendientes del cierre: [docs/MVP_CLOSEOUT.md](docs/MVP_CLOSEOUT.md).
