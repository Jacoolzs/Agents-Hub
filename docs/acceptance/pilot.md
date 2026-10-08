# Protocolo de aceptación humana — fase 7

Estado: preparado; ejecución humana pendiente. Responsable: anfitrión y amigo. Usar dos personas, redes distintas y productos de agente diferentes. Si falta alguna condición, declarar resultado parcial.

## Preparación

Registrar fecha, commit del Hub/adaptador, productos/versiones/SO en [clientes](../compatibility/clients.md). Arrancar desde clones propios siguiendo [README](../../README.md) y [operación](../OPERATIONS.md). Usar un proyecto de prueba, tokens personales e invitación. No exponer la base real ni copiar secretos en evidencias. Cada instancia debe usar nombre distinto.

| Paso | Acción y resultado esperado | Evidencia a registrar |
|---|---|---|
| 1 | Anfitrión inicia Hub/túnel; amigo instala y compila adaptador sin editar código/SQLite | Tiempo, errores y ayuda necesaria |
| 2 | Identidades propias; anfitrión invita; amigo acepta y ambos conectan | Roles y nombres, sin tokens ni URL con tickets |
| 3 | Dividir una tarea pequeña: uno acuerda contrato, otro implementa consumidor | Objetivo y criterio de aceptación compartidos |
| 4 | Publicar estado, reclamar ruta; segundo agente intenta ruta hija | Conflicto y propietario/TTL visibles; ninguna edición concurrente intencional |
| 5 | Enviar mensaje dirigido, consultar inbox, responder y confirmar después de consumir | Mensaje recibido una vez y checkpoint; necesidad de intervención humana |
| 6 | Completar trabajo, publicar resumen/pruebas, liberar lock | Resultado revisado por las personas |
| 7 | Detener un adaptador, enviar mensaje, reiniciarlo con el mismo nombre y leer | Mensaje offline recuperado; páginas confirmadas no reejecutadas |
| 8 | Revocar token de prueba; comprobar HTTP/WS y reiniciar MCP | Acceso rechazado; plazos de revocación conforme a operación |
| 9 | Probar token vencido, red interrumpida y lock vencido | Error accionable; recuperar acceso con credencial nueva y reclamar de nuevo |
| 10 | Evaluar comodidad, interferencias y mensajes perdidos | Incidencias reproducibles y clasificación |

No borrar datos reales para provocar retención. El caso de historial vencido tiene regresiones automáticas y procedimiento en [RECOVERY](../RECOVERY.md). Una reproducción humana de ese caso debe usar una instalación desechable.

## Registro del resultado

Copiar este registro por sesión y completar hechos observados; no marcar casillas por inferencia.

```text
Fecha / commit / participantes:
Productos y versiones / sistemas / redes:
Tiempo hasta primera conexión / ayuda requerida:
Tarea / criterio de aceptación / resultado revisado:
Mensajes dirigidos y ACK:
Conflicto / TTL / liberación:
Desconexión y replay:
Revocación / expiración:
Veces que se pidió manualmente revisar inbox:
Resultado: pendiente | parcial | aceptado | rechazado
Evidencia sanitizada:
Incidencias y siguiente paso:
```

## Incidencias y salida (7.5)

| ID | Reproducción | Tipo/severidad | Responsable | Criterio de salida | Estado/evidencia |
|---|---|---|---|---|---|
| PILOT-001 | Dos procesos, mismo usuario/nombre; cerrar uno desconectaba al otro | Error de identidad (8.5) | Desarrollo | Rechazar colisión y aislar generación/checkpoint | Corregido según [ADR-021](../SESSIONS.md); regresiones HTTP/WS y stdio, aceptación humana pendiente |

Separar errores funcionales (datos/permisos/recuperación) de fricción (configuración, comprensión, pasos manuales). Un incidente de pérdida/aislamiento se atiende antes que capacidades nuevas. Salida: dos personas/productos/redes completan pasos y revisan resultado, sin incidentes críticos abiertos. Una suite verde no cierra la fase 7.
