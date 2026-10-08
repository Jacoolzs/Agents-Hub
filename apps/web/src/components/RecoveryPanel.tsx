import type { InboxRecovery } from "@agents-hub/shared";
import { useState } from "react";
import { useHub } from "../context/HubContext.js";
import { ApiClientError, fetchInboxRecovery } from "../lib/api.js";
import { ErrorBanner } from "./States.js";

export function RecoveryPanel() {
  const { auth, syncError, realtimeManager } = useHub();
  const [snapshot, setSnapshot] = useState<InboxRecovery | null>(null);
  const [error, setError] = useState<unknown>(null);
  const [busy, setBusy] = useState(false);
  if (!auth || !(syncError instanceof ApiClientError) || syncError.code !== "CURSOR_EXPIRED")
    return null;

  async function review() {
    if (!auth) return;
    setBusy(true);
    setError(null);
    try {
      setSnapshot(
        await fetchInboxRecovery(auth.baseUrl, auth.token, auth.projectId, auth.sessionId),
      );
    } catch (error) {
      setError(error);
    } finally {
      setBusy(false);
    }
  }
  async function accept() {
    if (!snapshot || !realtimeManager) return;
    setBusy(true);
    setError(null);
    try {
      await realtimeManager.acceptHistoryGap(snapshot.resume_cursor);
      setSnapshot(null);
    } catch (error) {
      setSnapshot(null);
      setError(error);
    } finally {
      setBusy(false);
    }
  }

  return (
    <section
      className="mb-4 p-4 border border-amber-800 rounded-lg bg-amber-950/30 space-y-3"
      aria-label="Recuperación de historial"
    >
      <p>
        Parte del historial fue eliminada por retención. Los mensajes borrados no se pueden
        recuperar. Revisa el estado actual antes de continuar con los mensajes conservados.
      </p>
      <ErrorBanner error={error} />
      {!snapshot ? (
        <button
          type="button"
          disabled={busy}
          onClick={() => void review()}
          className="px-3 py-2 bg-slate-800 rounded disabled:opacity-50"
        >
          Revisar estado actual
        </button>
      ) : (
        <>
          {snapshot.snapshot.active_agents && (
            <p>
              Agentes conectados:{" "}
              {snapshot.snapshot.active_agents.map((agent) => agent.agent_id).join(", ") ||
                "Ninguno"}
            </p>
          )}
          {snapshot.snapshot.locks && (
            <p>
              Rutas bloqueadas:{" "}
              {snapshot.snapshot.locks.flatMap((lock) => lock.paths).join(", ") || "Ninguna"}
            </p>
          )}
          <ul>
            {snapshot.snapshot.statuses.map((status) => (
              <li key={status.status_id}>
                {status.agent_id}: {status.objective} ({status.progress})
              </li>
            ))}
          </ul>
          <button
            type="button"
            disabled={busy}
            onClick={() => void accept()}
            className="px-3 py-2 bg-amber-800 rounded disabled:opacity-50"
          >
            Aceptar historial perdido y continuar
          </button>
        </>
      )}
    </section>
  );
}
