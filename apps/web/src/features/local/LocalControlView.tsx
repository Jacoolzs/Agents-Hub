import {
  LocalControlSnapshotSchema,
  LocalIssuedAccessSchema,
  WebEntrySchema,
  type WebInvitationMetadata,
  WebInvitationMetadataSchema,
} from "@agents-hub/shared";
import React, { useEffect, useRef, useState } from "react";
import { LocalInvitationForm } from "./LocalInvitationForm";

type Snapshot = ReturnType<typeof LocalControlSnapshotSchema.parse>;
type Secret = { value: string; title: string; expires: string; link?: boolean; entryId?: string };

async function request<T>(path: string, method = "GET", body?: unknown): Promise<T> {
  const response = await fetch(`/local-api/${path}`, {
    method,
    credentials: "same-origin",
    redirect: "error",
    ...(body === undefined
      ? {}
      : { headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) }),
  });
  const result = await response.json();
  if (!response.ok) throw new Error(result.error?.message ?? "No se pudo completar la operación.");
  return result as T;
}

let initialization: Promise<void> | undefined;
function initialize() {
  if (!initialization) {
    const secret = new URLSearchParams(window.location.hash.slice(1)).get("local-control");
    window.history.replaceState(null, "", `${window.location.pathname}${window.location.search}`);
    initialization = secret
      ? request("bootstrap", "POST", { secret }).then(() => undefined)
      : Promise.resolve();
  }
  return initialization;
}

async function loadSnapshot() {
  const [data, invites] = await Promise.all([request("snapshot"), request("web-invitations")]);
  return {
    data: LocalControlSnapshotSchema.parse(data),
    invites: WebInvitationMetadataSchema.array().parse(invites),
  };
}

export function LocalControlView() {
  const [snapshot, setSnapshot] = useState<Snapshot | null>(null);
  const [invitations, setInvitations] = useState<WebInvitationMetadata[]>([]);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [busy, setBusy] = useState(false);
  const [closed, setClosed] = useState(false);
  const [tab, setTab] = useState<"people" | "projects">("people");
  const [username, setUsername] = useState("");
  const [ttl, setTtl] = useState(28800);
  const [accessTtl, setAccessTtl] = useState(28800);
  const [selectedUser, setSelectedUser] = useState("");
  const [projectName, setProjectName] = useState("");
  const [projectOwner, setProjectOwner] = useState("");
  const [selectedProject, setSelectedProject] = useState("");
  const [webProject, setWebProject] = useState("");
  const [role, setRole] = useState("collaborator");
  const [secret, setSecret] = useState<Secret | null>(null);
  const secretInput = useRef<HTMLInputElement>(null);
  useEffect(() => {
    if (secret) secretInput.current?.focus();
  }, [secret]);
  const [showSecret, setShowSecret] = useState(false);
  const [revoking, setRevoking] = useState<string | null>(null);
  const refresh = async () => {
    const { data, invites } = await loadSnapshot();
    setSnapshot(data);
    setInvitations(invites);
  };
  useEffect(() => {
    let active = true;
    void initialize()
      .then(async () => {
        const { data, invites } = await loadSnapshot();
        if (active) {
          setSnapshot(data);
          setInvitations(invites);
        }
      })
      .catch((e: Error) => {
        if (active) setError(e.message);
      });
    return () => {
      active = false;
    };
  }, []);
  const act = async (work: () => Promise<void>, success: string) => {
    if (busy) return;
    setBusy(true);
    setError("");
    setNotice("");
    try {
      await work();
      await refresh();
      setNotice(success);
    } catch (e) {
      setError(e instanceof Error ? e.message : "No se completó la operación.");
    } finally {
      setBusy(false);
    }
  };
  const showAccess = (access: unknown, title: string) => {
    const parsed = LocalIssuedAccessSchema.parse(access);
    setSecret({ value: parsed.token, expires: parsed.expires_at, title });
    setShowSecret(false);
  };
  const userId = selectedUser || snapshot?.users[0]?.user_id || "";
  const ownerId = projectOwner || snapshot?.users[0]?.user_id || "";
  const projectId = selectedProject || snapshot?.projects[0]?.project_id || "";
  const user = snapshot?.users.find((entry) => entry.user_id === userId);
  const inputClass = "w-full rounded-lg border border-slate-300 bg-white px-3 py-2";

  return (
    <div className="local-workspace">
      <a className="skip-link" href="#local-main">
        Ir al panel
      </a>
      <header className="local-header">
        <div>
          <strong>Agents-Hub</strong>
          <p>Administración en este PC</p>
        </div>
        {!closed && snapshot && (
          <button
            type="button"
            disabled={busy}
            onClick={() => {
              setBusy(true);
              void request("logout", "POST")
                .then(() => {
                  setClosed(true);
                  setSnapshot(null);
                  setInvitations([]);
                  setSecret(null);
                })
                .catch((e: Error) => setError(e.message))
                .finally(() => setBusy(false));
            }}
          >
            Cerrar sesión local
          </button>
        )}
      </header>
      <main id="local-main" className="local-main" tabIndex={-1}>
        <div className="page-heading">
          <h1>Tu equipo empieza aquí</h1>
          <p>Prepara personas y proyectos. Abre el Hub cuando estés listo para colaborar.</p>
        </div>
        {error && (
          <div role="alert" className="local-error">
            {error}
          </div>
        )}
        {notice && <output className="local-notice">{notice}</output>}
        {closed ? (
          <section className="local-section">
            <h2>Sesión local cerrada</h2>
            <p>El Hub conserva su estado. Reabre el compañero para volver a administrar.</p>
          </section>
        ) : !snapshot ? (
          <section className="local-section">
            <p>
              {error
                ? "Reabre el compañero para obtener una entrada privada nueva."
                : "Abriendo tu panel…"}
            </p>
          </section>
        ) : (
          <>
            <section className="local-runtime" aria-labelledby="runtime-title" aria-busy={busy}>
              <div>
                <h2 id="runtime-title">Tu Hub</h2>
                <p>
                  {snapshot.runtime.hub === "running" ? "En marcha" : "Detenido"} ·{" "}
                  {snapshot.runtime.sharing === "running"
                    ? "Compartido por Internet"
                    : "Sin compartir por Internet"}
                </p>
                {snapshot.runtime.portal_url && (
                  <a href={snapshot.runtime.portal_url} target="_blank" rel="noreferrer">
                    Abrir portal
                  </a>
                )}
              </div>
              <div className="local-actions">
                <button
                  type="button"
                  className="local-primary"
                  disabled={busy || snapshot.runtime.hub === "running"}
                  onClick={() =>
                    void act(async () => {
                      await request("runtime/start", "POST");
                    }, "Hub iniciado.")
                  }
                >
                  Iniciar Hub
                </button>
                <button
                  type="button"
                  disabled={busy || snapshot.runtime.sharing === "running"}
                  onClick={() =>
                    void act(async () => {
                      await request("runtime/share", "POST");
                    }, "Hub compartido. La dirección cambia al volver a compartir.")
                  }
                >
                  Compartir por Internet
                </button>
                {snapshot.runtime.sharing === "running" && (
                  <button
                    type="button"
                    disabled={busy}
                    onClick={() =>
                      void act(async () => {
                        await request("runtime/stop-sharing", "POST");
                      }, "Acceso público detenido; el Hub sigue disponible localmente.")
                    }
                  >
                    Dejar de compartir
                  </button>
                )}
                <button
                  type="button"
                  disabled={busy || snapshot.runtime.hub === "stopped"}
                  onClick={() =>
                    void act(async () => {
                      await request("runtime/stop", "POST");
                    }, "Hub detenido. Tus datos están conservados.")
                  }
                >
                  Detener Hub
                </button>
                <button
                  type="button"
                  disabled={busy}
                  onClick={() => void act(async () => {}, "Estado actualizado.")}
                >
                  Actualizar estado
                </button>
              </div>
              <p className="field-hint">
                Compartir abre el acceso público y puede reconectar las sesiones. Mantén este PC
                encendido. Este panel permanece privado.
              </p>
            </section>
            {secret && (
              <section className="local-secret" aria-labelledby="secret-title">
                <h2 id="secret-title">{secret.title}</h2>
                <p>
                  {secret.link
                    ? "Compártelo sólo con esa persona. Permite entrar sin copiar IDs ni tokens; no conecta su IA."
                    : "Guárdalo o compártelo por privado. Se muestra sólo al emitirlo."}
                </p>
                <label htmlFor="local-secret">
                  {secret.link ? "Enlace de entrada" : "Credencial emitida"}
                </label>
                <input
                  id="local-secret"
                  ref={secretInput}
                  type={showSecret ? "text" : "password"}
                  value={secret.value}
                  readOnly
                  className={inputClass}
                  autoComplete="off"
                />
                <p className="field-hint">Vence: {new Date(secret.expires).toLocaleString()}</p>
                <div className="local-actions">
                  <button
                    type="button"
                    aria-pressed={showSecret}
                    onClick={() => setShowSecret(!showSecret)}
                  >
                    {showSecret ? "Ocultar" : "Mostrar"}
                  </button>
                  <button
                    type="button"
                    onClick={() =>
                      void navigator.clipboard
                        .writeText(secret.value)
                        .then(() =>
                          setNotice(secret.link ? "Enlace copiado." : "Credencial copiada."),
                        )
                        .catch(() =>
                          setError(
                            "No se pudo copiar. Pulsa Mostrar y copia el valor manualmente.",
                          ),
                        )
                    }
                  >
                    Copiar
                  </button>
                  <button
                    type="button"
                    onClick={() => {
                      setSecret(null);
                      setShowSecret(false);
                    }}
                  >
                    Descartar de pantalla
                  </button>
                </div>
              </section>
            )}
            <nav className="local-tabs" aria-label="Administración">
              <button
                type="button"
                aria-current={tab === "people" ? "page" : undefined}
                onClick={() => setTab("people")}
              >
                Personas
              </button>
              <button
                type="button"
                aria-current={tab === "projects" ? "page" : undefined}
                onClick={() => setTab("projects")}
              >
                Proyectos e invitaciones
              </button>
            </nav>
            <section hidden={tab !== "people"} className="local-columns">
              <div className="local-section">
                <h2>Personas</h2>
                {!snapshot.users.length && (
                  <p>Crea tu identidad para comenzar. Después puedes añadir a tu equipo.</p>
                )}
                <ul className="local-list">
                  {snapshot.users.map((person) => (
                    <li key={person.user_id}>
                      <strong>{person.username}</strong>
                      <button
                        type="button"
                        aria-pressed={userId === person.user_id}
                        onClick={() => {
                          setSelectedUser(person.user_id);
                          setRevoking(null);
                        }}
                      >
                        Gestionar accesos de {person.username}
                      </button>
                    </li>
                  ))}
                </ul>
                <form
                  onSubmit={(e) => {
                    e.preventDefault();
                    void act(async () => {
                      const result = await request<{ user: { user_id: string }; access: unknown }>(
                        "users",
                        "POST",
                        { username, ttl_seconds: ttl },
                      );
                      setSelectedUser(result.user.user_id);
                      showAccess(result.access, `Acceso de ${username}`);
                      setUsername("");
                    }, "Persona creada con su acceso personal.");
                  }}
                >
                  <h3>Añadir persona</h3>
                  <label htmlFor="local-username">Nombre de usuario</label>
                  <input
                    id="local-username"
                    className={inputClass}
                    value={username}
                    onChange={(e) => setUsername(e.target.value)}
                    required
                    pattern="[A-Za-z0-9._-]{1,80}"
                    maxLength={80}
                    aria-describedby="username-hint"
                  />
                  <p id="username-hint" className="field-hint">
                    Letras, números, punto, guion o guion bajo.
                  </p>
                  <details>
                    <summary>Duración del acceso</summary>
                    <label htmlFor="local-ttl">Vigencia</label>
                    <select
                      id="local-ttl"
                      className={inputClass}
                      value={ttl}
                      onChange={(e) => setTtl(Number(e.target.value))}
                    >
                      <option value={3600}>Una hora</option>
                      <option value={28800}>Ocho horas</option>
                      <option value={604800}>Siete días</option>
                      <option value={2592000}>Treinta días</option>
                    </select>
                  </details>
                  <button type="submit" className="local-primary" disabled={busy}>
                    Crear persona
                  </button>
                </form>
              </div>
              <div className="local-section">
                {user && (
                  <form
                    onSubmit={(e) => {
                      e.preventDefault();
                      void act(async () => {
                        const address = snapshot.runtime.portal_url;
                        if (!address) throw new Error("Inicia el Hub antes de generar la entrada.");
                        const result = WebEntrySchema.parse(
                          await request(`users/${userId}/web-entry`, "POST", {
                            project_id: webProject || snapshot.projects[0]?.project_id,
                          }),
                        );
                        const url = new URL(address);
                        url.hash = new URLSearchParams({ entry: result.secret }).toString();
                        setSecret({
                          value: url.toString(),
                          title: `Entrada al portal de ${user.username}`,
                          expires: result.expires_at,
                          link: true,
                        });
                        setShowSecret(false);
                      }, "Entrada creada. Vence en cinco minutos y se puede usar una sola vez.");
                    }}
                    className="local-web-entry"
                  >
                    <h2>Entrada al portal de {user.username}</h2>
                    <p>
                      Elige un proyecto al que ya pertenezca. Para una persona nueva, primero debe
                      aceptar su invitación.
                    </p>
                    <label htmlFor="local-web-project">Proyecto para entrar</label>
                    <select
                      id="local-web-project"
                      className={inputClass}
                      value={webProject || snapshot.projects[0]?.project_id || ""}
                      onChange={(e) => setWebProject(e.target.value)}
                      required
                    >
                      <option value="" disabled>
                        Primero crea un proyecto
                      </option>
                      {snapshot.projects.map((p) => (
                        <option key={p.project_id} value={p.project_id}>
                          {p.name}
                        </option>
                      ))}
                    </select>
                    <p className="field-hint">
                      {snapshot.runtime.sharing === "running"
                        ? "La entrada usa la dirección pública actual. Si cambia, genera otro enlace."
                        : "Sólo este PC: comparte el Hub por Internet antes de crear un enlace para tu amigo."}
                    </p>
                    <button
                      type="submit"
                      className="local-primary"
                      disabled={busy || !snapshot.runtime.portal_url || !snapshot.projects.length}
                    >
                      Crear entrada al portal
                    </button>
                  </form>
                )}
                <h2>{user ? `Accesos de ${user.username}` : "Accesos personales"}</h2>
                <p>
                  Cada acceso puede vencer o revocarse. Los secretos anteriores no se pueden
                  recuperar.
                </p>
                {user && (
                  <div className="local-form">
                    <label htmlFor="local-access-ttl">Vigencia del nuevo acceso</label>
                    <select
                      id="local-access-ttl"
                      className={inputClass}
                      value={accessTtl}
                      onChange={(e) => setAccessTtl(Number(e.target.value))}
                    >
                      <option value={3600}>Una hora</option>
                      <option value={28800}>Ocho horas</option>
                      <option value={604800}>Siete días</option>
                      <option value={2592000}>Treinta días</option>
                    </select>
                    <button
                      type="button"
                      disabled={busy}
                      onClick={() =>
                        void act(
                          async () =>
                            showAccess(
                              await request(`users/${userId}/accesses`, "POST", {
                                ttl_seconds: accessTtl,
                              }),
                              `Nuevo acceso de ${user.username}`,
                            ),
                          "Acceso emitido. Los anteriores conservan su vigencia hasta que los revoques.",
                        )
                      }
                    >
                      Emitir nuevo acceso
                    </button>
                  </div>
                )}
                <ul className="local-list">
                  {snapshot.accesses
                    .filter((entry) => entry.subject === userId)
                    .map((access) => {
                      const active =
                        !access.revoked_at && Date.parse(access.expires_at) > Date.now();
                      return (
                        <li key={access.token_id} className="local-access">
                          <div>
                            <p>
                              {access.audience === "agents-hub-browser"
                                ? "Sesión del portal"
                                : "Acceso de agente / personal"}
                            </p>
                            <strong>
                              {access.revoked_at ? "Revocado" : active ? "Vigente" : "Vencido"}
                            </strong>
                            <p>Vence: {new Date(access.expires_at).toLocaleString()}</p>
                            <small>
                              {access.project_id
                                ? (snapshot.projects.find((p) => p.project_id === access.project_id)
                                    ?.name ?? "Proyecto limitado")
                                : "Acceso personal"}
                            </small>
                          </div>
                          {active && (
                            <button
                              type="button"
                              disabled={busy}
                              onClick={() => setRevoking(access.token_id)}
                            >
                              Revocar acceso
                            </button>
                          )}
                          {revoking === access.token_id && (
                            <div className="local-confirm">
                              <p>Este acceso dejará de funcionar para sus conexiones.</p>
                              <button
                                type="button"
                                disabled={busy}
                                onClick={() =>
                                  void act(async () => {
                                    await request(`accesses/${access.token_id}`, "DELETE");
                                    setRevoking(null);
                                  }, "Acceso revocado.")
                                }
                              >
                                Confirmar revocación
                              </button>
                              <button type="button" onClick={() => setRevoking(null)}>
                                Cancelar
                              </button>
                            </div>
                          )}
                        </li>
                      );
                    })}
                </ul>
              </div>
            </section>
            <section hidden={tab !== "projects"} className="local-columns">
              <LocalInvitationForm
                users={snapshot.users}
                projects={snapshot.projects}
                invitations={invitations}
                projectId={projectId}
                setProjectId={setSelectedProject}
                ready={snapshot.runtime.hub === "running" && !!snapshot.runtime.portal_url}
                shared={snapshot.runtime.sharing === "running"}
                busy={busy}
                onCreate={(input) => {
                  void act(async () => {
                    const invitation = WebEntrySchema.parse(
                      await request("web-invitations", "POST", input),
                    );
                    const link = new URL(snapshot.runtime.portal_url as string);
                    link.hash = new URLSearchParams({ entry: invitation.secret }).toString();
                    setSecret({
                      value: link.toString(),
                      expires: invitation.expires_at,
                      title: "Invitación al portal",
                      link: true,
                      entryId: invitation.entry_id,
                    });
                    setShowSecret(false);
                  }, "Invitación al portal creada. Comparte el enlace por privado.");
                }}
                onRevoke={(id) =>
                  void act(async () => {
                    await request(`web-invitations/${id}`, "DELETE");
                    if (secret?.entryId === id) {
                      setSecret(null);
                      setShowSecret(false);
                    }
                  }, "Invitación al portal revocada.")
                }
              />
              <div className="local-section">
                <h2>Proyectos</h2>
                {!snapshot.projects.length && (
                  <p>Crea el primer proyecto y elige quién será su dueño.</p>
                )}
                <ul className="local-list">
                  {snapshot.projects.map((project) => (
                    <li key={project.project_id}>
                      <strong>{project.name}</strong>
                      <button
                        type="button"
                        aria-pressed={projectId === project.project_id}
                        onClick={() => setSelectedProject(project.project_id)}
                      >
                        Invitar a {project.name}
                      </button>
                      <details>
                        <summary>Datos de conexión</summary>
                        <code>{project.project_id}</code>
                      </details>
                    </li>
                  ))}
                </ul>
                <form
                  onSubmit={(e) => {
                    e.preventDefault();
                    void act(async () => {
                      const project = await request<{ project_id: string }>("projects", "POST", {
                        name: projectName,
                        user_id: ownerId,
                      });
                      setSelectedProject(project.project_id);
                      setProjectName("");
                    }, "Proyecto creado.");
                  }}
                >
                  <h3>Crear proyecto</h3>
                  <label htmlFor="local-project-name">Nombre del proyecto</label>
                  <input
                    id="local-project-name"
                    className={inputClass}
                    value={projectName}
                    onChange={(e) => setProjectName(e.target.value)}
                    required
                    maxLength={100}
                  />
                  <label htmlFor="local-owner">Dueño del proyecto</label>
                  <select
                    id="local-owner"
                    className={inputClass}
                    value={ownerId}
                    onChange={(e) => setProjectOwner(e.target.value)}
                    required
                  >
                    <option value="" disabled>
                      Primero crea una persona
                    </option>
                    {snapshot.users.map((person) => (
                      <option key={person.user_id} value={person.user_id}>
                        {person.username}
                      </option>
                    ))}
                  </select>
                  <button type="submit" className="local-primary" disabled={busy || !ownerId}>
                    Crear proyecto
                  </button>
                </form>
              </div>
              <div className="local-section">
                <details>
                  <summary>Invitación avanzada con token personal</summary>
                  <h2>Invitación legacy</h2>
                  <p>
                    Sólo para el flujo anterior: requiere acceso personal y aceptar esta credencial.
                    Para entrar al navegador usa Invitar con un enlace.
                  </p>
                  <form
                    onSubmit={(e) => {
                      e.preventDefault();
                      void act(async () => {
                        const invitation = await request<{ token: string; expires_at: string }>(
                          `projects/${projectId}/invitations`,
                          "POST",
                          { role, ttl_seconds: 86400 },
                        );
                        setSecret({
                          value: invitation.token,
                          expires: invitation.expires_at,
                          title: "Invitación de un solo uso",
                        });
                        setShowSecret(false);
                      }, "Invitación creada.");
                    }}
                  >
                    <label htmlFor="local-invite-project">Proyecto</label>
                    <select
                      id="local-invite-project"
                      className={inputClass}
                      value={projectId}
                      onChange={(e) => setSelectedProject(e.target.value)}
                      required
                    >
                      <option value="" disabled>
                        Primero crea un proyecto
                      </option>
                      {snapshot.projects.map((project) => (
                        <option key={project.project_id} value={project.project_id}>
                          {project.name}
                        </option>
                      ))}
                    </select>
                    <label htmlFor="local-role">Permisos</label>
                    <select
                      id="local-role"
                      className={inputClass}
                      value={role}
                      onChange={(e) => setRole(e.target.value)}
                    >
                      <option value="collaborator">Colaborar</option>
                      <option value="reader">Sólo lectura</option>
                      <option value="maintainer">Administrar colaboradores</option>
                    </select>
                    <p className="field-hint">Se puede usar una vez y vence en 24 horas.</p>
                    <button type="submit" className="local-primary" disabled={busy || !projectId}>
                      Crear invitación avanzada
                    </button>
                  </form>
                </details>
              </div>
            </section>
          </>
        )}
      </main>
    </div>
  );
}
