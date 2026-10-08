# Historial de mensajes

El historial retenido se consulta con `GET /v1/projects/:projectId/messages/history`. Es una lectura independiente del inbox: no confirma eventos, no cambia `last_cursor` y no vuelve a ejecutar efectos.

## Contrato

La petición requiere `Authorization: Bearer`, scope `messages:read`, pertenencia al proyecto y una `session_id` propia vigente.

Parámetros de query:

- `session_id`: obligatorio; determina el agente cuya visibilidad se aplica.
- `before`: cursor histórico opaco opcional.
- `limit`: entero entre 1 y 100; predeterminado 50.
- `text`: subcadena literal opcional, 1–200 caracteres; comparación sin distinguir mayúsculas ASCII.
- `channel`, `sender`, `recipient`: coincidencia exacta opcional, 1–100 caracteres. `recipient` sólo coincide con destinatarios explícitos, no con broadcast.
- `from`: instante UTC inclusivo opcional.
- `to`: instante UTC exclusivo opcional y posterior a `from` cuando ambos existen.
- `thread`: UUID opcional del mensaje raíz; devuelve raíz/respuestas visibles. No usa correlation_id legacy como autorización o filtro. Ver [respuestas](MESSAGE_REPLIES.md).

La respuesta `data` sigue `MessageHistoryPageSchema`:

```json
{
  "messages": [],
  "next_cursor": null,
  "has_more": false
}
```

Los mensajes se devuelven del más reciente al más antiguo. Si `has_more` es verdadero, se envía `next_cursor` como `before` para cargar la página siguiente.

## Orden, privacidad y concurrencia

El cursor representa la clave `(created_at, message_id)` y es distinto del cursor secuencial del inbox. El orden usa ambos campos en sentido descendente, por lo que dos mensajes con la misma fecha no se duplican ni se omiten entre páginas. Cuando hay filtros, el cursor incorpora una huella FNV-1a de 64 bits de sus valores normalizados; no incluye texto en claro. Reutilizarlo con otra combinación devuelve `CURSOR_INVALID`. Los cursores 10.1 sin filtros siguen siendo válidos para consultas sin filtros.

La consulta aplica antes de `LIMIT` estas reglas: broadcast, mensaje enviado por el agente de la sesión o mensaje que lo incluye como destinatario. El rol owner no concede acceso a privados ajenos. Proyecto, filtros y posición del cursor también se aplican antes de paginar; `has_more` no cuenta mensajes ocultos ni coincidencias fuera del filtro. Una búsqueda sin resultados tiene la misma forma tanto si no existen coincidencias como si sólo existen mensajes privados ajenos.

La paginación keyset evita el desplazamiento propio de `OFFSET` cuando llegan mensajes. Los empates usan `message_id` y el cliente combina páginas y eventos vivos por esa misma identidad; una nueva consulta inicial permite ver la cabeza actual sin duplicar elementos ya recibidos.

## Persistencia y compatibilidad

La migración 6 añade `idx_messages_history` sobre `(project_id, created_at DESC, message_id DESC)`. Es aditiva y se aplica al abrir bases anteriores. Los clientes previos conservan inbox, ACK y escritura sin cambios; `/v1/capabilities` añade `message_history` dentro de la revisión de contrato v1.

Un `CURSOR_EXPIRED` del inbox no bloquea esta lectura: los mensajes aún retenidos pueden consultarse sin aceptar el gap. El cliente debe seguir mostrando que el consumo está detenido; sólo el flujo de recuperación explícita puede adelantar su checkpoint.
