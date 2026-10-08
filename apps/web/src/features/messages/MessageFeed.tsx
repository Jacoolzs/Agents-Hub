import type { Message, MessageHistoryFilters, MessagePriority } from "@agents-hub/shared";
import { useInfiniteQuery, useMutation } from "@tanstack/react-query";
import type React from "react";
import { useMemo, useState } from "react";
import { Icon } from "../../components/Icon.js";
import { EmptyState, ErrorBanner } from "../../components/States.js";
import { useHub } from "../../context/HubContext.js";
import { fetchMessageHistory, sendMessage } from "../../lib/api.js";

function matchesHistoryFilters(message: Message, filters: MessageHistoryFilters): boolean {
  return (
    (!filters.text || message.body.toLowerCase().includes(filters.text.toLowerCase())) &&
    (!filters.channel || message.channel === filters.channel) &&
    (!filters.sender || message.sender_id === filters.sender) &&
    (!filters.recipient || message.recipient_agent_ids.includes(filters.recipient)) &&
    (!filters.from || message.created_at >= filters.from) &&
    (!filters.to || message.created_at < filters.to)
  );
}

export function MessageFeed({ active = true }: { active?: boolean }) {
  const { auth, events, syncError, realtimeManager } = useHub();

  const [filterDraft, setFilterDraft] = useState({
    text: "",
    channel: "",
    sender: "",
    recipient: "",
    from: "",
    to: "",
  });
  const [historyFilters, setHistoryFilters] = useState<MessageHistoryFilters>({});
  const [newChannel, setNewChannel] = useState("general");
  const [newPriority, setNewPriority] = useState<MessagePriority>("normal");
  const [newRecipients, setNewRecipients] = useState("");
  const [newBody, setNewBody] = useState("");
  const [sent, setSent] = useState(false);
  const [showAdvancedFilters, setShowAdvancedFilters] = useState(false);
  const [formError, setFormError] = useState<unknown | null>(null);

  const historyQuery = useInfiniteQuery({
    queryKey: ["message-history", auth?.projectId, auth?.sessionId, historyFilters],
    enabled: auth !== null && active,
    initialPageParam: null as string | null,
    queryFn: ({ pageParam }) => {
      if (!auth) throw new Error("No auth");
      return fetchMessageHistory(auth.baseUrl, auth.token, auth.projectId, auth.sessionId, {
        ...historyFilters,
        ...(pageParam ? { before: pageParam } : {}),
      });
    },
    getNextPageParam: (lastPage) =>
      lastPage.has_more ? (lastPage.next_cursor ?? undefined) : undefined,
  });

  const sendMutation = useMutation({
    mutationFn: async () => {
      if (!auth) throw new Error("No auth");
      const recipients = newRecipients
        .split(",")
        .map((r) => r.trim())
        .filter(Boolean);

      return sendMessage(auth.baseUrl, auth.token, auth.projectId, auth.sessionId, {
        channel: newChannel.trim() || "general",
        body: newBody.trim(),
        priority: newPriority,
        recipient_agent_ids: recipients.length > 0 ? recipients : undefined,
      });
    },
    onSuccess: () => {
      setNewBody("");
      setSent(true);
      setFormError(null);
      void realtimeManager?.recoverMissedEvents();
    },
    onError: (err) => {
      setFormError(err);
    },
  });

  const handleSend = (e: React.FormEvent) => {
    e.preventDefault();
    if (!newBody.trim() || sendMutation.isPending) return;
    setSent(false);
    sendMutation.mutate();
  };

  const applyFilters = (event: React.FormEvent) => {
    event.preventDefault();
    if (
      filterDraft.from &&
      filterDraft.to &&
      new Date(filterDraft.from) >= new Date(filterDraft.to)
    ) {
      setFormError(new Error("La fecha inicial debe ser anterior a la fecha final."));
      return;
    }
    setFormError(null);
    const clean = (value: string) => value.trim() || undefined;
    setHistoryFilters({
      ...(clean(filterDraft.text) ? { text: clean(filterDraft.text) } : {}),
      ...(clean(filterDraft.channel) ? { channel: clean(filterDraft.channel) } : {}),
      ...(clean(filterDraft.sender) ? { sender: clean(filterDraft.sender) } : {}),
      ...(clean(filterDraft.recipient) ? { recipient: clean(filterDraft.recipient) } : {}),
      ...(filterDraft.from ? { from: new Date(filterDraft.from).toISOString() } : {}),
      ...(filterDraft.to ? { to: new Date(filterDraft.to).toISOString() } : {}),
    });
  };

  const clearFilters = () => {
    setFilterDraft({ text: "", channel: "", sender: "", recipient: "", from: "", to: "" });
    setHistoryFilters({});
  };

  // Merge independent history pages with live inbox/WS events by domain identity.
  const messages: Message[] = useMemo(() => {
    const byId = new Map<string, Message>();
    for (const page of historyQuery.data?.pages ?? []) {
      for (const message of page.messages) byId.set(message.message_id, message);
    }
    for (const event of events) {
      if (event.type === "message.created" && event.payload) {
        const payload = event.payload as Record<string, unknown>;
        const message = {
          ...(payload as unknown as Message),
          created_at: ((payload.created_at as string | undefined) ?? event.occurred_at) as string,
        };
        if (matchesHistoryFilters(message, historyFilters) && !byId.has(message.message_id))
          byId.set(message.message_id, message);
      }
    }
    // Newest at bottom
    return Array.from(byId.values()).sort(
      (a, b) =>
        a.created_at.localeCompare(b.created_at) || a.message_id.localeCompare(b.message_id),
    );
  }, [events, historyFilters, historyQuery.data]);

  const filterLabels = {
    text: "Buscar texto",
    channel: "Canal",
    sender: "Remitente",
    recipient: "Destinatario",
  };
  const priorityLabels = { normal: "Normal", low: "Baja", high: "Alta", urgent: "Urgente" };

  return (
    <div className="conversation">
      <div className="history-toolbar">
        <form
          onSubmit={applyFilters}
          className="grid grid-cols-2 xl:grid-cols-4 gap-4"
          aria-label="Buscar en el historial"
        >
          {(["text", "channel", "sender", "recipient"] as const).map((field) => (
            <div
              key={field}
              hidden={!showAdvancedFilters && (field === "sender" || field === "recipient")}
            >
              <label htmlFor={`history-${field}`}>{filterLabels[field]}</label>
              <input
                id={`history-${field}`}
                aria-label={`Filtro ${field === "text" ? "texto" : field === "channel" ? "canal" : field === "sender" ? "remitente" : "destinatario"}`}
                value={filterDraft[field]}
                onChange={(event) =>
                  setFilterDraft((current) => ({ ...current, [field]: event.target.value }))
                }
                placeholder={field === "text" ? "Una palabra o un acuerdo…" : "Todos"}
                maxLength={field === "text" ? 200 : 100}
                className="w-full px-3 py-2 bg-slate-50 border border-slate-300 rounded-lg text-sm text-slate-800"
              />
            </div>
          ))}
          <div hidden={!showAdvancedFilters}>
            <label htmlFor="history-from">Desde</label>
            <input
              id="history-from"
              type="datetime-local"
              aria-label="Filtro desde"
              value={filterDraft.from}
              onChange={(event) =>
                setFilterDraft((current) => ({ ...current, from: event.target.value }))
              }
              className="w-full px-3 py-2 bg-slate-50 border border-slate-300 rounded-lg text-sm text-slate-800"
            />
          </div>
          <div hidden={!showAdvancedFilters}>
            <label htmlFor="history-to">Hasta</label>
            <input
              id="history-to"
              type="datetime-local"
              aria-label="Filtro hasta"
              value={filterDraft.to}
              onChange={(event) =>
                setFilterDraft((current) => ({ ...current, to: event.target.value }))
              }
              className="w-full px-3 py-2 bg-slate-50 border border-slate-300 rounded-lg text-sm text-slate-800"
            />
          </div>
          <div className="col-span-2 flex items-end justify-between flex-wrap gap-3">
            <div className="flex flex-wrap gap-2">
              <button
                type="submit"
                className="px-4 py-2 rounded-lg bg-blue-600 hover:bg-blue-700 text-sm font-medium text-white inline-flex items-center gap-2"
              >
                <Icon name="search" />
                Aplicar filtros
              </button>
              <button
                type="button"
                onClick={clearFilters}
                className="px-3 py-2 rounded-lg border border-slate-300 text-sm text-slate-700 hover:bg-slate-50"
              >
                Limpiar
              </button>
              <button
                type="button"
                aria-expanded={showAdvancedFilters}
                onClick={() => setShowAdvancedFilters((show) => !show)}
                className="px-3 py-2 text-sm text-slate-700 rounded-lg hover:bg-slate-50"
              >
                {showAdvancedFilters ? "Menos filtros" : "Más filtros"}
              </button>
            </div>
            <span className="text-xs text-slate-600">
              {messages.length} {messages.length === 1 ? "mensaje cargado" : "mensajes cargados"}
            </span>
          </div>
        </form>
      </div>

      <ErrorBanner error={syncError} />
      <ErrorBanner error={historyQuery.error} />
      <div
        className="message-list"
        aria-label="Historial de mensajes"
        aria-busy={historyQuery.isFetching}
      >
        {historyQuery.hasNextPage && (
          <div className="flex justify-center py-4">
            <button
              type="button"
              onClick={() => void historyQuery.fetchNextPage()}
              disabled={historyQuery.isFetchingNextPage}
              className="px-4 py-2 rounded-lg border border-slate-300 bg-white text-sm font-medium text-slate-700 hover:bg-slate-50 disabled:opacity-50"
            >
              {historyQuery.isFetchingNextPage ? "Cargando…" : "Cargar mensajes anteriores"}
            </button>
          </div>
        )}
        {messages.length === 0 ? (
          <div className="py-6">
            <EmptyState
              title={
                historyQuery.isPending
                  ? "Cargando historial"
                  : Object.keys(historyFilters).length
                    ? "No hay coincidencias"
                    : "La conversación empieza aquí"
              }
              description={
                historyQuery.isPending
                  ? "Recuperando los mensajes disponibles del proyecto."
                  : Object.keys(historyFilters).length
                    ? "Prueba otra búsqueda o limpia los filtros para ver los mensajes disponibles."
                    : "Comparte una pregunta, un acuerdo o el contexto que necesita tu equipo."
              }
              action={
                Object.keys(historyFilters).length ? (
                  <button type="button" onClick={clearFilters} className="text-blue-700 px-4">
                    Limpiar filtros
                  </button>
                ) : undefined
              }
            />
          </div>
        ) : (
          messages.map((msg) => (
            <article
              key={msg.message_id}
              className="message-row"
              aria-label={`Mensaje de ${msg.sender_id}`}
            >
              <div className="message-meta">
                <span className="message-author font-mono">{msg.sender_id}</span>
                {msg.sender_id === auth?.agentId && (
                  <span className="text-xs text-slate-600">Tú</span>
                )}
                <span className="text-xs text-blue-700 font-mono">#{msg.channel}</span>
                {msg.priority !== "normal" && (
                  <span
                    className={`px-2 py-1 rounded text-xs font-medium ${msg.priority === "urgent" ? "bg-rose-50 text-rose-700" : msg.priority === "high" ? "bg-amber-50 text-amber-800" : "bg-slate-100 text-slate-600"}`}
                  >
                    {priorityLabels[msg.priority]}
                  </span>
                )}
                <time dateTime={msg.created_at}>
                  {new Date(msg.created_at).toLocaleString("es", {
                    day: "numeric",
                    month: "short",
                    hour: "2-digit",
                    minute: "2-digit",
                  })}
                </time>
              </div>
              <p className="message-body">{msg.body}</p>
              {msg.recipient_agent_ids.length > 0 && (
                <p className="message-privacy">
                  Privado para: {msg.recipient_agent_ids.join(", ")}
                </p>
              )}
            </article>
          ))
        )}
      </div>

      <ErrorBanner error={formError} onDismiss={() => setFormError(null)} />
      <form
        onSubmit={handleSend}
        className="message-composer"
        aria-label="Enviar un mensaje"
        aria-busy={sendMutation.isPending}
      >
        <div className="composer-heading">
          <h2>Nuevo mensaje</h2>
          <span>Comparte contexto útil para el equipo</span>
        </div>
        <div className="composer-fields">
          <div>
            <label htmlFor="message-channel">Canal</label>
            <input
              id="message-channel"
              type="text"
              value={newChannel}
              onChange={(e) => setNewChannel(e.target.value)}
              placeholder="general"
              className="w-full px-3 py-2 bg-slate-50 border border-slate-300 rounded-lg text-sm text-slate-800"
            />
          </div>
          <div>
            <label htmlFor="message-priority">Prioridad</label>
            <select
              id="message-priority"
              value={newPriority}
              onChange={(e) => setNewPriority(e.target.value as MessagePriority)}
              className="w-full px-3 py-2 bg-slate-50 border border-slate-300 rounded-lg text-sm text-slate-800"
            >
              <option value="normal">Normal</option>
              <option value="low">Baja</option>
              <option value="high">Alta</option>
              <option value="urgent">Urgente</option>
            </select>
          </div>
          <div>
            <label htmlFor="message-recipients">
              Destinatarios <span className="font-normal">(opcional)</span>
            </label>
            <input
              id="message-recipients"
              type="text"
              value={newRecipients}
              onChange={(e) => setNewRecipients(e.target.value)}
              placeholder="agente1, agente2"
              aria-describedby="message-audience"
              className="w-full px-3 py-2 bg-slate-50 border border-slate-300 rounded-lg text-sm text-slate-800"
            />
          </div>
        </div>
        <label htmlFor="message-body" className="sr-only">
          Mensaje
        </label>
        <textarea
          id="message-body"
          value={newBody}
          onChange={(e) => {
            setNewBody(e.target.value);
            setSent(false);
          }}
          placeholder="Escribe un mensaje para coordinar con el equipo..."
          rows={3}
          className="w-full px-3 py-3 bg-white border border-slate-300 rounded-lg text-sm text-slate-900"
          onKeyDown={(e) => {
            if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) {
              e.preventDefault();
              handleSend(e);
            }
          }}
        />
        <div className="compose-footer">
          <div>
            <p id="message-audience">
              {newRecipients.trim()
                ? "Mensaje dirigido a los destinatarios indicados."
                : "Visible para todo el equipo."}
            </p>
            <p>Ctrl / ⌘ + Enter para enviar</p>
            <output className="text-xs text-emerald-700">{sent ? "Mensaje enviado." : ""}</output>
          </div>
          <button
            type="submit"
            disabled={sendMutation.isPending || !newBody.trim()}
            className="px-5 py-2 bg-blue-600 hover:bg-blue-700 disabled:opacity-50 text-white font-medium rounded-lg text-sm inline-flex items-center gap-2"
          >
            <Icon name="send" />
            {sendMutation.isPending ? "Enviando..." : "Enviar"}
          </button>
        </div>
      </form>
    </div>
  );
}
