import type { LocalUser, Project, WebInvitationMetadata } from "@agents-hub/shared";
import React, { useState } from "react";

interface Props {
  users: LocalUser[];
  projects: Project[];
  invitations: WebInvitationMetadata[];
  projectId: string;
  setProjectId: (id: string) => void;
  ready: boolean;
  busy: boolean;
  shared: boolean;
  onCreate: (input: unknown) => void;
  onRevoke: (id: string) => void;
}

export function LocalInvitationForm(props: Props) {
  const [kind, setKind] = useState("new");
  const [username, setUsername] = useState("");
  const [userId, setUserId] = useState("");
  const [role, setRole] = useState("collaborator");
  const [ttl, setTtl] = useState(3600);
  const [revoking, setRevoking] = useState<string | null>(null);
  const inputClass = "w-full rounded-lg border border-slate-300 bg-white px-3 py-2";
  return (
    <div className="local-section" aria-labelledby="web-invite-title">
      <h2 id="web-invite-title">Invitar con un enlace</h2>
      <p>
        Prepara a la persona y sus permisos aquí. Sólo tendrá que abrir el enlace y confirmar su
        entrada.
      </p>
      <form
        onSubmit={(event) => {
          event.preventDefault();
          props.onCreate({
            project_id: props.projectId,
            person:
              kind === "new" ? { kind: "new", username } : { kind: "existing", user_id: userId },
            role,
            ttl_seconds: ttl,
          });
        }}
      >
        <label htmlFor="web-invite-kind">Persona a invitar</label>
        <select
          id="web-invite-kind"
          className={inputClass}
          value={kind}
          onChange={(e) => setKind(e.target.value)}
          disabled={props.busy}
        >
          <option value="new">Persona nueva</option>
          <option value="existing">Elegir persona existente</option>
        </select>
        {kind === "new" ? (
          <>
            <label htmlFor="web-invite-name">Nombre de la persona nueva</label>
            <input
              id="web-invite-name"
              className={inputClass}
              value={username}
              onChange={(e) => setUsername(e.target.value)}
              required
              maxLength={80}
              pattern="[A-Za-z0-9._\-]+"
              autoComplete="off"
              aria-describedby="web-invite-name-hint"
              disabled={props.busy}
            />
            <p id="web-invite-name-hint" className="field-hint">
              Letras, números, punto, guion o guion bajo. Si ya existe, elígela en la lista; no se
              reutiliza su identidad automáticamente.
            </p>
          </>
        ) : (
          <>
            <label htmlFor="web-invite-person">Persona existente</label>
            <select
              id="web-invite-person"
              className={inputClass}
              value={userId}
              onChange={(e) => setUserId(e.target.value)}
              required
              disabled={props.busy}
            >
              <option value="" disabled>
                Selecciona a quién invitas
              </option>
              {props.users.map((user) => (
                <option key={user.user_id} value={user.user_id}>
                  {user.username}
                </option>
              ))}
            </select>
          </>
        )}
        <label htmlFor="web-invite-project">Proyecto de la invitación</label>
        <select
          id="web-invite-project"
          className={inputClass}
          value={props.projectId}
          onChange={(e) => props.setProjectId(e.target.value)}
          required
          disabled={props.busy}
        >
          <option value="" disabled>
            Primero crea un proyecto
          </option>
          {props.projects.map((project) => (
            <option key={project.project_id} value={project.project_id}>
              {project.name}
            </option>
          ))}
        </select>
        <label htmlFor="web-invite-role">Permisos de la invitación</label>
        <select
          id="web-invite-role"
          className={inputClass}
          value={role}
          onChange={(e) => setRole(e.target.value)}
          disabled={props.busy}
        >
          <option value="collaborator">Colaborar</option>
          <option value="reader">Sólo lectura</option>
          <option value="maintainer">Administrar colaboradores</option>
        </select>
        <p className="field-hint">
          {role === "reader"
            ? "Puede ver el proyecto, pero no escribir mensajes ni reclamar archivos."
            : role === "maintainer"
              ? "Puede colaborar y administrar colaboradores y lectores; no cambia al dueño."
              : "Puede escribir mensajes, compartir estado y coordinar archivos."}
        </p>
        <details>
          <summary>Duración del enlace</summary>
          <label htmlFor="web-invite-ttl">Vencimiento de la invitación</label>
          <select
            id="web-invite-ttl"
            className={inputClass}
            value={ttl}
            onChange={(e) => setTtl(Number(e.target.value))}
            disabled={props.busy}
          >
            <option value={3600}>Una hora</option>
            <option value={86400}>Un día</option>
            <option value={604800}>Siete días</option>
          </select>
        </details>
        <p className="field-hint">
          Se usa una sola vez. No concede acceso hasta que la persona confirma. No conecta su IA ni
          crea una contraseña.
        </p>
        {!props.ready && (
          <p className="field-hint">Inicia el Hub para crear un enlace utilizable.</p>
        )}
        {!props.shared && props.ready && (
          <p className="field-hint">
            El enlace local sólo funciona en este PC. Para invitar a otro PC, pulsa Compartir por
            Internet primero.
          </p>
        )}
        <button
          type="submit"
          className="local-primary"
          disabled={props.busy || !props.ready || !props.projectId}
        >
          {props.busy ? "Preparando…" : "Crear invitación"}
        </button>
      </form>
      <h3>Invitaciones del portal</h3>
      <p className="field-hint">
        No guardamos el enlace visible. Si lo pierdes, revoca la invitación pendiente y crea otra
        para la persona existente.
      </p>
      {!props.invitations.length && <p>Todavía no hay invitaciones del portal.</p>}
      <ul className="local-list">
        {props.invitations.map((invitation) => {
          const status = invitation.consumed_at
            ? "Aceptada"
            : invitation.revoked_at
              ? "Revocada"
              : Date.parse(invitation.expires_at) <= Date.now()
                ? "Vencida"
                : "Pendiente";
          return (
            <li key={invitation.entry_id}>
              <strong>{invitation.username}</strong>
              <span>
                {invitation.project_name} —{" "}
                {invitation.pending_role === "reader"
                  ? "Sólo lectura"
                  : invitation.pending_role === "maintainer"
                    ? "Administrar colaboradores"
                    : "Colaborar"}
              </span>
              <span>
                {status}. Vence: {new Date(invitation.expires_at).toLocaleString()}
              </span>
              {status === "Pendiente" && (
                <>
                  <button
                    type="button"
                    disabled={props.busy}
                    onClick={() => setRevoking(invitation.entry_id)}
                  >
                    Revocar invitación de {invitation.username}
                  </button>
                  {revoking === invitation.entry_id && (
                    <div className="local-actions">
                      <p>Este enlace dejará de permitir la entrada. No elimina a la persona.</p>
                      <button
                        type="button"
                        disabled={props.busy}
                        onClick={() => props.onRevoke(invitation.entry_id)}
                      >
                        Confirmar revocación de invitación
                      </button>
                      <button type="button" disabled={props.busy} onClick={() => setRevoking(null)}>
                        Cancelar revocación de invitación
                      </button>
                    </div>
                  )}
                </>
              )}
            </li>
          );
        })}
      </ul>
    </div>
  );
}
