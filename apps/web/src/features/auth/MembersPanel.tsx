import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { ErrorBanner } from "../../components/States.js";
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
export function MembersPanel() {
  const { auth } = useHub();
  const cache = useQueryClient();
  const [role, setRole] = useState("collaborator");
  const [secret, setSecret] = useState("");
  const [error, setError] = useState<unknown>(null);
  const root = `/v1/projects/${auth?.projectId}`;
  const request = <T,>(path: string, method = "GET", body?: unknown) => {
    if (!auth) throw new Error("Connect first");
    return membershipRequest<T>(auth.baseUrl, auth.token, `${root}${path}`, method, body);
  };
  const members = useQuery({
    queryKey: ["members", auth?.projectId],
    queryFn: () => request<Member[]>("/members"),
  });
  const invitations = useQuery({
    queryKey: ["invitations", auth?.projectId],
    queryFn: () => request<Invitation[]>("/invitations"),
    retry: false,
  });
  const change = useMutation({
    mutationFn: async (action: { path: string; method: string; body?: unknown }) =>
      request<{ token?: string }>(action.path, action.method, action.body),
    onSuccess: (result) => {
      setSecret(result.token ?? "");
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
      <p className="text-sm text-slate-400">
        Cada persona necesita su token personal. El administrador puede emitir una invitación de un
        solo uso para entrar al proyecto.
      </p>
      {members.data?.map((member) => (
        <div
          key={member.user_id}
          className="flex flex-wrap items-center gap-3 p-3 border border-slate-800 rounded-lg"
        >
          <span>
            {member.username} · {member.role}
          </span>
          {!invitations.isError && member.role !== "owner" && (
            <>
              <select
                aria-label={`Rol de ${member.username}`}
                value={member.role}
                onChange={(e) =>
                  change.mutate({
                    path: `/members/${member.user_id}`,
                    method: "PATCH",
                    body: { role: e.target.value },
                  })
                }
                className="bg-slate-800 p-2 rounded"
              >
                <option value="reader">reader</option>
                <option value="collaborator">collaborator</option>
                <option value="maintainer">maintainer</option>
              </select>
              <button
                type="button"
                onClick={() =>
                  change.mutate({ path: `/members/${member.user_id}`, method: "DELETE" })
                }
                className="text-rose-300"
              >
                Retirar acceso
              </button>
            </>
          )}
        </div>
      ))}
      {!invitations.isError && (
        <>
          <div className="flex gap-3">
            <select
              aria-label="Rol de invitación"
              value={role}
              onChange={(e) => setRole(e.target.value)}
              className="bg-slate-800 p-2 rounded"
            >
              <option value="collaborator">collaborator</option>
              <option value="reader">reader</option>
              <option value="maintainer">maintainer</option>
            </select>
            <button
              type="button"
              disabled={change.isPending}
              onClick={() =>
                change.mutate({ path: "/invitations", method: "POST", body: { role } })
              }
              className="bg-indigo-600 p-2 rounded"
            >
              Crear invitación
            </button>
          </div>
          {secret && (
            <div className="space-y-2">
              <label htmlFor="new-invitation">
                Invitación recién creada (compártela por privado)
              </label>
              <input
                id="new-invitation"
                readOnly
                value={secret}
                className="w-full bg-slate-900 p-2 font-mono"
              />
              <button type="button" onClick={() => setSecret("")}>
                Ocultar
              </button>
            </div>
          )}
          {invitations.data?.map((invite) => (
            <div key={invite.invitation_id} className="flex gap-3 text-sm">
              <span>
                {invite.role} · vence {new Date(invite.expires_at).toLocaleString()} ·{" "}
                {invite.consumed_at ? "usada" : invite.revoked_at ? "revocada" : "pendiente"}
              </span>
              {!invite.consumed_at && !invite.revoked_at && (
                <button
                  type="button"
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
        </>
      )}
    </div>
  );
}
