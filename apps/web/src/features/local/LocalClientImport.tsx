import { LocalClientImportPreviewSchema, LocalClientImportResultSchema } from "@agents-hub/shared";
import { useEffect, useRef, useState } from "react";

type Preview = ReturnType<typeof LocalClientImportPreviewSchema.parse>;
type Result = ReturnType<typeof LocalClientImportResultSchema.parse>;
export function LocalClientImport({
  connection,
  busy,
  run,
}: {
  connection: string;
  busy: boolean;
  run: (work: () => Promise<void>, success: string) => Promise<void>;
}) {
  const [preview, setPreview] = useState<Preview | null>(null);
  const [closed, setClosed] = useState(false);
  const [result, setResult] = useState<Result | null>(null);
  const [destination, setDestination] = useState<string | null>(null);
  const resultOutput = useRef<HTMLOutputElement>(null);
  const heading = useRef<HTMLHeadingElement>(null);
  const trigger = useRef<HTMLButtonElement>(null);
  const [cancelled, setCancelled] = useState(false);
  useEffect(() => {
    if (result && !busy) resultOutput.current?.focus();
  }, [result, busy]);
  useEffect(() => {
    if (preview && !busy) heading.current?.focus();
  }, [preview, busy]);
  useEffect(() => {
    if (cancelled && !preview) {
      trigger.current?.focus();
      setCancelled(false);
    }
  }, [cancelled, preview]);
  const post = async (operation: string, body: unknown) => {
    const response = await fetch(`/local-api/connections/import/${operation}`, {
      method: "POST",
      credentials: "same-origin",
      redirect: "error",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    const value = await response.json();
    if (!response.ok)
      throw new Error(value.error?.message ?? "No se importó la conexión. Solicita otra revisión.");
    return value;
  };
  return (
    <section className="client-import" aria-label="Conexión con Antigravity CLI">
      <button
        type="button"
        ref={trigger}
        disabled={busy}
        onClick={() =>
          void run(async () => {
            setPreview(null);
            setClosed(false);
            setResult(null);
            const reviewed = LocalClientImportPreviewSchema.parse(
              await post("preview", { connection_id: connection }),
            );
            setPreview(reviewed);
            setDestination(reviewed.destination);
          }, "Revisa el destino antes de conectar Antigravity.")
        }
      >
        Conectar con Antigravity CLI
      </button>
      {preview && (
        <>
          <h4 ref={heading} tabIndex={-1}>
            Revisar importación
          </h4>
          <p>
            Antigravity CLI {preview.version ?? "sin versión comprobada"}. Perfil global de este
            usuario.
          </p>
          <p className="break-words">{preview.destination}</p>
          <p>{preview.hint}</p>
          {preview.state !== "blocked" && (
            <>
              <p>
                {preview.count === 1 ? "1 entrada actual" : `${preview.count} entradas actuales`}.
                No cambiaremos las demás ni iniciaremos tu IA.
              </p>
              <label className="connection-confirm">
                <input
                  type="checkbox"
                  disabled={busy}
                  checked={closed}
                  onChange={(event) => setClosed(event.target.checked)}
                />
                Cerré Antigravity y autorizo registrar esta conexión
              </label>
              <button
                type="button"
                className="client-import-confirm"
                disabled={busy || !closed}
                onClick={() =>
                  void run(async () => {
                    const review = preview.preview_id;
                    setPreview(null);
                    setClosed(false);
                    setResult(
                      LocalClientImportResultSchema.parse(
                        await post("apply", {
                          connection_id: connection,
                          preview_id: review,
                          confirm: true,
                          client_closed: true,
                        }),
                      ),
                    );
                  }, "MCP registrado. Reabre o recarga Antigravity y revisa sus permisos.")
                }
              >
                Confirmar importación
              </button>
            </>
          )}
          <button
            type="button"
            disabled={busy}
            onClick={() => {
              setPreview(null);
              setClosed(false);
              setCancelled(true);
            }}
          >
            Cancelar importación
          </button>
        </>
      )}
      {result && (
        <>
          <output ref={resultOutput} tabIndex={-1}>
            MCP registrado, todavía no conectado. Reabre o recarga Antigravity y revisa sus
            permisos.
          </output>
          {result.backup && (
            <details>
              <summary>Copia privada conservada</summary>
              <p className="break-words">{result.backup}</p>
              <p>
                Puede contener secretos de otros MCP. No la compartas; consérvala para recuperación.
              </p>
            </details>
          )}
        </>
      )}
      {destination && !preview && !result && (
        <details>
          <summary>Destino revisado y recuperación</summary>
          <p className="break-words">{destination}</p>
          <p>
            Si falló la importación, cierra Antigravity y revisa sus carpetas .agents-hub-import-*
            junto al archivo. Conserva original.json y no compartas su contenido. Una nueva revisión
            no repara archivos incompletos.
          </p>
        </details>
      )}
    </section>
  );
}
