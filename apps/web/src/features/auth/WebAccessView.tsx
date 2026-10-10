import { WebEntrySecretSchema, type WebSession } from "@agents-hub/shared";
import { useEffect, useState } from "react";
import { Icon } from "../../components/Icon.js";
import { ErrorBanner } from "../../components/States.js";
import { useHub } from "../../context/HubContext.js";
import { ApiClientError, joinSession, webAccount, webLogout, webSession } from "../../lib/api.js";
import type { AuthSessionConfig } from "../../types/index.js";
import { ConnectView } from "./ConnectView.js";
import { WebLoginForm } from "./WebLoginForm.js";

// Remove the one-use proof before rendering or making any network request.
let entrySecret: string | null = null;
export function readWebEntry() {
  const fragment = new URLSearchParams(window.location.hash.slice(1));
  if (!fragment.has("entry")) return false;
  entrySecret = fragment.get("entry");
  window.history.replaceState(null, "", `${window.location.pathname}${window.location.search}`);
  return true;
}
export function hasWebEntry() {
  return entrySecret !== null;
}
readWebEntry();

async function openView(profile: WebSession): Promise<AuthSessionConfig> {
  const session = await joinSession(
    window.location.origin,
    "",
    profile.project.project_id,
    `portal-${profile.user.username.slice(0, 40)}-${crypto.randomUUID().slice(0, 8)}`,
    crypto.randomUUID(),
  );
  return {
    baseUrl: window.location.origin,
    token: "",
    projectId: profile.project.project_id,
    projectName: profile.project.name,
    userId: profile.user.user_id,
    browserUser: profile.user.username,
    sessionId: session.session_id,
    agentId: session.agent_id,
  };
}
async function currentSession() {
  try {
    return await webSession("session");
  } catch (error) {
    if (error instanceof ApiClientError && error.statusCode === 401) return null;
    throw error;
  }
}
type Initial =
  | { profile: WebSession; current: WebSession | null }
  | { config: AuthSessionConfig }
  | { unsupported: true }
  | null;
let initialization: Promise<Initial> | undefined;
let initializationAttempt = 0;
let initializationSecret: string | null = null;
function initialize(attempt: number) {
  // Share only in-flight work across StrictMode effects; never cache a login after logout.
  if (initializationAttempt !== attempt || initializationSecret !== entrySecret)
    initialization = undefined;
  initializationAttempt = attempt;
  initializationSecret = entrySecret;
  if (initialization) return initialization;
  const secret = entrySecret;
  const pending = (async () => {
    if (secret !== null) {
      if (!WebEntrySecretSchema.safeParse(secret).success)
        throw new Error("La entrada no es válida. Pide un enlace nuevo al anfitrión.");
      return {
        profile: await webSession("entry/preview", secret),
        current: await currentSession(),
      };
    }
    try {
      const profile = await currentSession();
      return profile
        ? profile.account_registered === false
          ? { profile, current: profile }
          : { config: await openView(profile) }
        : null;
    } catch (error) {
      if (error instanceof ApiClientError && error.statusCode === 404)
        return { unsupported: true as const };
      throw error;
    }
  })().finally(() => {
    if (initialization === pending) {
      initialization = undefined;
      initializationSecret = null;
    }
  });
  initialization = pending;
  return pending;
}

export function WebAccessView({ onCancel }: { onCancel: () => void }) {
  const { auth, connect } = useHub();
  const [profile, setProfile] = useState<WebSession | null>(null);
  const [current, setCurrent] = useState<WebSession | null>(null);
  const [legacy, setLegacy] = useState(false);
  const [login, setLogin] = useState(false);
  const [password, setPassword] = useState("");
  const [showPassword, setShowPassword] = useState(false);
  const [busy, setBusy] = useState(true);
  const [error, setError] = useState<unknown>(null);
  const [attempt, setAttempt] = useState(0);
  useEffect(() => {
    let active = true;
    setBusy(true);
    setError(null);
    void initialize(attempt)
      .then((result) => {
        if (!active) return;
        if (!result) setLogin(true);
        else if ("unsupported" in result) setLegacy(true);
        else if ("config" in result) connect(result.config);
        else {
          setProfile(result.profile);
          setCurrent(result.current);
        }
      })
      .catch((e: unknown) => {
        if (active) setError(e);
      })
      .finally(() => {
        if (active) setBusy(false);
      });
    return () => {
      active = false;
    };
  }, [attempt, connect]);

  if (legacy) return <ConnectView />;
  if (login)
    return <WebLoginForm onLogin={async (accepted) => connect(await openView(accepted))} />;
  const enter = async () => {
    if (busy || !profile) return;
    setBusy(true);
    setError(null);
    const proof = entrySecret;
    try {
      if (current && proof) {
        await webLogout();
        setCurrent(null);
      }
      const accepted = proof ? await webSession("entry", proof) : profile;
      // A newer link opened during this request must still get its own confirmation.
      if (entrySecret !== proof) return;
      entrySecret = null;
      setProfile(accepted);
      if (accepted.account_registered === false) {
        try {
          await webAccount(password);
        } catch (e) {
          // Enrollment may have succeeded despite a lost response. Recheck without replaying the consumed link.
          const refreshed = await webSession("session");
          if (!refreshed.account_registered) throw e;
        }
      }
      setPassword("");
      connect(await openView(accepted));
    } catch (e) {
      setError(e);
    } finally {
      setBusy(false);
    }
  };
  return (
    <div className="web-entry-layout">
      <a className="skip-link" href="#entry-main">
        Saltar a la entrada
      </a>
      <header className="local-header">
        <div className="brand">
          <Icon name="hub" />
          <strong>Agents-Hub</strong>
        </div>
      </header>
      <main className="web-entry-main" id="entry-main" aria-busy={busy} tabIndex={-1}>
        <div className="page-heading">
          <h1>
            {profile
              ? entrySecret
                ? "Entra a tu proyecto"
                : "Prepara tu cuenta"
              : "Abriendo el portal"}
          </h1>
          <p>
            {profile
              ? "Confirma tu identidad antes de continuar."
              : "Comprobando tu entrada y tu sesión."}
          </p>
        </div>
        <ErrorBanner error={error} />
        {busy && <output>{profile ? "Entrando…" : "Comprobando acceso…"}</output>}
        {profile && (
          <section className="web-entry-identity" aria-label="Identidad de entrada">
            <dl>
              <div>
                <dt>Entrarás como</dt>
                <dd>{profile.user.username}</dd>
              </div>
              <div>
                <dt>Proyecto</dt>
                <dd>{profile.project.name}</dd>
              </div>
              <div>
                <dt>Permisos</dt>
                <dd>
                  {profile.project.role === "reader"
                    ? "Sólo lectura"
                    : profile.project.role === "owner"
                      ? "Dueño del proyecto"
                      : profile.project.role === "maintainer"
                        ? "Administrar colaboradores"
                        : "Colaborar"}
                </dd>
              </div>
            </dl>
            {entrySecret && (
              <p className="field-hint">
                El enlace es de un solo uso y vence a las{" "}
                {new Date(profile.expires_at).toLocaleTimeString()}. No lo compartas con otra
                persona.
              </p>
            )}
            {current && entrySecret && (
              <p className="web-entry-warning">
                Tienes una sesión como {current.user.username} en {current.project.name}. Al entrar,
                esa sesión se cerrará en este navegador.
              </p>
            )}
            {profile.account_registered === false && (
              <div className="web-account-fields">
                <label htmlFor="entry-password">Elige tu contraseña</label>
                <input
                  id="entry-password"
                  type={showPassword ? "text" : "password"}
                  autoComplete="new-password"
                  minLength={15}
                  maxLength={256}
                  value={password}
                  aria-describedby="entry-password-hint"
                  onChange={(e) => setPassword(e.target.value)}
                  disabled={busy}
                />
                <p id="entry-password-hint" className="field-hint">
                  De 15 a 128 caracteres. Puedes usar una frase o tu gestor de contraseñas. Después
                  volverás con tu usuario, sin pedir otra invitación.
                </p>
                <button
                  type="button"
                  aria-pressed={showPassword}
                  onClick={() => setShowPassword(!showPassword)}
                >
                  {showPassword ? "Ocultar contraseña" : "Mostrar contraseña"}
                </button>
              </div>
            )}
            <div className="local-actions">
              <button
                className="web-entry-primary"
                type="button"
                disabled={
                  busy ||
                  (profile.account_registered === false &&
                    (Array.from(password).length < 15 || Array.from(password).length > 128))
                }
                onClick={() => void enter()}
              >
                Entrar al proyecto
              </button>
              <button
                type="button"
                disabled={busy}
                onClick={() => {
                  entrySecret = null;
                  setPassword("");
                  setLegacy(true);
                  onCancel();
                }}
              >
                Cancelar
              </button>
            </div>
            <p className="field-hint">
              Puedes recargar el portal mientras tu sesión siga vigente. Conectar tu IA es un paso
              separado.
            </p>
          </section>
        )}
        {Boolean(error) && !busy && (
          <div className="local-actions">
            <button type="button" onClick={() => setAttempt(attempt + 1)}>
              Reintentar acceso
            </button>
            <button
              type="button"
              onClick={() => {
                entrySecret = null;
                setLegacy(true);
                onCancel();
              }}
            >
              {auth ? "Volver al proyecto actual" : "Volver a la conexión manual"}
            </button>
          </div>
        )}
      </main>
    </div>
  );
}
