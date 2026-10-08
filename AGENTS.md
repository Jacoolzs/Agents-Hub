# Reglas de trabajo para Agents-Hub

## Contexto obligatorio

Antes de analizar, planear, decidir arquitectura o modificar este repositorio, lee completa `BITACORA.md`. La bitácora es la memoria viva y la fuente de verdad del proyecto.

Al abrir el proyecto, iniciar un chat nuevo o retomar una tarea, lee estas reglas y la bitácora completa, localiza el [relevo vigente](BITACORA.md#relevo-vigente-para-el-siguiente-chat) y contrástalo con el estado actual del repositorio antes de actuar. Comprueba rama, commit, cambios pendientes y archivos mencionados; no supongas que el trabajo local está publicado ni que una verificación anterior sigue vigente.

Si la bitácora no existe, no está disponible o contradice otra documentación, detén las decisiones de arquitectura y deja constancia del bloqueo antes de continuar.

## Regla de registro continuo

Después de cada avance relevante, decisión, cambio de alcance, experimento, bloqueo, solución o descubrimiento, actualiza `BITACORA.md` en la misma sesión. Registra qué cambió, por qué, sus consecuencias y el siguiente paso. No marques como decidido algo que todavía esté en discusión.

## Relevo obligatorio al terminar cada tarea

Antes de dar por terminada cualquier tarea, incluso si sólo cambia documentación, actualiza la sección `Relevo vigente para el siguiente chat` de `BITACORA.md` y añade una entrada cronológica del avance. Haz lo mismo si queda trabajo parcial al cerrar el chat, llegar a un límite o encontrar un bloqueo. La siguiente sesión debe poder continuar sin depender del historial de conversación.

El relevo debe incluir:

- Objetivo completo y estado: qué está terminado, qué quedó parcial y qué sigue pendiente.
- Rama/commit de referencia, cambios locales y situación de commit, publicación y CI.
- Decisiones vigentes, restricciones, riesgos y preguntas que todavía necesitan respuesta.
- Próxima tarea concreta: por dónde empezar, en qué orden, cómo implementarla y su criterio de aceptación.
- Archivos, contratos, herramientas y dependencias existentes que se deben utilizar; marcar propuestas que aún no están decididas.
- Comandos de verificación, resultados realmente observados y comprobaciones que faltan, distinguiendo evidencia anterior de pruebas de esta tarea.
- Bloqueos, trabajo o procesos en curso si existen y cómo comprobar su estado; no inventar procesos activos ni registrar secretos o razonamiento privado.

Mantén un único relevo vigente actualizado y conserva las entradas cronológicas anteriores como historia. Si cambias el siguiente paso, registra el motivo. No cierres una tarea sin dejar este punto de continuación; tampoco declares terminado el objetivo global sólo por terminar un incremento.

## Alcance vigente

- El MVP prioriza comunicación entre agentes, estado compartido y locks básicos de archivos/módulos.
- La orquestación activa compleja se mantiene fuera del MVP hasta que exista una decisión explícita.
- Docker/sandboxing queda diferido a una fase posterior; no lo introduzcas como requisito del MVP sin una nueva decisión registrada.
- El reto de cómo reciben mensajes los agentes cuando están inactivos sigue abierto en `ADR-006`; cualquier implementación debe reconocer esa limitación.

## Forma de trabajo

- Para planear y decidir, usa primero la bitácora, las ADR y la evidencia del repositorio.
- Separa claramente hechos, decisiones aceptadas, hipótesis y preguntas abiertas.
- Prefiere cambios pequeños y verificables; no amplíes el alcance por entusiasmo o supuestos no validados.
- Comparte contexto estructurado y útil entre agentes; no dependas de exponer razonamiento interno crudo.
- Antes de añadir una dependencia, servicio o componente nuevo, explica su necesidad y registra la decisión en la bitácora.
