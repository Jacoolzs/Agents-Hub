import { LocalConnectionReportSchema } from "@agents-hub/shared";
import { useEffect, useRef, useState } from "react";
import { LocalClientImport } from "./LocalClientImport";

type Report = ReturnType<typeof LocalConnectionReportSchema.parse>;
const checkLabels: Record<string, string> = {
  runtime: "Runtime",
  build: "Adaptador",
  connection: "Almacén seguro",
  url: "Dirección del Hub",
  readiness: "Disponibilidad",
  compatibility: "Compatibilidad",
  identity: "Credencial",
  membership: "Proyecto",
  listener: "Escucha de mensajes",
};

type Connection = {
  connection_id: string;
  request_id: string;
  label: string;
  hub_url: string;
  state: string;
  token_id: string | null;
  file: string | null;
  config: unknown;
};
async function request(path = "", body?: unknown) {
  const response = await fetch(`/local-api/connections${path}`, {
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
  if (!response.ok) throw new Error(result.error?.message ?? "No se completó la conexión.");
  return result;
}
export function LocalConnectionPanel({
  busy: processing,
  run,
}: { busy: boolean; run: (work: () => Promise<void>, success: string) => Promise<void> }) {
  const [url, setUrl] = useState("");
  const [label, setLabel] = useState("Mi PC");
  const [connections, setConnections] = useState<Connection[]>([]);
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(true);
  const [reports, setReports] = useState<Record<string, Report>>({});
  const busy = processing || loading;
  const [selected, setSelected] = useState<string | null>(null);
  const [confirm, setConfirm] = useState(false);
  const heading = useRef<HTMLHeadingElement>(null);
  const refresh = async () => {
    setConnections(await request());
    setError("");
  };
  useEffect(() => {
    let active = true;
    void request()
      .then((value) => {
        if (active) setConnections(value);
      })
      .catch(() => {
        if (active) setError("No se pudo consultar las conexiones. Pulsa Actualizar.");
      })
      .finally(() => {
        if (active) setLoading(false);
      });
    return () => {
      active = false;
    };
  }, []);
  useEffect(() => {
    if (selected && !busy) heading.current?.focus();
  }, [selected, busy]);
  const download = (config: unknown) => {
    const blob = new Blob([JSON.stringify(config, null, 2)], { type: "application/json" });
    const href = URL.createObjectURL(blob);
    const anchor = document.createElement("a");
    anchor.href = href;
    anchor.download = "agents-hub-mcp.json";
    anchor.click();
    URL.revokeObjectURL(href);
  };
  return (
    <section className="local-card connection-assistant" aria-labelledby="connection-title">
      <h2 id="connection-title" ref={heading} tabIndex={-1}>
        Conectar mi IA
      </h2>
      <p>
        Prepara la conexión en este PC. El portal confirma tu identidad; tu credencial queda
        protegida por el sistema operativo.
      </p>
      <ol className="connection-steps">
        <li>Solicitar</li>
        <li>Confirmar en el portal</li>
        <li>Guardar en este PC</li>
      </ol>
      <form
        onSubmit={(event) => {
          event.preventDefault();
          setError("");
          void run(async () => {
            const result = await request("/start", { hub_url: url, label });
            setSelected(result.connection_id);
            setConfirm(false);
            await refresh();
          }, "Solicitud preparada. Abre el portal para revisarla.");
        }}
      >
        <label htmlFor="connection-url">URL del Hub (obligatoria)</label>
        <input
          id="connection-url"
          type="url"
          required
          value={url}
          onChange={(event) => setUrl(event.target.value)}
          placeholder="https://tu-hub"
          autoComplete="url"
          disabled={busy}
        />
        <label htmlFor="connection-label">Nombre de este dispositivo (obligatorio)</label>
        <input
          id="connection-label"
          required
          maxLength={80}
          value={label}
          onChange={(event) => setLabel(event.target.value)}
          disabled={busy}
        />
        <button type="submit" disabled={busy}>
          Preparar conexión
        </button>
      </form>
      {error && <p role="alert">{error}</p>}
      {busy && <output>Completando la operación. Mantén el compañero abierto.</output>}
      <button
        type="button"
        disabled={busy}
        onClick={() => void run(refresh, "Conexiones actualizadas.")}
      >
        Actualizar conexiones
      </button>
      <ul className="connection-list">
        {connections.map((connection) => (
          <li key={connection.connection_id}>
            <h3>{connection.label}</h3>
            <p className="break-words">{connection.hub_url}</p>
            {connection.state === "waiting" ? (
              <>
                <p>
                  Abre el portal, inicia tu sesión y revisa esta solicitud. Después vuelve aquí.
                </p>
                <a
                  href={`${connection.hub_url}/#device-request=${connection.request_id}`}
                  target="_blank"
                  rel="noopener noreferrer"
                >
                  Revisar en el portal
                </a>
                <label className="connection-confirm">
                  <input
                    type="checkbox"
                    checked={selected === connection.connection_id && confirm}
                    disabled={busy}
                    onChange={(event) => {
                      setSelected(connection.connection_id);
                      setConfirm(event.target.checked);
                    }}
                  />
                  Ya confirmé esta solicitud en el portal
                </label>
                <p>
                  Guardar intenta el canje una sola vez. Si aún no confirmaste, tendrás que crear
                  otra solicitud.
                </p>
                <button
                  type="button"
                  disabled={busy || selected !== connection.connection_id || !confirm}
                  onClick={() =>
                    void run(async () => {
                      try {
                        await request("/finish", {
                          connection_id: connection.connection_id,
                          confirm: true,
                        });
                      } finally {
                        setConfirm(false);
                        await refresh();
                      }
                    }, "Conexión guardada de forma segura.")
                  }
                >
                  Canjear y guardar
                </button>
              </>
            ) : connection.state === "saved" ? (
              <>
                <p>
                  Guardada. Descarga la configuración MCP genérica e impórtala en tu cliente.
                  Reinicia el MCP después de cambiar la conexión.
                </p>
                <button type="button" disabled={busy} onClick={() => download(connection.config)}>
                  Descargar configuración MCP
                </button>
                <LocalClientImport connection={connection.connection_id} busy={busy} run={run} />
                <button
                  type="button"
                  disabled={busy}
                  onClick={() =>
                    void run(async () => {
                      setReports((previous) => {
                        const next = { ...previous };
                        delete next[connection.connection_id];
                        return next;
                      });
                      const result = LocalConnectionReportSchema.parse(
                        await request("/diagnose", {
                          connection_id: connection.connection_id,
                        }),
                      );
                      setReports((previous) => ({
                        ...previous,
                        [connection.connection_id]: result,
                      }));
                    }, "Comprobación terminada. Revisa el resultado junto a tu conexión.")
                  }
                >
                  Comprobar conexión
                </button>
                {reports[connection.connection_id] && (
                  <section aria-label={`Diagnóstico de ${connection.label}`}>
                    <output>
                      {reports[connection.connection_id]?.ok
                        ? "Comprobaciones de acceso correctas. La escucha aún no se ha comprobado."
                        : "La conexión necesita atención. Sigue las indicaciones antes de usarla."}
                    </output>
                    <p>Resultado de esta comprobación puntual; no se actualiza automáticamente.</p>
                    <ul>
                      {reports[connection.connection_id]?.checks.map((check) => (
                        <li key={check.name}>
                          <strong>
                            {checkLabels[check.name] ?? check.name}:{" "}
                            {check.status === "ok"
                              ? "Correcto"
                              : check.status === "error"
                                ? "Revisar"
                                : "Sin comprobar"}
                          </strong>
                          <p>{check.hint}</p>
                        </li>
                      ))}
                    </ul>
                  </section>
                )}
                <details>
                  <summary>Referencia y compatibilidad</summary>
                  <p className="break-words">{connection.file}</p>
                  <p>
                    No contiene el token. La importación depende de tu cliente; no reemplazamos sus
                    archivos. Si revocaste o venció el acceso, empareja de nuevo.
                  </p>
                </details>
              </>
            ) : (
              <>
                <p>
                  Requiere recuperación. Revisa o revoca el dispositivo en el portal y prepara otra
                  conexión; no repetiremos el canje.
                </p>
                {connection.token_id && (
                  <p className="break-words">Credencial: {connection.token_id}</p>
                )}
                <a href={connection.hub_url} target="_blank" rel="noopener noreferrer">
                  Abrir portal para revocar
                </a>
              </>
            )}
          </li>
        ))}
      </ul>
      {!loading && !connections.length && <p>Aún no hay conexiones preparadas en este PC.</p>}
    </section>
  );
}
