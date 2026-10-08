import type React from "react";
import { useState } from "react";
import { useHub } from "../context/HubContext.js";
import type { ConnectionStatus } from "../types/index.js";

interface ShellProps {
  children: {
    messages: React.ReactNode;
    agents: React.ReactNode;
    locks: React.ReactNode;
  };
}

export function Shell({ children }: ShellProps) {
  const { auth, connectionStatus, disconnect } = useHub();
  const [activeTab, setActiveTab] = useState<"messages" | "agents" | "locks">("messages");

  if (!auth) return null;

  const renderStatusBadge = (status: ConnectionStatus) => {
    switch (status) {
      case "connected":
        return (
          <span className="inline-flex items-center gap-1.5 px-2.5 py-1 rounded-full text-xs font-medium bg-emerald-950/60 text-emerald-400 border border-emerald-800">
            <span className="w-2 h-2 rounded-full bg-emerald-400 animate-pulse" />
            Conectado (WS)
          </span>
        );
      case "connecting":
      case "reconnecting":
        return (
          <span className="inline-flex items-center gap-1.5 px-2.5 py-1 rounded-full text-xs font-medium bg-amber-950/60 text-amber-400 border border-amber-800">
            <span className="w-2 h-2 rounded-full bg-amber-400 animate-ping" />
            {status === "connecting" ? "Conectando..." : "Reconectando (Inbox activo)..."}
          </span>
        );
      default:
        return (
          <span className="inline-flex items-center gap-1.5 px-2.5 py-1 rounded-full text-xs font-medium bg-rose-950/60 text-rose-400 border border-rose-800">
            <span className="w-2 h-2 rounded-full bg-rose-400" />
            Desconectado (Polling)
          </span>
        );
    }
  };

  return (
    <div className="min-h-screen bg-slate-950 text-slate-100 flex flex-col font-sans">
      {/* Top Header */}
      <header className="border-b border-slate-800 bg-slate-900/60 backdrop-blur sticky top-0 z-20 px-4 py-3 sm:px-6">
        <div className="max-w-7xl mx-auto flex flex-wrap items-center justify-between gap-4">
          <div className="flex items-center gap-3">
            <div className="w-9 h-9 rounded-lg bg-indigo-600/30 text-indigo-400 border border-indigo-500/40 font-bold flex items-center justify-center text-sm shadow">
              AH
            </div>
            <div>
              <div className="flex items-center gap-2">
                <h1 className="font-bold text-base text-white tracking-tight">
                  {auth.projectName || "Proyecto"}
                </h1>
                {renderStatusBadge(connectionStatus)}
              </div>
              <p className="text-xs text-slate-400 font-mono flex items-center gap-1">
                ID: {auth.projectId}
              </p>
            </div>
          </div>

          <div className="flex items-center gap-3">
            <div className="text-right hidden sm:block">
              <p className="text-xs text-slate-400">Sesión activa</p>
              <p className="text-sm font-medium text-slate-200 font-mono">{auth.agentId}</p>
            </div>
            <button
              type="button"
              onClick={disconnect}
              className="px-3 py-1.5 text-xs font-medium bg-slate-800 hover:bg-slate-700 text-slate-300 hover:text-white rounded-lg border border-slate-700 transition-colors"
            >
              Desconectar
            </button>
          </div>
        </div>

        {/* Tab Navigation */}
        <div className="max-w-7xl mx-auto mt-3 flex border-b border-slate-800/80 -mb-3">
          <button
            type="button"
            data-testid="tab-messages"
            onClick={() => setActiveTab("messages")}
            className={`px-4 py-2 text-sm font-medium border-b-2 transition-colors ${
              activeTab === "messages"
                ? "border-indigo-500 text-indigo-400"
                : "border-transparent text-slate-400 hover:text-slate-300"
            }`}
          >
            💬 Feed de Mensajes
          </button>
          <button
            type="button"
            data-testid="tab-agents"
            onClick={() => setActiveTab("agents")}
            className={`px-4 py-2 text-sm font-medium border-b-2 transition-colors ${
              activeTab === "agents"
                ? "border-indigo-500 text-indigo-400"
                : "border-transparent text-slate-400 hover:text-slate-300"
            }`}
          >
            👥 Agentes y Estados
          </button>
          <button
            type="button"
            data-testid="tab-locks"
            onClick={() => setActiveTab("locks")}
            className={`px-4 py-2 text-sm font-medium border-b-2 transition-colors ${
              activeTab === "locks"
                ? "border-indigo-500 text-indigo-400"
                : "border-transparent text-slate-400 hover:text-slate-300"
            }`}
          >
            🔒 Workspace Locks
          </button>
        </div>
      </header>

      {/* Main Body */}
      <main className="flex-1 max-w-7xl w-full mx-auto p-4 sm:p-6">
        {activeTab === "messages" && children.messages}
        {activeTab === "agents" && children.agents}
        {activeTab === "locks" && children.locks}
      </main>
    </div>
  );
}
