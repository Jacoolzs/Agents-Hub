# Reglas de trabajo para Agents-Hub

## Contexto obligatorio

Antes de analizar, planear, decidir arquitectura o modificar este repositorio, lee completa `BITACORA.md`. La bitácora es la memoria viva y la fuente de verdad del proyecto.

Si la bitácora no existe, no está disponible o contradice otra documentación, detén las decisiones de arquitectura y deja constancia del bloqueo antes de continuar.

## Regla de registro continuo

Después de cada avance relevante, decisión, cambio de alcance, experimento, bloqueo, solución o descubrimiento, actualiza `BITACORA.md` en la misma sesión. Registra qué cambió, por qué, sus consecuencias y el siguiente paso. No marques como decidido algo que todavía esté en discusión.

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
