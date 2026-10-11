import { DeviceMetadataSchema, DevicePreviewSchema, UuidSchema } from "@agents-hub/shared";
import { useEffect, useRef, useState } from "react";

export function readDeviceRequest() {
  const fragment = new URLSearchParams(window.location.hash.slice(1));
  const request = fragment.get("device-request");
  if (request === null) return null;
  window.history.replaceState(null, "", `${window.location.pathname}${window.location.search}`);
  return UuidSchema.safeParse(request).success ? request : null;
}
async function request(endpoint: string, body?: unknown) {
  const response = await fetch(`/v1/web/devices${endpoint}`, {
    credentials: "same-origin",
    redirect: "error",
    ...(body
      ? {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(body),
        }
      : {}),
  });
  const result = await response.json();
  if (!response.ok)
    throw new Error(
      "No se completó la revisión. Comprueba tu sesión y revisa la solicitud otra vez.",
    );
  return result.data;
}
export function DeviceConnectionPanel({
  initialRequest = "",
  onClose,
}: { initialRequest?: string; onClose?: () => void }) {
  const [id, setId] = useState(initialRequest);
  const [preview, setPreview] = useState<ReturnType<typeof DevicePreviewSchema.parse> | null>(null);
  const [devices, setDevices] = useState<ReturnType<typeof DeviceMetadataSchema.parse>[]>([]);
  const [busy, setBusy] = useState(false);
  const [confirmed, setConfirmed] = useState(false);
  const [revoking, setRevoking] = useState<string | null>(null);
  const [notice, setNotice] = useState("");
  const [error, setError] = useState("");
  const revision = useRef(0);
  const heading = useRef<HTMLHeadingElement>(null);
  useEffect(() => {
    revision.current++;
    setPreview(null);
    setConfirmed(false);
    setNotice("");
    let active = true;
    void request("")
      .then((data) => {
        if (active) setDevices(DeviceMetadataSchema.array().parse(data));
      })
      .catch(() => {
        if (active) setError("No se pudo consultar los dispositivos. Actualiza la lista.");
      });
    return () => {
      active = false;
      revision.current++;
    };
  }, []);
  useEffect(() => {
    if (preview || notice) heading.current?.focus();
  }, [preview, notice]);
  const act = async (work: () => Promise<void>) => {
    if (busy) return;
    setBusy(true);
    setError("");
    try {
      await work();
    } catch (error) {
      setPreview(null);
      setConfirmed(false);
      setError(error instanceof Error ? error.message : "Revisa otra vez.");
    } finally {
      setBusy(false);
    }
  };
  return (
    <section className="local-card connection-assistant" aria-labelledby="device-title">
      <h2 id="device-title" ref={heading} tabIndex={-1}>
        Dispositivos e IA
      </h2>
      <p>
        Autoriza sólo una solicitud que tú acabas de iniciar en un dispositivo que reconoces. Un
        nombre no demuestra que sea confiable.
      </p>
      <form
        onSubmit={(event) => {
          event.preventDefault();
          const current = ++revision.current;
          setPreview(null);
          setConfirmed(false);
          setNotice("");
          void act(async () => {
            const data = DevicePreviewSchema.parse(await request("/preview", { request_id: id }));
            if (revision.current === current) setPreview(data);
          });
        }}
      >
        <label htmlFor="device-request-id">Solicitud del compañero</label>
        <input
          id="device-request-id"
          required
          value={id}
          disabled={busy}
          onChange={(event) => {
            revision.current++;
            setId(event.target.value);
            setPreview(null);
            setConfirmed(false);
          }}
        />
        <button type="submit" disabled={busy}>
          Revisar solicitud
        </button>
      </form>
      {preview && (
        <div>
          <h3>{preview.label}</h3>
          <dl>
            <dt>Persona</dt>
            <dd>{preview.profile.user.username}</dd>
            <dt>Proyecto</dt>
            <dd>{preview.profile.project.name}</dd>
            <dt>Permiso</dt>
            <dd>{preview.profile.project.role}</dd>
          </dl>
          <p className="break-words">Proyecto: {preview.profile.project.project_id}</p>
          <p>
            La IA podrá actuar con tus permisos vigentes de este proyecto. Revisión válida hasta{" "}
            {new Date(preview.approval.expires_at).toLocaleTimeString()}.
          </p>
          <label className="connection-confirm">
            <input
              type="checkbox"
              checked={confirmed}
              disabled={busy}
              onChange={(event) => setConfirmed(event.target.checked)}
            />
            Reconozco este dispositivo y este proyecto
          </label>
          <button
            type="button"
            disabled={busy || !confirmed}
            onClick={() => {
              const reviewed = preview;
              const current = revision.current;
              void act(async () => {
                await request("/approve", {
                  request_id: reviewed.request_id,
                  confirm: true,
                  approval: reviewed.approval,
                });
                if (revision.current === current) {
                  setPreview(null);
                  setConfirmed(false);
                  setNotice("Dispositivo aprobado. Vuelve al compañero para canjear y guardar.");
                }
              });
            }}
          >
            Autorizar dispositivo
          </button>
          <button
            type="button"
            disabled={busy}
            onClick={() => {
              revision.current++;
              setPreview(null);
              setConfirmed(false);
            }}
          >
            Cancelar revisión
          </button>
        </div>
      )}
      {error && <p role="alert">{error}</p>}
      {notice && <output>{notice}</output>}
      <h3>Credenciales de este proyecto</h3>
      <button
        type="button"
        disabled={busy}
        onClick={() =>
          void act(async () => setDevices(DeviceMetadataSchema.array().parse(await request(""))))
        }
      >
        Actualizar dispositivos
      </button>
      <ul className="connection-list">
        {devices.map((device) => (
          <li key={device.token_id}>
            <strong>{device.label}</strong>
            <p className="break-words">{device.token_id}</p>
            <p>
              {device.revoked_at
                ? "Revocada"
                : `Vence ${new Date(device.expires_at).toLocaleString()}`}
            </p>
            {!device.revoked_at &&
              (revoking === device.token_id ? (
                <>
                  <p>Revocar corta el acceso MCP de este dispositivo, no tu cuenta humana.</p>
                  <button
                    type="button"
                    disabled={busy}
                    onClick={() =>
                      void act(async () => {
                        await request(`/${device.token_id}/revoke`, { confirm: true });
                        setRevoking(null);
                        setDevices(DeviceMetadataSchema.array().parse(await request("")));
                      })
                    }
                  >
                    Confirmar revocación
                  </button>
                  <button type="button" disabled={busy} onClick={() => setRevoking(null)}>
                    Cancelar revocación
                  </button>
                </>
              ) : (
                <button type="button" disabled={busy} onClick={() => setRevoking(device.token_id)}>
                  Revocar dispositivo
                </button>
              ))}
          </li>
        ))}
      </ul>
      {onClose && (
        <button type="button" disabled={busy} onClick={onClose}>
          Volver al proyecto
        </button>
      )}
    </section>
  );
}
