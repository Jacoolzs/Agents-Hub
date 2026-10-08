import type React from "react";
import { useState } from "react";
import { ErrorBanner, LoadingSpinner } from "../../components/States.js";
import { useHub } from "../../context/HubContext.js";
import { createProject, fetchProject, joinSession } from "../../lib/api.js";

export function ConnectView() {
  const { connect } = useHub();

  const [mode, setMode] = useState<"join" | "create">("join");
  const [baseUrl, setBaseUrl] = useState("http://127.0.0.1:8787");
  const [token, setToken] = useState("");
  const [projectId, setProjectId] = useState("");
  const [projectName, setProjectName] = useState("");
  const [agentId, setAgentId] = useState("dashboard-user");
  const [isLoading, setIsLoading] = useState(false);
  const [error, setError] = useState<unknown | null>(null);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError(null);

    const cleanBaseUrl = baseUrl.trim().replace(/\/+$/, "");
    const cleanToken = token.trim();
    const cleanAgentId = agentId.trim();

    if (!cleanToken) {
      setError(new Error("El token de acceso o invitación es requerido."));
      return;
    }

    setIsLoading(true);
    try {
      let finalProjectId = projectId.trim();
      let finalProjectName = "";

      if (mode === "create") {
        if (!projectName.trim()) {
          throw new Error("El nombre del proyecto es requerido.");
        }
        const created = await createProject(
          cleanBaseUrl,
          cleanToken,
          projectName.trim(),
          cleanAgentId,
        );
        finalProjectId = created.project.project_id;
        finalProjectName = created.project.name;
      } else {
        if (!finalProjectId) {
          throw new Error("El ID del proyecto es requerido.");
        }
        const proj = await fetchProject(cleanBaseUrl, cleanToken, finalProjectId);
        finalProjectName = proj.name;
      }

      // Join session to get session_id
      const session = await joinSession(
        cleanBaseUrl,
        cleanToken,
        finalProjectId,
        cleanAgentId || "dashboard-user",
      );

      connect({
        baseUrl: cleanBaseUrl,
        token: cleanToken,
        projectId: finalProjectId,
        projectName: finalProjectName,
        sessionId: session.session_id,
        agentId: session.agent_id,
      });
    } catch (err) {
      setError(err);
    } finally {
      setIsLoading(false);
    }
  };

  return (
    <div className="min-h-screen flex items-center justify-center p-4 bg-slate-950 text-slate-100">
      <div className="w-full max-w-md bg-slate-900 border border-slate-800 rounded-xl shadow-2xl p-6 sm:p-8 space-y-6">
        <div className="text-center space-y-2">
          <div className="inline-flex items-center justify-center w-12 h-12 rounded-xl bg-indigo-600/20 text-indigo-400 font-bold text-xl border border-indigo-500/30">
            AH
          </div>
          <h1 className="text-2xl font-bold tracking-tight text-white">Agents-Hub</h1>
          <p className="text-sm text-slate-400">
            Dashboard de coordinación y supervisión en tiempo real
          </p>
        </div>

        <div className="flex border-b border-slate-800">
          <button
            type="button"
            className={`flex-1 py-2 text-sm font-medium border-b-2 transition-colors ${
              mode === "join"
                ? "border-indigo-500 text-indigo-400"
                : "border-transparent text-slate-400 hover:text-slate-300"
            }`}
            onClick={() => setMode("join")}
          >
            Conectar Proyecto
          </button>
          <button
            type="button"
            className={`flex-1 py-2 text-sm font-medium border-b-2 transition-colors ${
              mode === "create"
                ? "border-indigo-500 text-indigo-400"
                : "border-transparent text-slate-400 hover:text-slate-300"
            }`}
            onClick={() => setMode("create")}
          >
            Crear Proyecto
          </button>
        </div>

        <ErrorBanner error={error} onDismiss={() => setError(null)} />

        <form onSubmit={handleSubmit} className="space-y-4">
          <div>
            <label htmlFor="hub-url" className="block text-xs font-semibold text-slate-300 mb-1">
              URL del Hub Server
            </label>
            <input
              id="hub-url"
              type="text"
              value={baseUrl}
              onChange={(e) => setBaseUrl(e.target.value)}
              className="w-full px-3 py-2 bg-slate-950 border border-slate-800 rounded-lg text-sm text-slate-100 focus:outline-none focus:border-indigo-500 font-mono"
              placeholder="http://127.0.0.1:8787"
              required
            />
          </div>

          <div>
            <label htmlFor="auth-token" className="block text-xs font-semibold text-slate-300 mb-1">
              Token de Acceso / Invitación
            </label>
            <input
              id="auth-token"
              type="password"
              value={token}
              onChange={(e) => setToken(e.target.value)}
              className="w-full px-3 py-2 bg-slate-950 border border-slate-800 rounded-lg text-sm text-slate-100 focus:outline-none focus:border-indigo-500 font-mono"
              placeholder="ah_..."
              required
            />
          </div>

          {mode === "join" ? (
            <div>
              <label
                htmlFor="project-id"
                className="block text-xs font-semibold text-slate-300 mb-1"
              >
                ID del Proyecto
              </label>
              <input
                id="project-id"
                type="text"
                value={projectId}
                onChange={(e) => setProjectId(e.target.value)}
                className="w-full px-3 py-2 bg-slate-950 border border-slate-800 rounded-lg text-sm text-slate-100 focus:outline-none focus:border-indigo-500 font-mono"
                placeholder="00000000-0000-0000-0000-000000000000"
                required
              />
            </div>
          ) : (
            <div>
              <label
                htmlFor="project-name"
                className="block text-xs font-semibold text-slate-300 mb-1"
              >
                Nombre del Nuevo Proyecto
              </label>
              <input
                id="project-name"
                type="text"
                value={projectName}
                onChange={(e) => setProjectName(e.target.value)}
                className="w-full px-3 py-2 bg-slate-950 border border-slate-800 rounded-lg text-sm text-slate-100 focus:outline-none focus:border-indigo-500"
                placeholder="Mi Proyecto Colaborativo"
                required
              />
            </div>
          )}

          <div>
            <label htmlFor="agent-id" className="block text-xs font-semibold text-slate-300 mb-1">
              Identificador de Sesión / Agente
            </label>
            <input
              id="agent-id"
              type="text"
              value={agentId}
              onChange={(e) => setAgentId(e.target.value)}
              className="w-full px-3 py-2 bg-slate-950 border border-slate-800 rounded-lg text-sm text-slate-100 focus:outline-none focus:border-indigo-500 font-mono"
              placeholder="dashboard-user"
              required
            />
          </div>

          <button
            type="submit"
            disabled={isLoading}
            className="w-full py-2.5 px-4 bg-indigo-600 hover:bg-indigo-500 disabled:bg-indigo-800 disabled:opacity-50 text-white font-medium rounded-lg text-sm transition-colors shadow-lg shadow-indigo-600/20"
          >
            {isLoading ? (
              <span className="flex items-center justify-center gap-2">
                <span className="w-4 h-4 border-2 border-white border-t-transparent rounded-full animate-spin" />
                Conectando...
              </span>
            ) : mode === "join" ? (
              "Ingresar al Dashboard"
            ) : (
              "Crear y Conectar"
            )}
          </button>
        </form>
      </div>
    </div>
  );
}
