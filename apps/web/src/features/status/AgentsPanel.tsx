import type { StatusReport } from "@agents-hub/shared";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import type React from "react";
import { useMemo, useState } from "react";
import { EmptyState, ErrorBanner, LoadingSpinner } from "../../components/States.js";
import { useHub } from "../../context/HubContext.js";
import { fetchTeamStatus, reportStatus } from "../../lib/api.js";

export function AgentsPanel() {
  const { auth } = useHub();
  const queryClient = useQueryClient();

  const [objective, setObjective] = useState("");
  const [progress, setProgress] = useState<"started" | "in_progress" | "blocked" | "completed">(
    "in_progress",
  );
  const [decision, setDecision] = useState("");
  const [blockedBy, setBlockedBy] = useState("");
  const [nextStep, setNextStep] = useState("");
  const [formError, setFormError] = useState<unknown | null>(null);

  const teamQuery = useQuery({
    queryKey: ["team-status", auth?.projectId],
    queryFn: () => {
      if (!auth) throw new Error("No auth");
      return fetchTeamStatus(auth.baseUrl, auth.token, auth.projectId);
    },
    enabled: Boolean(auth),
    refetchInterval: 5000,
  });

  const reportMutation = useMutation({
    mutationFn: async () => {
      if (!auth) throw new Error("No auth");
      return reportStatus(auth.baseUrl, auth.token, auth.projectId, auth.sessionId, {
        objective: objective.trim(),
        progress,
        decision: decision.trim() || undefined,
        blocked_by: blockedBy.trim() || undefined,
        next_step: nextStep.trim() || undefined,
      });
    },
    onSuccess: () => {
      setObjective("");
      setDecision("");
      setBlockedBy("");
      setNextStep("");
      setFormError(null);
      void queryClient.invalidateQueries({ queryKey: ["team-status", auth?.projectId] });
    },
    onError: (err) => {
      setFormError(err);
    },
  });

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    if (!objective.trim()) return;
    reportMutation.mutate();
  };

  // Map latest status per agent
  const agentStatusMap = useMemo(() => {
    const map = new Map<string, StatusReport>();
    if (teamQuery.data?.statuses) {
      for (const st of teamQuery.data.statuses) {
        map.set(st.agent_id, st);
      }
    }
    return map;
  }, [teamQuery.data?.statuses]);

  const agents = teamQuery.data?.active_agents ?? [];

  const renderProgressBadge = (prog?: string) => {
    switch (prog) {
      case "completed":
        return (
          <span className="px-2 py-0.5 rounded text-xs font-semibold bg-emerald-950 text-emerald-400 border border-emerald-800">
            Completado
          </span>
        );
      case "blocked":
        return (
          <span className="px-2 py-0.5 rounded text-xs font-semibold bg-rose-950 text-rose-400 border border-rose-800">
            Bloqueado
          </span>
        );
      case "started":
        return (
          <span className="px-2 py-0.5 rounded text-xs font-semibold bg-sky-950 text-sky-400 border border-sky-800">
            Iniciado
          </span>
        );
      default:
        return (
          <span className="px-2 py-0.5 rounded text-xs font-semibold bg-indigo-950 text-indigo-400 border border-indigo-800">
            En progreso
          </span>
        );
    }
  };

  const renderPresenceBadge = (status: string) => {
    switch (status) {
      case "active":
        return (
          <span className="inline-flex items-center gap-1 text-xs text-emerald-400">
            <span className="w-2 h-2 rounded-full bg-emerald-400" />
            Activo
          </span>
        );
      case "idle":
        return (
          <span className="inline-flex items-center gap-1 text-xs text-amber-400">
            <span className="w-2 h-2 rounded-full bg-amber-400" />
            Inactivo
          </span>
        );
      default:
        return (
          <span className="inline-flex items-center gap-1 text-xs text-slate-500">
            <span className="w-2 h-2 rounded-full bg-slate-500" />
            Desconectado
          </span>
        );
    }
  };

  return (
    <div className="grid grid-cols-1 lg:grid-cols-3 gap-6">
      {/* Left 2 Cols: Agents & Statuses */}
      <div className="lg:col-span-2 space-y-4">
        <div className="flex items-center justify-between pb-2 border-b border-slate-800">
          <h2 className="text-base font-bold text-white">Presencia y Estados del Equipo</h2>
          <span className="text-xs text-slate-500">{agents.length} agentes registrados</span>
        </div>

        {teamQuery.isLoading ? (
          <LoadingSpinner message="Cargando estado del equipo..." />
        ) : teamQuery.isError ? (
          <ErrorBanner error={teamQuery.error} />
        ) : agents.length === 0 ? (
          <EmptyState
            title="No hay agentes en este proyecto"
            description="Los agentes que se unan mediante MCP o la web aparecerán listados aquí."
          />
        ) : (
          <div className="space-y-4">
            {agents.map((agent) => {
              const status = agentStatusMap.get(agent.agent_id);
              return (
                <div
                  key={agent.session_id}
                  className="bg-slate-900/60 border border-slate-800 rounded-xl p-4 space-y-3"
                >
                  <div className="flex items-center justify-between flex-wrap gap-2">
                    <div className="flex items-center gap-3">
                      <div className="w-8 h-8 rounded-full bg-slate-800 border border-slate-700 flex items-center justify-center font-bold text-xs text-indigo-400">
                        {agent.agent_id.slice(0, 2).toUpperCase()}
                      </div>
                      <div>
                        <div className="flex items-center gap-2">
                          <span className="font-semibold text-slate-100 font-mono text-sm">
                            {agent.agent_id}
                          </span>
                          {renderPresenceBadge(agent.status)}
                        </div>
                        <p className="text-[11px] text-slate-500 font-mono">
                          Última actividad: {new Date(agent.last_seen_at).toLocaleTimeString()}
                        </p>
                      </div>
                    </div>

                    {status && renderProgressBadge(status.progress)}
                  </div>

                  {status ? (
                    <div className="bg-slate-950/60 border border-slate-800/80 rounded-lg p-3 space-y-2 text-xs">
                      <div>
                        <span className="text-slate-400 font-medium">Objetivo: </span>
                        <span className="text-slate-200">{status.objective}</span>
                      </div>

                      {status.decision && (
                        <div>
                          <span className="text-slate-400 font-medium">Decisión técnica: </span>
                          <span className="text-indigo-300">{status.decision}</span>
                        </div>
                      )}

                      {status.blocked_by && (
                        <div className="p-2 rounded bg-rose-950/40 border border-rose-900 text-rose-300">
                          <span className="font-bold">⚠️ Bloqueado por: </span>
                          <span>{status.blocked_by}</span>
                        </div>
                      )}

                      {status.next_step && (
                        <div>
                          <span className="text-slate-400 font-medium">Siguiente paso: </span>
                          <span className="text-slate-300">{status.next_step}</span>
                        </div>
                      )}
                    </div>
                  ) : (
                    <p className="text-xs text-slate-500 italic">
                      Sin reporte de estado registrado aún.
                    </p>
                  )}
                </div>
              );
            })}
          </div>
        )}
      </div>

      {/* Right 1 Col: Report Status Form */}
      <div className="space-y-4">
        <div className="pb-2 border-b border-slate-800">
          <h2 className="text-base font-bold text-white">Publicar Reporte de Estado</h2>
          <p className="text-xs text-slate-400">
            Comparte objetivos y bloqueos con el resto del equipo
          </p>
        </div>

        <ErrorBanner error={formError} onDismiss={() => setFormError(null)} />

        <form
          onSubmit={handleSubmit}
          className="bg-slate-900 border border-slate-800 rounded-xl p-4 space-y-3"
        >
          <div>
            <label
              htmlFor="agent-objective"
              className="block text-xs font-semibold text-slate-300 mb-1"
            >
              Objetivo Actual *
            </label>
            <input
              id="agent-objective"
              type="text"
              value={objective}
              onChange={(e) => setObjective(e.target.value)}
              placeholder="Ej: Implementando validación de esquemas Zod"
              className="w-full px-3 py-1.5 bg-slate-950 border border-slate-800 rounded-lg text-xs text-slate-200 focus:outline-none focus:border-indigo-500"
              required
            />
          </div>

          <div>
            <label
              htmlFor="agent-progress"
              className="block text-xs font-semibold text-slate-300 mb-1"
            >
              Progreso
            </label>
            <select
              id="agent-progress"
              value={progress}
              onChange={(e) =>
                setProgress(e.target.value as "started" | "in_progress" | "blocked" | "completed")
              }
              className="w-full px-3 py-1.5 bg-slate-950 border border-slate-800 rounded-lg text-xs text-slate-200 focus:outline-none focus:border-indigo-500"
            >
              <option value="started">Iniciado</option>
              <option value="in_progress">En progreso</option>
              <option value="blocked">Bloqueado</option>
              <option value="completed">Completado</option>
            </select>
          </div>

          <div>
            <label
              htmlFor="agent-decision"
              className="block text-xs font-semibold text-slate-300 mb-1"
            >
              Decisión Técnica (opcional)
            </label>
            <input
              id="agent-decision"
              type="text"
              value={decision}
              onChange={(e) => setDecision(e.target.value)}
              placeholder="Ej: Adoptar base64url para cursores"
              className="w-full px-3 py-1.5 bg-slate-950 border border-slate-800 rounded-lg text-xs text-slate-200 focus:outline-none focus:border-indigo-500"
            />
          </div>

          <div>
            <label
              htmlFor="agent-blocked-by"
              className="block text-xs font-semibold text-slate-300 mb-1"
            >
              Bloqueado Por (opcional)
            </label>
            <input
              id="agent-blocked-by"
              type="text"
              value={blockedBy}
              onChange={(e) => setBlockedBy(e.target.value)}
              placeholder="Ej: Esperando revisión del contrato por Agente B"
              className="w-full px-3 py-1.5 bg-slate-950 border border-slate-800 rounded-lg text-xs text-slate-200 focus:outline-none focus:border-rose-500"
            />
          </div>

          <div>
            <label
              htmlFor="agent-next-step"
              className="block text-xs font-semibold text-slate-300 mb-1"
            >
              Siguiente Paso (opcional)
            </label>
            <input
              id="agent-next-step"
              type="text"
              value={nextStep}
              onChange={(e) => setNextStep(e.target.value)}
              placeholder="Ej: Ejecutar tests de integración"
              className="w-full px-3 py-1.5 bg-slate-950 border border-slate-800 rounded-lg text-xs text-slate-200 focus:outline-none focus:border-indigo-500"
            />
          </div>

          <button
            type="submit"
            disabled={reportMutation.isPending || !objective.trim()}
            className="w-full py-2 bg-indigo-600 hover:bg-indigo-500 disabled:bg-indigo-900 disabled:opacity-50 text-white font-medium rounded-lg text-xs transition-colors shadow"
          >
            {reportMutation.isPending ? "Publicando..." : "Publicar Estado"}
          </button>
        </form>
      </div>
    </div>
  );
}
