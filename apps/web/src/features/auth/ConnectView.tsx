import type React from "react";
import { useState } from "react";
import { Icon } from "../../components/Icon.js";
import { ErrorBanner } from "../../components/States.js";
import { useHub } from "../../context/HubContext.js";
import { createProject, fetchProject, joinSession, membershipRequest } from "../../lib/api.js";

export function ConnectView() {
  const [instanceId] = useState(() => crypto.randomUUID());
  const { connect } = useHub();

  const [mode, setMode] = useState<"join" | "create">("join");
  const [baseUrl, setBaseUrl] = useState(
    window.location.port === "5173" ? "http://127.0.0.1:8787" : window.location.origin,
  );
  const [invitation, setInvitation] = useState("");
  const [token, setToken] = useState("");
  const [projectId, setProjectId] = useState("");
  const [projectName, setProjectName] = useState("");
  const [agentId, setAgentId] = useState("dashboard-user");
  const [isLoading, setIsLoading] = useState(false);
  const [error, setError] = useState<unknown | null>(null);
  const [showToken, setShowToken] = useState(false);

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
        if (invitation.trim()) {
          await membershipRequest(
            cleanBaseUrl,
            cleanToken,
            `/v1/projects/${encodeURIComponent(finalProjectId)}/invitations/accept`,
            "POST",
            { token: invitation.trim() },
          );
          setInvitation("");
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
        instanceId,
      );

      connect({
        baseUrl: cleanBaseUrl,
        token: cleanToken,
        projectId: finalProjectId,
        projectName: finalProjectName,
        sessionId: session.session_id,
        agentId: session.agent_id,
        userId: session.user_id,
      });
    } catch (err) {
      setError(err);
    } finally {
      setIsLoading(false);
    }
  };

  return (
    <div className="connect-layout">
      <aside className="connect-story">
        <div className="brand">
          <span className="brand-mark">
            <Icon name="hub" />
          </span>
          <span>Agents-Hub</span>
        </div>
        <div>
          <h2>
            Un equipo de agentes.
            <br />
            Un contexto compartido.
          </h2>
          <p>
            Conecta las conversaciones, las decisiones y los archivos de tu proyecto. Cada agente
            trabaja en su entorno; el equipo se encuentra aquí.
          </p>
          <svg className="coordination-map" viewBox="0 0 440 180" fill="none" aria-hidden="true">
            <path
              d="M76 90H166M274 90H364M220 42V64M220 116V144"
              stroke="#567797"
              strokeWidth="2"
            />
            <rect x="166" y="64" width="108" height="52" rx="12" fill="#315bdf" />
            <rect x="24" y="64" width="52" height="52" rx="12" fill="#203650" stroke="#567797" />
            <rect x="364" y="64" width="52" height="52" rx="12" fill="#203650" stroke="#567797" />
            <circle cx="220" cy="30" r="12" fill="#a9c9ff" />
            <circle cx="220" cy="156" r="12" fill="#83c8b6" />
            <path
              d="M41 82h18M41 90h12M41 98h18M381 82h18M381 90h12M381 98h18"
              stroke="#bdcde0"
              strokeWidth="2"
            />
            <text
              x="220"
              y="96"
              fill="white"
              textAnchor="middle"
              fontSize="16"
              fontFamily="Segoe UI, sans-serif"
            >
              Tu proyecto
            </text>
          </svg>
        </div>
        <div className="story-footer">
          Comunicación intencional. Contexto visible. Trabajo coordinado.
        </div>
      </aside>
      <div className="connect-content">
        <div className="connect-card">
          <div>
            <h1>Agents-Hub</h1>
            <p className="intro">
              {mode === "join"
                ? "Entra al espacio de tu equipo para continuar la colaboración."
                : "Crea un espacio para coordinar tu próximo proyecto."}
            </p>
          </div>

          <div className="mode-switch" aria-label="Acceso al proyecto">
            <button
              type="button"
              aria-pressed={mode === "join"}
              onClick={() => {
                setMode("join");
                setError(null);
              }}
            >
              Conectar Proyecto
            </button>
            <button
              type="button"
              aria-pressed={mode === "create"}
              onClick={() => {
                setMode("create");
                setError(null);
              }}
            >
              Crear Proyecto
            </button>
          </div>

          <ErrorBanner error={error} onDismiss={() => setError(null)} />

          <form onSubmit={handleSubmit} className="space-y-5" aria-busy={isLoading}>
            <div>
              <label htmlFor="hub-url" className="block text-sm font-semibold text-slate-700 mb-1">
                Dirección del Hub
              </label>
              <input
                id="hub-url"
                type="url"
                value={baseUrl}
                onChange={(e) => setBaseUrl(e.target.value)}
                className="w-full px-3 py-2 bg-white border border-slate-300 rounded-lg text-sm text-slate-900"
                placeholder="http://127.0.0.1:8787"
                aria-describedby="hub-url-hint"
                required
              />
              <p id="hub-url-hint" className="field-hint">
                Usa la dirección que te compartió el anfitrión.
              </p>
            </div>

            <div>
              <label
                htmlFor="auth-token"
                className="block text-xs font-semibold text-slate-700 mb-1"
              >
                Token de acceso personal
              </label>
              <input
                id="auth-token"
                type={showToken ? "text" : "password"}
                value={token}
                onChange={(e) => setToken(e.target.value)}
                className="w-full px-3 py-2 bg-slate-50 border border-slate-200 rounded-lg text-sm text-slate-900 focus:outline-none focus:border-blue-500 font-mono"
                placeholder="ah_..."
                autoComplete="off"
                spellCheck={false}
                aria-describedby="token-hint"
                required
              />
              <div className="flex items-center justify-between gap-2">
                <p id="token-hint" className="field-hint">
                  Se conserva sólo durante esta sesión.
                </p>
                <button
                  type="button"
                  onClick={() => setShowToken((show) => !show)}
                  aria-pressed={showToken}
                  className="text-xs text-blue-700 px-2"
                >
                  {showToken ? "Ocultar token" : "Mostrar token"}
                </button>
              </div>
            </div>

            {mode === "join" && (
              <div>
                <label
                  htmlFor="invitation"
                  className="block text-xs font-semibold text-slate-700 mb-1"
                >
                  Invitación (sólo la primera vez)
                </label>
                <input
                  id="invitation"
                  type="password"
                  value={invitation}
                  onChange={(e) => setInvitation(e.target.value)}
                  placeholder="ahi_..."
                  className="w-full px-3 py-2 bg-slate-50 border border-slate-200 rounded-lg text-sm"
                />
              </div>
            )}

            {mode === "join" ? (
              <div>
                <label
                  htmlFor="project-id"
                  className="block text-xs font-semibold text-slate-700 mb-1"
                >
                  ID del Proyecto
                </label>
                <input
                  id="project-id"
                  type="text"
                  value={projectId}
                  onChange={(e) => setProjectId(e.target.value)}
                  className="w-full px-3 py-2 bg-slate-50 border border-slate-200 rounded-lg text-sm text-slate-900 focus:outline-none focus:border-blue-500 font-mono"
                  placeholder="00000000-0000-0000-0000-000000000000"
                  required
                />
              </div>
            ) : (
              <div>
                <label
                  htmlFor="project-name"
                  className="block text-xs font-semibold text-slate-700 mb-1"
                >
                  Nombre del Nuevo Proyecto
                </label>
                <input
                  id="project-name"
                  type="text"
                  value={projectName}
                  onChange={(e) => setProjectName(e.target.value)}
                  className="w-full px-3 py-2 bg-slate-50 border border-slate-200 rounded-lg text-sm text-slate-900 focus:outline-none focus:border-blue-500"
                  placeholder="Mi Proyecto Colaborativo"
                  required
                />
              </div>
            )}

            <div>
              <label htmlFor="agent-id" className="block text-xs font-semibold text-slate-700 mb-1">
                Tu nombre en el equipo
              </label>
              <input
                id="agent-id"
                type="text"
                value={agentId}
                onChange={(e) => setAgentId(e.target.value)}
                className="w-full px-3 py-2 bg-slate-50 border border-slate-200 rounded-lg text-sm text-slate-900 focus:outline-none focus:border-blue-500 font-mono"
                placeholder="dashboard-user"
                required
              />
            </div>

            <button
              type="submit"
              disabled={isLoading}
              className="w-full py-2.5 px-4 bg-blue-600 hover:bg-blue-500 disabled:bg-blue-50 disabled:opacity-50 text-white font-medium rounded-lg text-sm transition-colors shadow-lg shadow-indigo-600/20"
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
          <p className="connect-note">
            Necesitas un token personal y el ID del proyecto. Si aún no tienes acceso, solicita una
            invitación al anfitrión.
          </p>
        </div>
      </div>
    </div>
  );
}
