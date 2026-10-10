import type { WebSession } from "@agents-hub/shared";
import { useEffect, useRef, useState } from "react";
import { ApiClientError, webLogin } from "../../lib/api.js";
import { ConnectView } from "./ConnectView.js";

export function WebLoginForm({ onLogin }: { onLogin: (profile: WebSession) => Promise<void> }) {
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [visible, setVisible] = useState(false);
  const [projects, setProjects] = useState<{ project_id: string; name: string }[]>([]);
  const [projectId, setProjectId] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const projectSelect = useRef<HTMLSelectElement>(null);
  useEffect(() => {
    if (projects.length) projectSelect.current?.focus();
  }, [projects]);
  return (
    <div className="web-entry-layout">
      <a className="skip-link" href="#login-main">
        Saltar al acceso
      </a>
      <header className="local-header">
        <strong>Agents-Hub</strong>
      </header>
      <main className="web-entry-main" id="login-main" tabIndex={-1} aria-busy={busy}>
        <div className="page-heading">
          <h1>Vuelve a tu Hub</h1>
          <p>Entra con la cuenta que preparaste al aceptar tu invitación.</p>
        </div>
        <form
          className="web-entry-identity"
          onSubmit={(e) => {
            e.preventDefault();
            if (busy) return;
            setBusy(true);
            setError("");
            void webLogin(username, password, projectId || undefined)
              .then(async (result) => {
                if ("projects" in result) {
                  setProjects(result.projects);
                  setProjectId(result.projects[0]?.project_id ?? "");
                  return;
                }
                setPassword("");
                await onLogin(result);
              })
              .catch((e: unknown) =>
                setError(
                  e instanceof ApiClientError && e.code === "RATE_LIMITED"
                    ? "Demasiados intentos o el Hub está ocupado. Espera unos minutos y vuelve a intentarlo."
                    : e instanceof Error
                      ? e.message.replace(/^\[[A-Z_]+\]\s*/, "")
                      : "No se pudo entrar. Comprueba que el Hub siga disponible.",
                ),
              )
              .finally(() => setBusy(false));
          }}
        >
          <label htmlFor="login-user">Usuario</label>
          <input
            id="login-user"
            autoComplete="username"
            value={username}
            maxLength={80}
            required
            disabled={busy}
            onChange={(e) => {
              setUsername(e.target.value);
              setProjects([]);
              setProjectId("");
            }}
          />
          <label htmlFor="login-password">Contraseña</label>
          <input
            id="login-password"
            type={visible ? "text" : "password"}
            autoComplete="current-password"
            value={password}
            maxLength={256}
            required
            disabled={busy}
            onChange={(e) => {
              setPassword(e.target.value);
              setProjects([]);
              setProjectId("");
            }}
          />
          <button type="button" aria-pressed={visible} onClick={() => setVisible(!visible)}>
            {visible ? "Ocultar contraseña" : "Mostrar contraseña"}
          </button>
          {projects.length > 0 && (
            <>
              <label htmlFor="login-project">Proyecto</label>
              <select
                ref={projectSelect}
                id="login-project"
                value={projectId}
                disabled={busy}
                onChange={(e) => setProjectId(e.target.value)}
              >
                {projects.map((p) => (
                  <option key={p.project_id} value={p.project_id}>
                    {p.name}
                  </option>
                ))}
              </select>
            </>
          )}
          {error && (
            <p
              role="alert"
              className="p-4 my-4 rounded-lg border border-rose-200 bg-rose-50 text-rose-700 text-sm"
            >
              {error}
            </p>
          )}
          <div className="local-actions">
            <button className="web-entry-primary" type="submit" disabled={busy}>
              {busy ? "Entrando…" : "Entrar al portal"}
            </button>
          </div>
          <p className="field-hint">
            ¿Olvidaste la contraseña o todavía no tienes cuenta? Pide al anfitrión un enlace nuevo.
            Tu acceso a la IA se conecta por separado.
          </p>
        </form>
        <details className="mt-6">
          <summary>Conexión manual para agentes (avanzado)</summary>
          <ConnectView />
        </details>
      </main>
    </div>
  );
}
