import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { EmptyState, ErrorBanner, LoadingSpinner } from "../../components/States.js";
import { useHub } from "../../context/HubContext.js";
import { membershipRequest } from "../../lib/api.js";

interface Member {
  user_id: string;
  username: string;
  role: string;
}
interface Invitation {
  invitation_id: string;
  role: string;
  expires_at: string;
  consumed_at: string | null;
  revoked_at: string | null;
}
export function MembersPanel({ active = true }: { active?: boolean }) {
  const { auth } = useHub();
  const cache = useQueryClient();
  const [role, setRole] = useState("collaborator");
  const [secret, setSecret] = useState("");
  const [showInvitation, setShowInvitation] = useState(false);
  const [copied, setCopied] = useState(false);
  const [error, setError] = useState<unknown>(null);
  const roleLabel: Record<string, string> = {
    owner: "Propietario",
    maintainer: "Administrador",
    collaborator: "Colaborador",
    reader: "Lector",
  };
  const root = `/v1/projects/${auth?.projectId}`;
  const request = <T,>(path: string, method = "GET", body?: unknown) => {
    if (!auth) throw new Error("Connect first");
    return membershipRequest<T>(auth.baseUrl, auth.token, `${root}${path}`, method, body);
  };
  const members = useQuery({
    queryKey: ["members", auth?.projectId],
    enabled: Boolean(auth) && active,
    queryFn: () => request<Member[]>("/members"),
  });
  const invitations = useQuery({
    queryKey: ["invitations", auth?.projectId],
    enabled: Boolean(auth) && active,
    queryFn: () => request<Invitation[]>("/invitations"),
    retry: false,
  });
  const change = useMutation({
    mutationFn: async (action: { path: string; method: string; body?: unknown }) =>
      request<{ token?: string }>(action.path, action.method, action.body),
    onSuccess: (result) => {
      setSecret(result.token ?? "");
      setShowInvitation(false);
      setCopied(false);
      setError(null);
      void cache.invalidateQueries({ queryKey: ["members"] });
      void cache.invalidateQueries({ queryKey: ["invitations"] });
    },
    onError: setError,
  });
  return (
    <div className="space-y-4">
      <h2 className="text-xl font-semibold">Miembros e invitaciones</h2>
      <ErrorBanner error={error ?? members.error} />
      <p className="text-sm text-slate-600">
        Cada persona necesita su token personal. El administrador puede emitir una invitación de un
        solo uso para entrar al proyecto.
      </p>
      {members.isPending && <LoadingSpinner message="Cargando miembros..." />}
      {members.data?.length === 0 && (
        <EmptyState
          title="No hay miembros disponibles"
          description="Comprueba tus permisos o vuelve a cargar el proyecto."
        />
      )}
      {members.data?.map((member) => (
        <div key={member.user_id} className="member-row">
          <span>
            <strong>{member.username}</strong>
            <small className="block text-slate-600 mt-1">
              {roleLabel[member.role] ?? member.role}
            </small>
          </span>
          {!invitations.isError && member.role !== "owner" && (
            <>
              <select
                aria-label={`Rol de ${member.username}`}
                value={member.role}
                disabled={change.isPending}
                onChange={(e) =>
                  change.mutate({
                    path: `/members/${member.user_id}`,
                    method: "PATCH",
                    body: { role: e.target.value },
                  })
                }
                className="bg-slate-100 p-2 rounded"
              >
                <option value="reader">Lector</option>
                <option value="collaborator">Colaborador</option>
                <option value="maintainer">Administrador</option>
              </select>
              <button
                type="button"
                disabled={change.isPending}
                onClick={() =>
                  change.mutate({ path: `/members/${member.user_id}`, method: "DELETE" })
                }
                className="text-rose-700"
              >
                Retirar acceso
              </button>
            </>
          )}
        </div>
      ))}
      {!invitations.isError && (
        <section className="invitation-panel" aria-label="Invitaciones al proyecto">
          <h3>Invita a tu equipo</h3>
          <div className="flex flex-wrap gap-3">
            <select
              aria-label="Rol de invitación"
              value={role}
              onChange={(e) => setRole(e.target.value)}
              className="bg-slate-100 p-2 rounded"
            >
              <option value="collaborator">Colaborador</option>
              <option value="reader">Lector</option>
              <option value="maintainer">Administrador</option>
            </select>
            <button
              type="button"
              disabled={change.isPending}
              onClick={() =>
                change.mutate({ path: "/invitations", method: "POST", body: { role } })
              }
              className="bg-blue-600 hover:bg-blue-700 text-white px-4 py-2 rounded-lg text-sm font-medium disabled:opacity-50"
            >
              Crear invitación
            </button>
          </div>
          {secret && (
            <div className="space-y-2 mt-5">
              <label htmlFor="new-invitation">
                Invitación recién creada (compártela por privado)
              </label>
              <input
                id="new-invitation"
                readOnly
                type={showInvitation ? "text" : "password"}
                value={secret}
                className="w-full bg-slate-50 border border-slate-300 rounded-lg p-3 font-mono"
              />
              <div className="flex flex-wrap gap-2">
                <button
                  type="button"
                  className="px-3 text-blue-700"
                  aria-pressed={showInvitation}
                  onClick={() => setShowInvitation((show) => !show)}
                >
                  {showInvitation ? "Ocultar invitación" : "Mostrar invitación"}
                </button>
                <button
                  type="button"
                  className="px-3 text-blue-700"
                  onClick={async () => {
                    try {
                      await navigator.clipboard.writeText(secret);
                      setCopied(true);
                    } catch {
                      setError(
                        new Error(
                          "No se pudo copiar. Muestra la invitación y cópiala manualmente.",
                        ),
                      );
                    }
                  }}
                >
                  Copiar invitación
                </button>
                <button type="button" className="px-3 text-slate-600" onClick={() => setSecret("")}>
                  Descartar de esta vista
                </button>
              </div>
              <output className="text-sm text-emerald-700">
                {copied ? "Invitación copiada. Compártela por privado." : ""}
              </output>
            </div>
          )}
          {invitations.data?.map((invite) => (
            <div key={invite.invitation_id} className="invitation-row">
              <span>
                {roleLabel[invite.role] ?? invite.role} · vence{" "}
                {new Date(invite.expires_at).toLocaleString()} ·{" "}
                {invite.consumed_at ? "usada" : invite.revoked_at ? "revocada" : "pendiente"}
              </span>
              {!invite.consumed_at && !invite.revoked_at && (
                <button
                  type="button"
                  disabled={change.isPending}
                  onClick={() =>
                    change.mutate({
                      path: `/invitations/${invite.invitation_id}`,
                      method: "DELETE",
                    })
                  }
                >
                  Revocar
                </button>
              )}
            </div>
          ))}
        </section>
      )}
    </div>
  );
}
