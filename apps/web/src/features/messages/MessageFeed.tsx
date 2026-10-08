import type { Message, MessageHistoryFilters, MessagePriority } from "@agents-hub/shared";
import { useInfiniteQuery, useMutation } from "@tanstack/react-query";
import type React from "react";
import { useMemo, useState } from "react";
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

export function MessageFeed() {
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
  const [formError, setFormError] = useState<unknown | null>(null);

  const historyQuery = useInfiniteQuery({
    queryKey: ["message-history", auth?.projectId, auth?.sessionId, historyFilters],
    enabled: auth !== null,
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
      setFormError(null);
      void realtimeManager?.recoverMissedEvents();
    },
    onError: (err) => {
      setFormError(err);
    },
  });

  const handleSend = (e: React.FormEvent) => {
    e.preventDefault();
    if (!newBody.trim()) return;
    sendMutation.mutate();
  };

  const applyFilters = (event: React.FormEvent) => {
    event.preventDefault();
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

  const renderPriorityBadge = (priority?: MessagePriority) => {
    switch (priority) {
      case "urgent":
        return (
          <span className="px-1.5 py-0.5 rounded text-[10px] font-bold bg-rose-900/60 text-rose-300 border border-rose-700 uppercase">
            Urgente
          </span>
        );
      case "high":
        return (
          <span className="px-1.5 py-0.5 rounded text-[10px] font-medium bg-amber-900/60 text-amber-300 border border-amber-700 uppercase">
            Alta
          </span>
        );
      case "low":
        return (
          <span className="px-1.5 py-0.5 rounded text-[10px] font-medium bg-slate-800 text-slate-400">
            Baja
          </span>
        );
      default:
        return (
          <span className="px-1.5 py-0.5 rounded text-[10px] font-medium bg-indigo-900/40 text-indigo-300 border border-indigo-800/50">
            Normal
          </span>
        );
    }
  };

  return (
    <div className="flex flex-col h-[calc(100vh-140px)] space-y-4">
      {/* Authorized server-side history filters */}
      <div className="pb-3 border-b border-slate-800 space-y-2">
        <form onSubmit={applyFilters} className="grid grid-cols-2 lg:grid-cols-6 gap-2">
          {(["text", "channel", "sender", "recipient"] as const).map((field) => (
            <input
              key={field}
              aria-label={`Filtro ${
                field === "text"
                  ? "texto"
                  : field === "channel"
                    ? "canal"
                    : field === "sender"
                      ? "remitente"
                      : "destinatario"
              }`}
              value={filterDraft[field]}
              onChange={(event) =>
                setFilterDraft((current) => ({ ...current, [field]: event.target.value }))
              }
              placeholder={
                field === "text"
                  ? "Buscar texto"
                  : field === "channel"
                    ? "Canal"
                    : field === "sender"
                      ? "Remitente"
                      : "Destinatario"
              }
              maxLength={field === "text" ? 200 : 100}
              className="px-2.5 py-1.5 bg-slate-900 border border-slate-700 rounded-lg text-xs text-slate-200 focus:outline-none focus:border-indigo-500"
            />
          ))}
          <input
            type="datetime-local"
            aria-label="Filtro desde"
            value={filterDraft.from}
            onChange={(event) =>
              setFilterDraft((current) => ({ ...current, from: event.target.value }))
            }
            className="px-2.5 py-1.5 bg-slate-900 border border-slate-700 rounded-lg text-xs text-slate-200 focus:outline-none focus:border-indigo-500"
          />
          <input
            type="datetime-local"
            aria-label="Filtro hasta"
            value={filterDraft.to}
            onChange={(event) =>
              setFilterDraft((current) => ({ ...current, to: event.target.value }))
            }
            className="px-2.5 py-1.5 bg-slate-900 border border-slate-700 rounded-lg text-xs text-slate-200 focus:outline-none focus:border-indigo-500"
          />
          <div className="col-span-2 lg:col-span-6 flex items-center justify-between gap-2">
            <div className="flex gap-2">
              <button
                type="submit"
                className="px-3 py-1.5 rounded-lg bg-indigo-700 hover:bg-indigo-600 text-xs font-medium text-white"
              >
                Aplicar filtros
              </button>
              <button
                type="button"
                onClick={clearFilters}
                className="px-3 py-1.5 rounded-lg border border-slate-700 text-xs text-slate-300 hover:text-white"
              >
                Limpiar
              </button>
            </div>
            <span className="text-xs text-slate-500">
              {messages.length} {messages.length === 1 ? "mensaje" : "mensajes"}
            </span>
          </div>
        </form>
      </div>

      {/* Messages List Area */}
      <div className="flex-1 overflow-y-auto space-y-3 pr-1">
        <ErrorBanner error={syncError} />
        <ErrorBanner error={historyQuery.error} />
        {historyQuery.hasNextPage && (
          <div className="flex justify-center pb-1">
            <button
              type="button"
              onClick={() => void historyQuery.fetchNextPage()}
              disabled={historyQuery.isFetchingNextPage}
              className="px-3 py-1.5 rounded-lg border border-slate-700 bg-slate-900 text-xs font-medium text-slate-300 hover:border-indigo-600 hover:text-indigo-200 disabled:opacity-50"
            >
              {historyQuery.isFetchingNextPage ? "Cargando…" : "Cargar mensajes anteriores"}
            </button>
          </div>
        )}
        {messages.length === 0 ? (
          <EmptyState
            title={historyQuery.isPending ? "Cargando historial" : "No hay mensajes en este canal"}
            description={
              historyQuery.isPending
                ? "Recuperando mensajes retenidos sin modificar el cursor del inbox."
                : "Envía un mensaje utilizando el formulario de abajo para iniciar la colaboración."
            }
          />
        ) : (
          messages.map((msg) => (
            <div
              key={msg.message_id}
              className={`p-3.5 rounded-xl border transition-all ${
                msg.sender_id === auth?.agentId
                  ? "bg-slate-900/90 border-indigo-900/40"
                  : "bg-slate-900/50 border-slate-800"
              }`}
            >
              <div className="flex items-center justify-between gap-2 mb-1.5">
                <div className="flex items-center gap-2">
                  <span className="font-semibold text-sm text-indigo-300 font-mono">
                    {msg.sender_id}
                  </span>
                  <span className="text-xs text-slate-400 font-mono">#{msg.channel}</span>
                  {renderPriorityBadge(msg.priority)}
                  {msg.recipient_agent_ids && msg.recipient_agent_ids.length > 0 && (
                    <span className="text-xs text-amber-400/90 font-mono">
                      ➔ {msg.recipient_agent_ids.join(", ")}
                    </span>
                  )}
                </div>
                <time className="text-[11px] text-slate-400 font-mono">
                  {new Date(msg.created_at).toLocaleTimeString()}
                </time>
              </div>

              {/* Message Body (No CoT, No tokens) */}
              <p className="text-sm text-slate-200 whitespace-pre-wrap break-words leading-relaxed">
                {msg.body}
              </p>
            </div>
          ))
        )}
      </div>

      {/* Send Message Form */}
      <div className="pt-2 border-t border-slate-800 space-y-2">
        <ErrorBanner error={formError} onDismiss={() => setFormError(null)} />
        <form
          onSubmit={handleSend}
          className="space-y-3 bg-slate-900/80 border border-slate-800 p-3.5 rounded-xl"
        >
          <div className="flex flex-wrap items-center gap-3">
            <div className="flex items-center gap-1.5">
              <span className="text-xs text-slate-400">Canal:</span>
              <input
                type="text"
                value={newChannel}
                onChange={(e) => setNewChannel(e.target.value)}
                placeholder="general"
                className="w-28 px-2 py-1 bg-slate-950 border border-slate-800 rounded text-xs text-slate-200 focus:outline-none focus:border-indigo-500 font-mono"
              />
            </div>

            <div className="flex items-center gap-1.5">
              <span className="text-xs text-slate-400">Prioridad:</span>
              <select
                value={newPriority}
                onChange={(e) => setNewPriority(e.target.value as MessagePriority)}
                className="px-2 py-1 bg-slate-950 border border-slate-800 rounded text-xs text-slate-200 focus:outline-none focus:border-indigo-500"
              >
                <option value="normal">Normal</option>
                <option value="low">Baja</option>
                <option value="high">Alta</option>
                <option value="urgent">Urgente</option>
              </select>
            </div>

            <div className="flex-1 flex items-center gap-1.5 min-w-[200px]">
              <span className="text-xs text-slate-400">Destinatarios:</span>
              <input
                type="text"
                value={newRecipients}
                onChange={(e) => setNewRecipients(e.target.value)}
                placeholder="opcional: agente1, agente2"
                className="flex-1 px-2 py-1 bg-slate-950 border border-slate-800 rounded text-xs text-slate-200 focus:outline-none focus:border-indigo-500 font-mono"
              />
            </div>
          </div>

          <div className="flex items-end gap-2">
            <textarea
              value={newBody}
              onChange={(e) => setNewBody(e.target.value)}
              placeholder="Escribe un mensaje para coordinar con el equipo..."
              rows={2}
              className="flex-1 px-3 py-2 bg-slate-950 border border-slate-800 rounded-lg text-sm text-slate-100 focus:outline-none focus:border-indigo-500 resize-none"
              onKeyDown={(e) => {
                if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) {
                  e.preventDefault();
                  handleSend(e);
                }
              }}
            />
            <button
              type="submit"
              disabled={sendMutation.isPending || !newBody.trim()}
              className="px-4 py-2 bg-indigo-600 hover:bg-indigo-500 disabled:bg-indigo-900 disabled:opacity-50 text-white font-medium rounded-lg text-sm transition-colors shadow"
            >
              {sendMutation.isPending ? "Enviando..." : "Enviar"}
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}
