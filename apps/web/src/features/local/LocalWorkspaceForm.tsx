import type { LocalUser } from "@agents-hub/shared";
import React, { useState } from "react";

export function LocalWorkspaceForm({
  users,
  busy,
  onCreate,
}: { users: LocalUser[]; busy: boolean; onCreate: (input: unknown) => void }) {
  const [kind, setKind] = useState("new");
  const [username, setUsername] = useState("");
  const [userId, setUserId] = useState("");
  const [name, setName] = useState("");
  const inputClass = "w-full rounded-lg border border-slate-300 bg-white px-3 py-2";
  return (
    <section className="local-section mb-6" aria-labelledby="workspace-title">
      <h2 id="workspace-title">Prepara tu primer proyecto</h2>
      <p className="max-w-xl">
        Tu identidad y el proyecto se crean juntos. Después puedes compartir e invitar al equipo; la
        conexión de tu IA es un paso separado.
      </p>
      <form
        className="local-form max-w-xl"
        onSubmit={(event) => {
          event.preventDefault();
          onCreate({
            name,
            person:
              kind === "new" ? { kind: "new", username } : { kind: "existing", user_id: userId },
          });
        }}
      >
        {users.length > 0 && (
          <>
            <label htmlFor="workspace-kind">Identidad del anfitrión</label>
            <select
              id="workspace-kind"
              className={inputClass}
              value={kind}
              onChange={(e) => setKind(e.target.value)}
              disabled={busy}
            >
              <option value="new">Crear una identidad nueva</option>
              <option value="existing">Usar una persona existente</option>
            </select>
          </>
        )}
        {kind === "new" ? (
          <>
            <label htmlFor="workspace-username">Tu nombre para el equipo</label>
            <input
              id="workspace-username"
              className={inputClass}
              value={username}
              onChange={(e) => setUsername(e.target.value)}
              required
              maxLength={80}
              pattern="[A-Za-z0-9._\-]+"
              autoComplete="username"
              disabled={busy}
              aria-describedby="workspace-name-hint"
            />
            <p id="workspace-name-hint" className="field-hint">
              Letras, números, punto, guion o guion bajo. No es una cuenta con contraseña.
            </p>
          </>
        ) : (
          <>
            <label htmlFor="workspace-person">Anfitrión existente</label>
            <select
              id="workspace-person"
              className={inputClass}
              value={userId}
              onChange={(e) => setUserId(e.target.value)}
              required
              disabled={busy}
            >
              <option value="" disabled>
                Selecciona a la persona
              </option>
              {users.map((user) => (
                <option key={user.user_id} value={user.user_id}>
                  {user.username}
                </option>
              ))}
            </select>
          </>
        )}
        <label htmlFor="workspace-name">Nombre del primer proyecto</label>
        <input
          id="workspace-name"
          className={inputClass}
          value={name}
          onChange={(e) => setName(e.target.value)}
          required
          maxLength={100}
          disabled={busy}
        />
        <p className="field-hint">
          Ambos datos son obligatorios. Serás el dueño de este proyecto, no un administrador público
          del Hub.
        </p>
        <button type="submit" className="local-primary" disabled={busy}>
          {busy ? "Preparando proyecto…" : "Preparar proyecto"}
        </button>
      </form>
    </section>
  );
}
