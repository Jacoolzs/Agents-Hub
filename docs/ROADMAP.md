# Plan de evolución de Agents-Hub

Fecha: 2026-10-08. Base revisada: `main`, commit `13a81d8`.

## 1. Propósito y estado del plan

Convertir el piloto actual en una herramienta que un equipo pequeño pueda instalar, utilizar y mantener de forma habitual: agentes que intercambian contexto útil, personas que entienden qué ocurre y coordinación que sobrevive a fallos de conexión.

Este documento es una **propuesta de ejecución futura** solicitada por el usuario. No declara implementadas sus tareas ni aprueba automáticamente ampliaciones de alcance. Las decisiones aceptadas siguen en [BITACORA.md](../BITACORA.md); las fases originales 0–6 se conservan en [DEVELOPMENT_PLAN.md](../DEVELOPMENT_PLAN.md). La numeración 7 en adelante identifica la evolución, sin renumerar el historial.

Las fases 7–11 priorizan validación, facilidad de uso y consolidación. Las fases 12–14 proponen nuevas capacidades de colaboración. La fase 15 agrupa investigaciones condicionadas a evidencia y nuevas ADR. Los nombres de contratos, rutas y archivos nuevos son propuestas a concretar al iniciar cada tarea.

## 2. Punto de partida comprobado

| Área | Disponible | Trabajo que sigue |
|---|---|---|
| Comunicación | Mensajes dirigidos, estado, inbox, ACK, WebSocket y recuperación | Aceptación humana, historial navegable y búsqueda autorizada |
| Coordinación | Locks canónicos, conflicto jerárquico, TTL, renovación HTTP y override del owner | Renovación accesible desde MCP/UI y mejor experiencia de conflictos |
| Acceso | Usuarios por CLI, tokens, roles, invitaciones y revocación | Incorporación guiada, administración más cómoda y eventual sesión web |
| MCP | Nueve herramientas, stdio, heartbeat, cancelación e idempotencia | Instalación distribuible y matriz de clientes realmente probados |
| Operación | `pnpm share`, HTTPS/WSS temporal, backups, restore, logging y mantenimiento | Arranque persistente opcional, dirección estable y recuperación operativa |
| Arquitectura | Monolito modular, SQLite/WAL y migraciones | Servicios todavía acoplados a SQL; interfaces y límites de módulos pendientes |
| Calidad | Evidencia de 97 pruebas, siete E2E y CI Linux/Windows | Mantener regresiones y ampliar cobertura según nuevas capacidades |

La evidencia vigente está en [MVP_CLOSEOUT.md](MVP_CLOSEOUT.md). El benchmark de 100 clientes demuestra una carga local concreta; no acredita 100 usuarios con dashboards activos ni un SLA de Internet. La prueba humana con dos productos LLM distintos sigue pendiente. CI ya fue verificado y no debe volver a aparecer como trabajo por implementar.

Hipótesis de planificación: equipo pequeño, PC del anfitrión como primera instalación, repositorios locales independientes y administración humana. No se presupone un servicio comercial, una nube concreta ni presupuesto de infraestructura.

## 3. Orden, dependencias y tamaño

P0: evidencia de seguridad, pérdida de datos o bloqueo del piloto; se atiende antes que nuevas funciones. P1: necesaria para uso habitual. P2: mejora de colaboración. P3: exploración. Una hipótesis pendiente de reproducir no se clasifica como fallo P0 confirmado.

Tamaño relativo: S = cambio acotado; M = varios componentes y pruebas; L = contratos, persistencia y UI o integración. No equivale a una fecha de entrega. Cada L se divide en PR revisables; las estimaciones de calendario se harán después de la fase 7 y de conocer disponibilidad y clientes del equipo.

| Fase | Resultado | Prioridad | Tamaño | Dependencia |
|---|---|---|---|---|
| 7 | Piloto real aceptado y regresiones documentadas | P1; fallos graves P0 | M | Base actual |
| 8 | Dominio desacoplado y contrato de recuperación explícito | P1 | L | Base actual; hallazgos de 7 |
| 9 | Instalación y conexión guiadas | P1 | M | 7; contrato estable de 8 para distribuir |
| 10 | Historial, presencia y locks cómodos de usar | P1 | L | 8; resultados de 7 |
| 11 | Operación mantenible y release de uso habitual | P1 | L | 8–10 |
| 12 | Tareas y entregas coordinadas por personas | P2 | L | 11 y decisión de alcance |
| 13 | Integración Git informativa | P2 | M/L | 12 y decisión de alcance |
| 14 | Contexto reutilizable y avisos humanos | P2 | L | 10–12 y decisión de alcance |
| 15 | Evaluación de automatización y escala | P3 | Por experimento | Necesidad medida y ADR |

La documentación del piloto y el diseño de interfaces pueden avanzar a la vez; no se mezclan en un mismo PR refactor de persistencia, nuevas funcionalidades y migraciones. Los defectos graves descubiertos en cualquier fase interrumpen el trabajo de nuevas capacidades hasta corregirse.

## 4. Fase 7 — Aceptación real con el equipo

**Objetivo:** demostrar que personas con agentes reales pueden coordinar una tarea desde redes distintas.

| ID | Trabajo | Entregable |
|---|---|---|
| 7.1 | Elegir dos productos de agente usados por el equipo y registrar versiones, SO y configuración sin secretos | `docs/compatibility/clients.md` |
| 7.2 | Ejecutar una sesión desde cero: instalación, tokens propios, invitación y conexión | `docs/acceptance/pilot.md` con pasos y tiempos observados |
| 7.3 | Completar un trabajo dividido entre dos agentes: estado, lock, mensaje dirigido, respuesta y liberación | Evidencia sanitizada y resultado revisado por las personas |
| 7.4 | Probar desconexión, reinicio MCP, token vencido/revocado, conflicto de lock y recuperación | Incidencias reproducibles y pruebas de regresión para defectos |
| 7.5 | Clasificar fricción de uso frente a errores funcionales y priorizar el siguiente lote | Backlog con severidad, responsable y criterio de salida |

**Aceptación:** dos personas en redes distintas y dos productos de agente distintos completan el escenario; un mensaje emitido durante desconexión se recupera sin acciones duplicadas después del ACK. El usuario revocado deja de tener acceso según los límites documentados. Se registra explícitamente cuándo fue necesario pedir al agente que revisara el inbox.

**Límite:** si sólo se dispone de un producto de agente, se registra aceptación parcial. El harness stdio existente no sustituye esa evidencia. No se desarrolla un daemon para hacer pasar esta prueba.

**Áreas:** `e2e/`, `packages/mcp-server`, dashboard y documentación. Las correcciones concretas se definen a partir de la reproducción, no de suposiciones.

## 5. Fase 8 — Consolidación de arquitectura y recuperación

**Objetivo:** cerrar la deuda estructural del plan inicial y hacer explícitos los límites del protocolo antes de ampliarlo.

| ID | Trabajo | Criterio de aceptación |
|---|---|---|
| 8.1 | Crear interfaces de repositorios y unidad de trabajo; migrar primero un servicio pequeño y luego mensajes, sesiones y locks | Servicios migrados sin imports de `node:sqlite` ni adaptadores concretos; pruebas de contrato con SQLite real |
| 8.2 | Mantener mensaje/estado/lock, evento, auditoría e idempotencia en una misma frontera transaccional | Rollback no deja entidades, eventos ni notificaciones parciales; evento externo sólo después de commit |
| 8.3 | Extraer rutas de `app.ts` y herramientas de `server.ts` por responsabilidad | Composición clara y comportamiento HTTP/MCP compatible; no crear capas vacías sólo por estructura |
| 8.4 | Especificar y probar cursor anterior a retención, página filtrada vacía y recuperación tras borrado de historial | Cliente recibe indicación explícita de historial no disponible y procedimiento de resincronización; no se interpreta silencio como entrega completa |
| 8.5 | Investigar dos procesos del mismo usuario con el mismo nombre de agente | Regresión reproduce comportamiento; contrato define rechazo de instancia concurrente o identidad de instancia separada antes de cambiarlo |
| 8.6 | Inventariar rutas, herramientas, errores y eventos; reconciliar especificación vigente | Documento/API contrastados con schemas y pruebas; incluye `ack_inbox` y `wait_for_messages` |

**Diseño propuesto para 8.4:** mantener una frontera de retención por proyecto, separar cursor de lectura de historial y checkpoint de consumo, y ofrecer snapshot autorizado del estado actual cuando haya huecos. El nombre del error y la negociación de capacidades se deciden antes de implementarlos. Nunca saltar el ACK automáticamente ni prometer recuperar mensajes que ya se eliminaron.

**Hechos que motivan la revisión:** el mantenimiento elimina eventos antiguos; la ruta de inbox inspeccionada no expone una frontera de retención. `SessionService` reutiliza sesión por proyecto/nombre/usuario. Son comportamientos observados por lectura de código; sus efectos extremos requieren pruebas antes de declarar un defecto.

**Áreas:** `apps/hub-server/src/application`, nuevos contratos de repositorios, `infrastructure/repositories`, `infrastructure/db`, `http/routes`, `packages/shared`, `packages/mcp-server/src/tools`.

**Migración:** el refactor inicial no cambia tablas. Si 8.4/8.5 requieren columnas o entidades, se entregan en cambios separados con upgrade desde la base anterior y restauración de backup. Un downgrade de binario no se supone compatible con cualquier esquema.

## 6. Fase 9 — Instalación, diagnóstico y acceso

**Objetivo:** que un amigo pueda conectar su agente sin asistencia continua del anfitrión.

1. **9.1 Diagnóstico local:** comando propuesto `doctor` para comprobar runtime, build, URL, conexión HTTPS, identidad, membresía y compatibilidad. Salida con causas y acciones, sin mostrar tokens; las comprobaciones por defecto no crean proyecto ni envían mensajes.
2. **9.2 Configuración guiada:** generar una plantilla del adaptador con ruta absoluta y nombre de agente; no sobrescribir configuración existente. Documentar los dos clientes de la fase 7 consultando su documentación oficial en el momento de implementación.
3. **9.3 Distribución reproducible:** preparar un artefacto versionado del adaptador con sus dependencias de workspace, checksums y prueba de instalación limpia. El paquete actual es privado; publicar en un registro es una decisión posterior sobre nombre, licencia y mantenimiento.
4. **9.4 Gestión de identidad:** facilitar listados de usuarios/tokens propios, expiración visible, rotación y revocación con la CLI existente y la UI cuando corresponda. Evitar que el operador tenga que editar SQLite.
5. **9.5 Sesión web opcional:** evaluar persistencia segura para no pegar un token después de cada recarga. Si se adopta, requiere ADR sobre cookies, CSRF, logout, expiración y revocación; los tokens MCP siguen siendo independientes. OAuth/OIDC no se introduce por defecto.

**Aceptación:** un participante nuevo sigue la guía sin editar código ni base de datos; recibe un diagnóstico útil ante URL incorrecta, token vencido o falta de membresía. La rotación permite continuar con la nueva credencial y rechaza la anterior. Configuraciones y bundles no contienen credenciales del equipo.

**Áreas:** `scripts/`, CLI administrativa, `packages/config`, `packages/mcp-server/package.json`, `ConnectView`, `MembersPanel`, CI y `docs/compatibility/`.

## 7. Fase 10 — Experiencia diaria: historial, presencia y locks

**Objetivo:** convertir la vista en tiempo real en una herramienta útil durante sesiones largas y al regresar al proyecto.

| ID | Capacidad propuesta | Aceptación |
|---|---|---|
| 10.1 | Historial paginado independiente del inbox confirmado | Recargar permite consultar mensajes retenidos; navegar atrás no modifica ACK ni vuelve a ejecutar eventos |
| 10.2 | Búsqueda por texto, canal, remitente, destinatario y fecha | Filtrado autorizado en servidor antes de paginar; terceros no infieren mensajes privados por resultados ni conteos |
| 10.3 | Respuestas correlacionadas y selección de destinatarios | Se sigue una conversación sin copiar IDs manualmente; la visibilidad de respuestas no amplía la del mensaje original |
| 10.4 | Presencia comprensible, actividad reciente y estados de conexión | UI distingue conexión del adaptador, actividad reportada y espera; heartbeat no se presenta como prueba de que el LLM está trabajando |
| 10.5 | Renovación explícita de lock en MCP y UI, cuenta regresiva y conflicto accionable | Propietario renueva sin soltar; ajenos no renuevan salvo owner; después de expirar se requiere reclamar de nuevo |
| 10.6 | Accesibilidad, teclado, móvil y estados vacíos/error | Flujos centrales funcionan con teclado y viewport pequeño; errores de permisos, red y cuota son distinguibles |

Para sesiones simultáneas, aplicar primero el contrato definido en 8.5. La renovación automática se evalúa sólo si existe una señal explícita de trabajo: un heartbeat por sí solo no debe conservar locks indefinidamente. Mantener renovación HTTP actual y compatibilidad de clientes anteriores.

**Pruebas:** E2E de recarga con historial, búsqueda entre proyectos y mensajes dirigidos, expiración/renovación, paginación con mensajes entrantes y recuperación de conexión. Medir memoria del feed con historial largo antes de introducir virtualización u otra dependencia.

**Áreas:** `MessageFeed`, `AgentsPanel`, `LocksPanel`, `HubContext`, API HTTP, servicios/repositorios de mensajes/locks y herramientas MCP.

## 8. Fase 11 — Operación estable y releases

**Objetivo:** que el anfitrión pueda actualizar, detectar problemas y recuperar el servicio sin improvisar.

1. **11.1 Perfil de instalación permanente opcional:** dirección HTTPS estable y arranque/reinicio supervisado. Elegir destino, responsable y mecanismo según el equipo; conservar `pnpm share` para pruebas. Registrar cualquier nuevo servicio o dependencia antes de incorporarlo.
2. **11.2 Backups programados:** frecuencia, retención, destino fuera del PC y protección de acceso. Verificar backup y restaurar periódicamente en una base nueva; evitar carreras entre mantenimiento, backup y cambio de versión.
3. **11.3 Actualización segura:** versión de aplicación/esquema, preflight, backup, parada, actualización, migración, readiness y rollback documentado. Primero ensayar en una copia de datos sanitizados.
4. **11.4 Observabilidad:** métricas de latencia, errores, conexiones, desfase del consumidor, rechazos por cuota, tamaño de DB/WAL y antigüedad del backup. Acceso administrativo; no publicar identidad ni contenido de mensajes en etiquetas.
5. **11.5 Rendimiento sostenido:** carga mixta con agentes y dashboards, reconexión simultánea, clientes lentos y varias horas de actividad. Comparar contra evidencia inicial y medir crecimiento de memoria/datos y tiempo del event loop.
6. **11.6 Gestión de datos:** exportación autorizada y archivado de proyecto; definir borrado y su relación con auditoría/backups antes de implementar eliminación irreversible. La exportación respeta visibilidad de mensajes incluso cuando quien la pide administra el proyecto.
7. **11.7 Releases:** versión, changelog, artefactos, compatibilidad mínima Hub/adaptador y matriz de CI. Revisar licencia antes de una distribución pública. Actualizar dependencias por lotes pequeños, sin migrar de SDK o base de datos por calendario.

**Aceptación operativa propuesta:** reinicio de equipo/servicio recupera acceso sin intervención sobre SQLite; restauración ensayada conserva membresías, locks según su vencimiento, checkpoints e idempotencia vigente. Definir y medir RPO (datos que se puede perder) y RTO (tiempo de recuperación) con el anfitrión. No anunciar objetivos hasta comprobarlos.

**Aceptación de carga:** primero establecer un perfil representativo y umbrales con el piloto. Exigir cero pérdida de mensajes aceptados dentro de la retención, ausencia de duplicados funcionales y recursos estabilizados. Registrar valores absolutos y distribución de latencia; separar mensajes/s de eventos/s y carga local de latencia pública.

**Áreas:** launcher, servidor, mantenimiento, backup/restore, migraciones, benchmark, health, CI y [OPERATIONS.md](OPERATIONS.md).

## 9. Fase 12 — Tareas, dependencias y entregas humanas

**Estado:** ampliación propuesta; concretar y registrar alcance antes de implementarla.

**Objetivo:** que los mensajes se conviertan en acuerdos de trabajo rastreables, manteniendo asignación y aceptación bajo control humano.

| ID | Trabajo | Contrato propuesto |
|---|---|---|
| 12.1 | Tareas con responsable, descripción y criterios de aceptación | Estados `todo`, `in_progress`, `blocked`, `in_review`, `done`, `cancelled`; transiciones y roles explícitos |
| 12.2 | Dependencias y bloqueo | Rechazar ciclos y referencias a proyectos ajenos; distinguir bloqueo de tarea de lock de archivo |
| 12.3 | Relacionar mensajes, estado y locks con una tarea | Relaciones opcionales y compatibles con flujo actual sin tareas |
| 12.4 | Entrega estructurada | Resumen, referencias a archivos/commits, pruebas ejecutadas, limitaciones y revisor |
| 12.5 | Tablero y herramientas MCP acotadas | Crear/consultar/actualizar tareas dentro de permisos; auditoría de cambios |

**Aceptación:** dos personas crean y reparten una tarea, registran una dependencia, entregan evidencia y revisan el resultado. Una tarea no pasa a terminada sólo porque un agente lo afirma; la política de aceptación humana debe quedar definida. Actualizaciones concurrentes se detectan con versión esperada o equivalente, sin sobrescribir silenciosamente.

**Datos y áreas:** nuevos schemas, tablas y eventos de tareas/entregas; servicios/repositorios, rutas, herramientas y panel web. Migraciones aditivas; reintentos idempotentes; todos los IDs referenciados se validan por proyecto.

**Fuera de esta fase:** elegir automáticamente quién trabaja, iniciar agentes, ejecutar comandos o hacer merges.

## 10. Fase 13 — Contexto Git y trazabilidad

**Estado:** integración futura propuesta, fuera del MVP original.

1. **13.1 Identidad de repositorio y workspace:** acordar cómo se relaciona un proyecto Hub con uno o más repositorios antes de cambiar namespaces de locks. Evitar que dos repos con `src/api` sean tratados como el mismo recurso sin intención.
2. **13.2 Contexto local de sólo lectura:** rama, commit base y rutas modificadas como metadatos reportados por un adaptador local y con consentimiento. No subir contenido de archivos, diffs ni URLs con credenciales por defecto.
3. **13.3 Entregas vinculadas:** referencias a commit/PR en tareas; distinguir información declarada por el agente de evidencia verificada mediante integración.
4. **13.4 Advertencias de coordinación:** detectar rutas reportadas que se superponen a locks o trabajo declarado de otros. Mostrar advertencia con contexto y fecha; no prometer resolver conflictos de Git.
5. **13.5 Integración remota opcional:** evaluar proveedor, scopes, firma de webhooks, deduplicación y revocación cuando exista necesidad de verificar PR/CI automáticamente.

**Aceptación:** dos clones diferentes reportan contexto al proyecto correcto; nombres de ramas no alteran identidad/autorización; ningún comando Git de escritura ni subida de archivos ocurre por conectar el adaptador. Replay de webhooks no duplica entregas y las credenciales de integración nunca llegan al agente.

**Áreas:** adaptador local separado, contratos compartidos, tareas, dashboard e integración HTTP opcional. Push/merge automático permanece fuera del alcance.

## 11. Fase 14 — Memoria compartida y avisos

**Estado:** mejoras propuestas después de validar uso habitual.

**14.1 Contexto duradero:** decisiones, contratos acordados, documentos breves y handoffs con autor, fecha, versión, enlaces a evidencia y estado vigente/sustituido. Proponer herramientas para consultar contexto relevante por tarea sin cargar todo el historial.

**14.2 Resúmenes revisables:** comenzar con plantillas y resúmenes aportados por personas/agentes. Si se evalúa generación automática, definir proveedor, consentimiento para enviar datos, coste y referencias a fuentes; conservar el original y permitir corregir el resumen. No almacenar razonamiento privado ni convertir una síntesis en autoridad del dominio.

**14.3 Avisos humanos:** indicadores de no leído, menciones, solicitudes de revisión y notificaciones de navegador opcionales. Preferencias por proyecto, límites de frecuencia y textos que no revelen mensajes privados en una pantalla bloqueada. Revisar permisos nuevamente al abrir el aviso.

**14.4 Reglas de colaboración:** convenciones versionadas del proyecto y recomendaciones de cuándo revisar inbox, reclamar rutas y entregar trabajo. El contenido recibido se trata como datos de compañeros, no como instrucciones privilegiadas que puedan cambiar permisos o ejecutar herramientas.

**Aceptación:** un integrante nuevo encuentra decisiones vigentes y su evidencia; un resumen no amplía visibilidad de sus fuentes; la revocación impide consultar contexto privado. Se puede desactivar cualquier aviso. Las notificaciones no despiertan automáticamente un agente inactivo: ADR-006 sigue vigente.

**Áreas:** schemas de contexto, repositorios y búsqueda autorizada, nuevas vistas, herramientas de consulta y preferencias de notificación.

## 12. Fase 15 — Investigación condicionada

No es una lista de compromisos de implementación. Cada línea necesita un problema observado, experimento acotado, criterios de abandono y una ADR antes de integrarse.

| Tema | Cuándo evaluarlo | Evidencia exigida y límite |
|---|---|---|
| Agentes inactivos / hooks de clientes | El piloto demuestra que pedir revisiones manuales impide colaborar | Compatibilidad oficial por cliente, consentimiento, cancelación, cuotas y protección contra bucles; no inyección genérica de prompts |
| Orquestación activa | Las tareas manuales ya funcionan y el equipo solicita delegación automática | Modelo de permisos, presupuestos, pasos aprobables, parada de emergencia y auditoría; primero experimento aislado |
| Ejecución aislada / Docker | Se decide ejecutar código o pruebas desde un servicio | Diseño de aislamiento, red, secretos, recursos y cleanup; Docker continúa sin ser requisito del Hub básico |
| PostgreSQL o varias instancias | SQLite medido no satisface capacidad, recuperación o alta disponibilidad requeridas | Benchmark comparativo, migración reversible, coordinación de locks/eventos e idempotencia entre nodos |
| Redis, colas o workers | Hay un cuello de botella concreto de distribución o trabajo bloqueante | Ganancia medible frente al monolito, semántica ante fallos y coste operativo |
| MCP remoto o más transportes | La instalación stdio limita clientes reales del equipo | Autenticación y compatibilidad verificadas, sin romper adaptador local ni autorización del Hub |
| Plugins, marketplace, P2P o sincronización de archivos | Demanda validada fuera del caso actual | Plan separado; no son dependencias de las fases 7–14 |

No hay fechas ni dependencias nuevas elegidas para estas investigaciones.

## 13. Reglas transversales de implementación

**Contratos y compatibilidad.** Cambios aditivos primero; clientes viejos deben ignorar campos opcionales o recibir un error accionable por incompatibilidad. No renombrar herramientas ni reinterpretar ACK silenciosamente. Validar tanto entrada como salida y documentar versión mínima.

**Seguridad.** Permisos en servidor, aislamiento por proyecto, visibilidad de mensajes dirigida y scopes intersectados con roles. Nuevas búsquedas, tareas, resúmenes, exportaciones y avisos deben conservar esas fronteras. Contenido de otros agentes no autoriza acciones ni exposición de secretos.

**Datos.** Toda migración se prueba desde el esquema anterior y con volumen representativo. Backup antes de migración de riesgo; restore a ruta nueva; conservar origen hasta verificar. No almacenar binarios, tokens o bases reales en Git.

**Pruebas.** Mantener la suite actual como regresión. Añadir tests sobre comportamiento y fallos relevantes: permisos, concurrencia, rollback, respuesta perdida, expiración, desconexión y upgrade. Para cambios de código: `pnpm check` y `pnpm build`; E2E cuando cambien flujos, transporte o despliegue. Ejecutar CI Linux/Windows antes de dar una entrega por integrada. Cambios sólo de documentación requieren revisión de contenido, enlaces y diff.

**Dependencias.** Usar las herramientas actuales mientras cubran el problema. Antes de añadir un paquete/servicio, registrar necesidad, alternativas, coste de mantenimiento y efectos de seguridad en bitácora. Verificar documentación oficial y versiones durante su selección; este roadmap no fija proveedores futuros.

**Entrega.** Una rama breve por incremento; PR con problema, comportamiento, validación, migración y rollback si aplica. Eliminar ramas sólo después de comprobar integración. Cada avance actualiza bitácora y el estado de las tareas sin reescribir la evidencia histórica.

## 14. Hitos y condiciones de salida

| Hito | Incluye | Condición para anunciarlo |
|---|---|---|
| A — Piloto aceptado | Fase 7 | Sesión real documentada; sin incidentes críticos abiertos |
| B — Base consolidada | Fases 8–9 | Repositorios separados, recuperación especificada e instalación limpia reproducible |
| C — Uso habitual | Fases 10–11 | Historial/locks utilizables, restauración ensayada y operación observada con el equipo |
| D — Trabajo trazable | Fases 12–13 | Tareas y entregas revisadas con referencias Git, sin automatización de escritura |
| E — Contexto compartido sostenible | Fase 14 | Contexto vigente, visibilidad preservada y avisos controlables |

No se declara cerrado todo el plan original sólo por publicar una release: el cierre debe indicar por separado aceptación funcional, deuda estructural y operación. Los hitos D/E requieren validar que el equipo necesita esas capacidades.

## 15. Primer lote ejecutable

| Orden | Tarea | Responsable por función | Dependencia |
|---|---|---|---|
| 1 | Crear protocolo y plantilla de evidencia de 7.1–7.4 | Desarrollo | Ninguna |
| 2 | Elegir clientes y completar sesión real | Anfitrión y amigo | Plantilla y disponibilidad humana |
| 3 | Corregir defectos reproducidos con regresiones | Desarrollo | Resultados del piloto |
| 4 | Especificar repositorios/unidad de trabajo y migrar un servicio pequeño | Desarrollo | Lectura de transacciones actuales |
| 5 | Añadir pruebas de retención y sesiones simultáneas; resolver contrato | Desarrollo + responsable del proyecto | 8.4/8.5; no depende de cliente específico |
| 6 | Entregar diagnóstico local y guías de los clientes probados | Desarrollo | 7.1; contrato de acceso actual |

Este lote produce evidencia, reduce deuda y facilita incorporación sin añadir tareas automáticas, infraestructura distribuida ni servicios de pago.

## 16. Decisiones abiertas y seguimiento

| Pregunta | Momento límite | Cómo se resuelve |
|---|---|---|
| ¿Qué dos productos de agente usa el equipo? | Antes de aceptación 7 | Elección de los participantes; registrar versiones |
| ¿Cuántas personas/proyectos y cuántas horas de uso? | Antes de perfilar carga y operación 11 | Medición del piloto y necesidad declarada |
| ¿Se necesita URL estable y disponibilidad con el PC apagado? | Antes de 11.1 | Elegir instalación permanente según necesidad y presupuesto |
| ¿Qué historial se conserva y qué se puede borrar/exportar? | Antes de 8.4 y 11.6 | Política explícita de retención, permisos y backups |
| ¿Un agente lógico puede tener varias instancias simultáneas? | Antes de 8.5 | Prueba reproducible y definición de ownership/checkpoints |
| ¿Cómo se distribuye el adaptador y bajo qué licencia? | Antes de publicación externa de 9.3 | Decisión del responsable y revisión de dependencias |
| ¿El equipo necesita tareas, Git y avisos integrados? | Antes de 12–14 | Revisar fricción real y aceptar alcance por incremento |

Al iniciar cada tarea registrar: ID, estado (`propuesta`, `lista`, `en curso`, `bloqueada`, `verificada`), responsable, dependencia, PR, evidencia y siguiente paso. Todas las tareas de este documento comienzan como propuestas pendientes; las implementadas previamente están sólo en la tabla de punto de partida.

Revisar el roadmap al cerrar cada hito. Reordenar lo propuesto según evidencia y registrar el motivo; ampliar alcance o cambiar una ADR requiere decisión explícita. Evitar acumular nuevas funciones mientras haya fallos de aislamiento, pérdida de datos o recuperación sin resolver.

## 17. Ejecución iniciada (2026-10-08)

El usuario autoriza implementar la evolución. El alcance y las condiciones anteriores se mantienen; esta tabla distingue avances del cierre de una fase completa. Cambios locales, todavía sin CI remoto de este incremento.

| Tarea | Estado | Evidencia / pendiente |
|---|---|---|
| 7.1–7.4: preparar protocolo y registro | Verificada como preparación documental | [Piloto](acceptance/pilot.md), [clientes](compatibility/clients.md); ejecución humana pendiente |
| 7.1–7.5: ejecutar aceptación | Pendiente de participantes/productos | No sustituir por harness stdio; elección de clientes solicitada |
| 8.1: repositorios/unidad de trabajo | Verificada localmente | Todos los servicios de aplicación usan puertos y nueve adaptadores; autorización también se consume por un puerto. SQL de autenticación/rutas/CLI sigue en sus adaptadores |
| 8.2: frontera transaccional | Verificada localmente para mensajes/estado/locks | Contratos SQLite prueban rollback de entidad/evento/auditoría/idempotencia y deduplicación, incluyendo renew/release |
| 8.3: extraer rutas y herramientas | Verificada localmente | Rutas por proyectos/sesiones, mensajes/estado, locks, inbox y WS; catálogo y herramientas MCP por consumo/comandos. Composición/lifecycle conservados |
| 8.4: historial vencido/recuperación | Verificada localmente | ADR-020, [contrato](RECOVERY.md), cinco regresiones y E2E UI/stdio; CI remoto pendiente |
| 8.5: instancias concurrentes | Verificada localmente | [ADR-021](SESSIONS.md): una instancia vigente, retry por UUID, generación nueva/checkpoint conservado y fencing; HTTP/WS/stdio/UI y upgrade/reopen comprobados |
| 8.6: inventario/reconciliación | Documentada; validación exhaustiva pendiente | [Inventario](API_CONTRACT.md) contrastado con rutas/catálogo/schemas; arquitectura refleja estado real y límites de validación |
| 9.1: doctor | Verificada localmente | [Diagnóstico](DOCTOR.md), capacidades, CLI/GET reales, errores, no mutación y redacción |
| 9.2: configuración | Preparación genérica verificada | [Plantilla](MCP_SETUP.md) con rutas absolutas/token de ejemplo y creación exclusiva; guías/aceptación de productos específicos pendientes |
| 10.1: historial paginado | Verificada localmente | [Contrato](MESSAGE_HISTORY.md), cursor keyset separado, privacidad previa a paginación, UI infinita, 133 pruebas y 10 E2E; CI remoto pendiente |
| 10.2: búsqueda y filtros | Verificada localmente | Filtros literales/autorizados antes de paginar, cursor ligado a huella, controles web, 134 pruebas y 10 E2E; CI remoto pendiente |
| 10.5: renovación explícita | Verificada y publicada | `3c0ba1b`: MCP/UI, TTL, cuenta regresiva, permisos/retry estable; 135 pruebas y 10 E2E; [CI Windows/Ubuntu PASS](https://github.com/Jacoolzs/Agents-Hub/actions/runs/37832515313) |
| 10.3: respuestas y destinatarios | Verificada y publicada | f5cff7d; [contrato](MESSAGE_REPLIES.md), migración 7, thread autorizado/privacidad por padre, UI/stdio, 141 pruebas/12 E2E y [CI Windows/Ubuntu PASS](https://github.com/Jacoolzs/Agents-Hub/actions/runs/37840440650) |
| 10.4: presencia comprensible | Verificada y publicada | 1bb95f6; [presencia](PRESENCE.md), contacto/reporte separados, desconectados y lecturas anteriores explícitas; 142 pruebas/13 E2E y [CI Windows/Ubuntu PASS](https://github.com/Jacoolzs/Agents-Hub/actions/runs/37862390949) |
| 9.3–14 (salvo incrementos indicados) | Pendientes | Conservar dependencias/aceptación del plan; no declarar entregadas |
| 15 | Investigaciones condicionadas | Sin nuevos servicios, Docker ni orquestación |

El usuario aceptó/publicó la renovación UI/UX (a99b634, CI aprobado) y autorizó 10.3: respuestas y selector de destinatarios implementados con migración 7, privacidad por padre y consulta de hilo sin ACK. Check de 141 pruebas, build y 12 E2E pasan; 10.3 publicado en f5cff7d con CI Windows/Ubuntu aprobado. 10.4 publicado en 1bb95f6 y aprobado en CI Windows/Ubuntu (142 pruebas/13 E2E). 10.6 pendiente. La validación exhaustiva de salidas/payloads sigue pendiente (8.6).

Verificación actual del código 1bb95f6: check con 142 pruebas, build y 13 E2E PASS en CI Windows/Ubuntu (run 37862390949). 8.1–9.2/10.1/10.2/10.3/10.4/10.5 y renovación UI/UX publicados en `feat/phase-10-message-history`. El fallo CI anterior de backup Windows quedó corregido con ajuste acotado de timeout. Fases 7–15 en conjunto siguen pendientes; conservar aceptación humana y demás condiciones.
