import type { WorkspaceLock } from "@agents-hub/shared";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import type React from "react";
import { useEffect, useState } from "react";
import { EmptyState, ErrorBanner, LoadingSpinner } from "../../components/States.js";
import { useHub } from "../../context/HubContext.js";
import {
  ApiClientError,
  claimLock,
  fetchLocks,
  membershipRequest,
  releaseLock,
  renewLock,
} from "../../lib/api.js";

export function LocksPanel() {
  const { auth } = useHub();
  const queryClient = useQueryClient();

  const [pathsInput, setPathsInput] = useState("");
  const [reason, setReason] = useState("");
  const [ttlSeconds, setTtlSeconds] = useState(300);
  const [formError, setFormError] = useState<unknown | null>(null);
  const [now, setNow] = useState(() => Date.now());

  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, []);

  const locksQuery = useQuery({
    queryKey: ["locks", auth?.projectId],
    queryFn: () => {
      if (!auth) throw new Error("No auth");
      return fetchLocks(auth.baseUrl, auth.token, auth.projectId);
    },
    enabled: Boolean(auth),
    refetchInterval: 5000,
  });

  const claimMutation = useMutation({
    mutationFn: async () => {
      if (!auth) throw new Error("No auth");
      const paths = pathsInput
        .split(/[\n,]+/)
        .map((p) => p.trim())
        .filter(Boolean);

      if (paths.length === 0) {
        throw new Error("Debes indicar al menos una ruta de archivo o módulo");
      }

      return claimLock(auth.baseUrl, auth.token, auth.projectId, auth.sessionId, {
        paths,
        reason: reason.trim(),
        ttl_seconds: ttlSeconds,
      });
    },
    onSuccess: () => {
      setPathsInput("");
      setReason("");
      setFormError(null);
      void queryClient.invalidateQueries({ queryKey: ["locks", auth?.projectId] });
      void queryClient.invalidateQueries({ queryKey: ["team-status", auth?.projectId] });
    },
    onError: (err) => {
      setFormError(err);
    },
  });

  const membershipQuery = useQuery({
    queryKey: ["current-membership", auth?.projectId, auth?.userId],
    enabled: Boolean(auth),
    retry: false,
    queryFn: async () => {
      if (!auth) throw new Error("No auth");
      const members = await membershipRequest<Array<{ user_id: string; role: string }>>(
        auth.baseUrl,
        auth.token,
        `/v1/projects/${encodeURIComponent(auth.projectId)}/members`,
      );
      return members.find((member) => member.user_id === auth.userId)?.role ?? null;
    },
  });

  const releaseMutation = useMutation({
    mutationFn: async (lockId: string) => {
      if (!auth) throw new Error("No auth");
      return releaseLock(auth.baseUrl, auth.token, auth.projectId, auth.sessionId, lockId);
    },
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ["locks", auth?.projectId] });
      void queryClient.invalidateQueries({ queryKey: ["team-status", auth?.projectId] });
    },
  });

  const renewMutation = useMutation({
    mutationFn: async (command: { lockId: string; ttl: number; key: string }) => {
      if (!auth) throw new Error("No auth");
      return renewLock(
        auth.baseUrl,
        auth.token,
        auth.projectId,
        auth.sessionId,
        command.lockId,
        command.ttl,
        command.key,
      );
    },
    retry: (failures, error) =>
      failures < 2 &&
      (error instanceof TypeError ||
        (error instanceof ApiClientError && [408, 502, 503, 504].includes(error.statusCode))),
    onSuccess: () => {
      setFormError(null);
      void queryClient.invalidateQueries({ queryKey: ["locks", auth?.projectId] });
      void queryClient.invalidateQueries({ queryKey: ["team-status", auth?.projectId] });
    },
    onError: () => {
      void queryClient.invalidateQueries({ queryKey: ["locks", auth?.projectId] });
    },
  });

  const handleClaim = (e: React.FormEvent) => {
    e.preventDefault();
    if (!pathsInput.trim() || !reason.trim()) return;
    claimMutation.mutate();
  };

  const locks = locksQuery.data ?? [];

  const formatExpiresAt = (expiresAt: string) => {
    const diffMs = new Date(expiresAt).getTime() - now;
    if (diffMs <= 0) return "Expirado";
    const sec = Math.floor(diffMs / 1000);
    const min = Math.floor(sec / 60);
    if (min > 0) return `${min}m ${sec % 60}s`;
    return `${sec}s`;
  };

  return (
    <div className="grid grid-cols-1 lg:grid-cols-3 gap-6">
      {/* Left 2 Cols: Active Locks */}
      <div className="lg:col-span-2 space-y-4">
        <div className="flex items-center justify-between pb-2 border-b border-slate-800">
          <h2 className="text-base font-bold text-white">Locks de Archivos y Módulos</h2>
          <span className="text-xs text-slate-500">
            {locks.length} {locks.length === 1 ? "lock activo" : "locks activos"}
          </span>
        </div>

        {releaseMutation.isError && (
          <ErrorBanner error={releaseMutation.error} onDismiss={() => releaseMutation.reset()} />
        )}
        {renewMutation.isError && (
          <ErrorBanner error={renewMutation.error} onDismiss={() => renewMutation.reset()} />
        )}

        {locksQuery.isLoading ? (
          <LoadingSpinner message="Cargando locks activos..." />
        ) : locksQuery.isError ? (
          <ErrorBanner error={locksQuery.error} />
        ) : locks.length === 0 ? (
          <EmptyState
            title="No hay locks activos"
            description="Ningún agente tiene archivos bloqueados en este momento. Todos los módulos están disponibles."
          />
        ) : (
          <div className="space-y-3">
            {locks.map((lock: WorkspaceLock) => {
              const isOwner = lock.owner_agent_id === auth?.agentId;
              const canRenew = isOwner || membershipQuery.data === "owner";
              const isExpired = Date.parse(lock.expires_at) <= now;
              return (
                <div
                  key={lock.lock_id}
                  className={`bg-slate-900/60 border rounded-xl p-4 space-y-2.5 transition-all ${
                    isOwner ? "border-indigo-800/60" : "border-slate-800"
                  }`}
                >
                  <div className="flex items-start justify-between gap-3">
                    <div className="space-y-1">
                      <div className="flex items-center gap-2 flex-wrap">
                        <span className="font-semibold text-sm text-slate-100 font-mono">
                          {lock.owner_agent_id}
                        </span>
                        {isOwner && (
                          <span className="px-1.5 py-0.5 rounded text-[10px] font-bold bg-indigo-900/60 text-indigo-300 border border-indigo-700">
                            Mi Lock
                          </span>
                        )}
                        <span className="px-2 py-0.5 rounded text-xs font-mono bg-slate-950 text-slate-400 border border-slate-800">
                          Expira en: {formatExpiresAt(lock.expires_at)}
                        </span>
                      </div>
                      <p className="text-xs text-slate-300">
                        <span className="text-slate-500 font-medium">Motivo: </span>
                        {lock.reason}
                      </p>
                    </div>

                    <div className="flex gap-2">
                      {canRenew && !isExpired && (
                        <button
                          type="button"
                          aria-label={`Renovar lock ${lock.lock_id}`}
                          onClick={() =>
                            renewMutation.mutate({
                              lockId: lock.lock_id,
                              ttl: ttlSeconds,
                              key: crypto.randomUUID(),
                            })
                          }
                          disabled={
                            renewMutation.isPending ||
                            !Number.isInteger(ttlSeconds) ||
                            ttlSeconds < 1 ||
                            ttlSeconds > 3600
                          }
                          className="px-3 py-1 bg-emerald-950 hover:bg-emerald-900 text-emerald-300 border border-emerald-800 rounded-lg text-xs font-medium transition-colors disabled:opacity-50"
                        >
                          Renovar {ttlSeconds}s
                        </button>
                      )}
                      {isOwner && (
                        <button
                          type="button"
                          onClick={() => releaseMutation.mutate(lock.lock_id)}
                          disabled={releaseMutation.isPending}
                          className="px-3 py-1 bg-rose-950 hover:bg-rose-900 text-rose-300 hover:text-rose-200 border border-rose-800 rounded-lg text-xs font-medium transition-colors"
                        >
                          Liberar
                        </button>
                      )}
                    </div>
                  </div>

                  {/* Paths locked */}
                  <div className="bg-slate-950/80 rounded-lg p-2 border border-slate-800/80">
                    <span className="text-[11px] text-slate-500 block mb-1">Rutas bloqueadas:</span>
                    <ul className="space-y-0.5 font-mono text-xs text-indigo-300">
                      {lock.paths.map((p) => (
                        <li key={p} className="flex items-center gap-1.5">
                          <span className="text-slate-600">▪</span>
                          <span>{p}</span>
                        </li>
                      ))}
                    </ul>
                  </div>
                </div>
              );
            })}
          </div>
        )}
      </div>

      {/* Right 1 Col: Claim Lock Form */}
      <div className="space-y-4">
        <div className="pb-2 border-b border-slate-800">
          <h2 className="text-base font-bold text-white">Reclamar Lock de Archivo</h2>
          <p className="text-xs text-slate-400">Previene conflictos antes de editar código</p>
        </div>

        <ErrorBanner error={formError} onDismiss={() => setFormError(null)} />

        <form
          onSubmit={handleClaim}
          className="bg-slate-900 border border-slate-800 rounded-xl p-4 space-y-3"
        >
          <div>
            <label htmlFor="lock-paths" className="block text-xs font-semibold text-slate-300 mb-1">
              Rutas a Bloquear (separadas por coma o línea) *
            </label>
            <textarea
              id="lock-paths"
              value={pathsInput}
              onChange={(e) => setPathsInput(e.target.value)}
              placeholder="src/components/Header.tsx&#10;src/lib/api.ts"
              rows={3}
              className="w-full px-3 py-1.5 bg-slate-950 border border-slate-800 rounded-lg text-xs text-slate-200 focus:outline-none focus:border-indigo-500 font-mono resize-none"
              required
            />
          </div>

          <div>
            <label
              htmlFor="lock-reason"
              className="block text-xs font-semibold text-slate-300 mb-1"
            >
              Motivo del Lock *
            </label>
            <input
              id="lock-reason"
              type="text"
              value={reason}
              onChange={(e) => setReason(e.target.value)}
              placeholder="Ej: Refactorizando llamadas de API"
              className="w-full px-3 py-1.5 bg-slate-950 border border-slate-800 rounded-lg text-xs text-slate-200 focus:outline-none focus:border-indigo-500"
              required
            />
          </div>

          <div>
            <label htmlFor="lock-ttl" className="block text-xs font-semibold text-slate-300 mb-1">
              TTL para reclamar o renovar (segundos)
            </label>
            <input
              id="lock-ttl"
              type="number"
              min={1}
              max={3600}
              value={ttlSeconds}
              onChange={(e) => setTtlSeconds(e.target.valueAsNumber)}
              className="w-full px-3 py-1.5 bg-slate-950 border border-slate-800 rounded-lg text-xs text-slate-200 focus:outline-none focus:border-indigo-500 font-mono"
            />
          </div>

          <button
            type="submit"
            disabled={claimMutation.isPending || !pathsInput.trim() || !reason.trim()}
            className="w-full py-2 bg-indigo-600 hover:bg-indigo-500 disabled:bg-indigo-900 disabled:opacity-50 text-white font-medium rounded-lg text-xs transition-colors shadow"
          >
            {claimMutation.isPending ? "Reclamando..." : "Reclamar Lock"}
          </button>
        </form>
      </div>
    </div>
  );
}
