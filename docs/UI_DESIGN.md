# Renovación de UI/UX

Dirección implementada para Agents-Hub: una mesa de coordinación para desarrolladores que necesitan leer conversaciones, entender reportes y reservar archivos. No es una página promocional ni un orquestador automático.

## Sistema visual

- Navegación: azul marino `#14263d`; identifica el espacio de trabajo.
- Fondo: gris frío `#f4f6fa`; superficie: blanco `#ffffff`.
- Texto: tinta `#172a41`; secundario: `#52657b`.
- Acción/foco: azul `#2555db`. Éxito, advertencia y error conservan texto además del color.
- Tipografía local: Bahnschrift para títulos, Segoe UI/sistema para lectura; monospace sólo para rutas, canales e identificadores. No se descargan fuentes ni se añaden dependencias.
- Escala: controles de 44 px, espacios de 8/16/24/32 px, títulos 24–32 px y cuerpo 14–16 px. Bordes discretos; sombras sólo en superficies elevadas.

## Composición y revisión del brief

```text
Escritorio                         Móvil
┌─────────────┬──────────────────┐ ┌─────────────────────┐
│ Identidad   │ Proyecto / sesión│ │ Proyecto / conexión │
│ Mensajes    ├──────────────────┤ ├─────────────────────┤
│ Equipo      │ Título + contexto │ │ Navegación 4 destinos│
│ Archivos    │ Conversación      │ ├─────────────────────┤
│ Miembros    │ o lista + acción  │ │ Contenido y acciones│
│ Desconectar │                   │ │ en flujo vertical   │
└─────────────┴──────────────────┘ └─────────────────────┘
```

El resultado inicial de UI/UX Pro Max recomendaba una landing operativa y una paleta violeta. Se aprovechan sus guías verificadas de foco/etiquetas/adaptación, pero se sustituye la composición promocional por navegación persistente y contenido real del proyecto. Frontend Design orienta la identidad: el vínculo entre nodos de la pantalla de entrada expresa comunicación, y las conversaciones reciben mayor jerarquía que los controles secundarios. No se inventan métricas, actividad ni agentes de demostración en el producto.

## Interacción y límites

Navegación con estado visible y accesible; borradores y filtros permanecen al cambiar de sección. Mensajes con remitente, canal, fecha completa y privacidad explícita. Formularios etiquetados, foco visible, estados de carga/error y movimiento reducido. IDs y texto largo pueden ajustarse a varias líneas. Se conserva la API, autorización, historial/ACK, recuperación explícita y renovación idempotente de locks. La selección de destinatarios y respuestas 10.3 continúan pendientes.

Skills instaladas fuera del repositorio: `frontend-design` de `anthropics/skills` y `ui-ux-pro-max` de `nextlevelbuilder/ui-ux-pro-max-skill`, bajo `C:/Users/orlan/.codex/skills`. Ambas se leyeron y se utilizaron; sus recomendaciones no reemplazan las ADR ni el stack vigente.

## Verificación observada

El 2026-10-08: pnpm check (lint/TypeScript/135 pruebas) y build monorepo aprobados. Tras corregir el listener del historial del navegador, lint web/build web y los 11 E2E aprueban. El E2E de renovación verifica teclado, Volver, borradores y filtros conservados, filtros desplegables, envío con Ctrl+Enter, anchuras 375/768/1024/1440 y landscape con movimiento reducido. Capturas en test-results revisadas visualmente para conexión y las cuatro secciones. Los flujos previos siguen cubriendo privacidad, invitaciones, locks/idempotencia, reconexión y ACK. Estas comprobaciones no constituyen una auditoría completa WCAG ni reemplazan el piloto humano.
