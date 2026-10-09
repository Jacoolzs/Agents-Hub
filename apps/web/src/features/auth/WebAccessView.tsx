import { WebEntrySecretSchema, type WebSession } from "@agents-hub/shared";
import { useEffect, useState } from "react";
import { Icon } from "../../components/Icon.js";
import { ErrorBanner } from "../../components/States.js";
import { useHub } from "../../context/HubContext.js";
import { ApiClientError, joinSession, webLogout, webSession } from "../../lib/api.js";
import type { AuthSessionConfig } from "../../types/index.js";
import { ConnectView } from "./ConnectView.js";

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
    if (error instanceof ApiClientError && [401, 404].includes(error.statusCode)) return null;
    throw error;
  }
}
type Initial =
  | { profile: WebSession; current: WebSession | null }
  | { config: AuthSessionConfig }
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
    const profile = await currentSession();
    return profile ? { config: await openView(profile) } : null;
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
        if (!result) setLegacy(true);
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
  const enter = async () => {
    if (busy || !profile || !entrySecret) return;
    setBusy(true);
    setError(null);
    const proof = entrySecret;
    try {
      if (current) {
        await webLogout();
        setCurrent(null);
      }
      const accepted = await webSession("entry", proof);
      // A newer link opened during this request must still get its own confirmation.
      if (entrySecret !== proof) return;
      entrySecret = null;
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
          <h1>{profile ? "Entra a tu proyecto" : "Abriendo el portal"}</h1>
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
            <p className="field-hint">
              El enlace es de un solo uso y vence a las{" "}
              {new Date(profile.expires_at).toLocaleTimeString()}. No lo compartas con otra persona.
            </p>
            {current && (
              <p className="web-entry-warning">
                Tienes una sesión como {current.user.username} en {current.project.name}. Al entrar,
                esa sesión se cerrará en este navegador.
              </p>
            )}
            <div className="local-actions">
              <button
                className="web-entry-primary"
                type="button"
                disabled={busy || !entrySecret}
                onClick={() => void enter()}
              >
                Entrar al proyecto
              </button>
              <button
                type="button"
                disabled={busy}
                onClick={() => {
                  entrySecret = null;
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
