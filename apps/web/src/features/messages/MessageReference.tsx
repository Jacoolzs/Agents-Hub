import type { Message } from "@agents-hub/shared";
import { useQuery } from "@tanstack/react-query";
import { useState } from "react";
import { useHub } from "../../context/HubContext.js";
import { fetchMessageById } from "../../lib/api.js";

export function MessageReference({
  messageId,
  loaded,
  active,
}: { messageId: string; loaded?: Message | undefined; active: boolean }) {
  const { auth } = useHub();
  const [open, setOpen] = useState(false);
  const query = useQuery({
    queryKey: ["message-reference", auth?.projectId, auth?.sessionId, messageId],
    enabled: Boolean(auth) && active && open && !loaded,
    retry: false,
    queryFn: () => {
      if (!auth) throw new Error("No auth");
      return fetchMessageById(auth.baseUrl, auth.token, auth.projectId, auth.sessionId, messageId);
    },
  });
  const original = loaded ?? query.data;
  return (
    <details className="message-reference" onToggle={(event) => setOpen(event.currentTarget.open)}>
      <summary>En respuesta a {original?.sender_id ?? "un mensaje anterior"}</summary>
      {original ? (
        <blockquote>
          <strong>{original.sender_id}</strong>
          <p>{original.body}</p>
        </blockquote>
      ) : (
        <p>
          {query.isError
            ? "El original ya no está disponible o no tienes acceso."
            : "Cargando el mensaje original…"}
        </p>
      )}
    </details>
  );
}
