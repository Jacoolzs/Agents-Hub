import type { Message, MessagePriority } from "@agents-hub/shared";
import { useMutation } from "@tanstack/react-query";
import type React from "react";
import { useMemo, useState } from "react";
import { EmptyState, ErrorBanner } from "../../components/States.js";
import { useHub } from "../../context/HubContext.js";
import { sendMessage } from "../../lib/api.js";

export function MessageFeed() {
  const { auth, events, syncError, realtimeManager } = useHub();

  const [channelFilter, setChannelFilter] = useState<string>("all");
  const [newChannel, setNewChannel] = useState("general");
  const [newPriority, setNewPriority] = useState<MessagePriority>("normal");
  const [newRecipients, setNewRecipients] = useState("");
  const [newBody, setNewBody] = useState("");
  const [formError, setFormError] = useState<unknown | null>(null);

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

  // Extract messages from inbox events
  const messages: Message[] = useMemo(() => {
    const list: Message[] = [];
    for (const event of events) {
      if (event.type === "message.created" && event.payload) {
        const payload = event.payload as Record<string, unknown>;
        list.push({
          ...(payload as unknown as Message),
          created_at: ((payload.created_at as string | undefined) ?? event.occurred_at) as string,
        });
      }
    }
    // Newest at bottom
    return list.sort((a, b) => new Date(a.created_at).getTime() - new Date(b.created_at).getTime());
  }, [events]);

  const uniqueChannels = useMemo(() => {
    const set = new Set<string>();
    for (const m of messages) {
      if (m.channel) set.add(m.channel);
    }
    return Array.from(set);
  }, [messages]);

  const filteredMessages = useMemo(() => {
    if (channelFilter === "all") return messages;
    return messages.filter((m) => m.channel === channelFilter);
  }, [messages, channelFilter]);

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
      {/* Top Filter Bar */}
      <div className="flex items-center justify-between pb-2 border-b border-slate-800">
        <div className="flex items-center gap-2">
          <span className="text-xs font-semibold text-slate-400">Canal:</span>
          <select
            value={channelFilter}
            onChange={(e) => setChannelFilter(e.target.value)}
            className="px-2.5 py-1 bg-slate-900 border border-slate-700 rounded-lg text-xs text-slate-200 focus:outline-none focus:border-indigo-500"
          >
            <option value="all">Todos los canales</option>
            {uniqueChannels.map((c) => (
              <option key={c} value={c}>
                #{c}
              </option>
            ))}
          </select>
        </div>
        <span className="text-xs text-slate-500">
          {filteredMessages.length} {filteredMessages.length === 1 ? "mensaje" : "mensajes"}
        </span>
      </div>

      {/* Messages List Area */}
      <div className="flex-1 overflow-y-auto space-y-3 pr-1">
        <ErrorBanner error={syncError} />
        {filteredMessages.length === 0 ? (
          <EmptyState
            title="No hay mensajes en este canal"
            description="Envía un mensaje utilizando el formulario de abajo para iniciar la colaboración."
          />
        ) : (
          filteredMessages.map((msg) => (
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
