import { LocalInstallationResultSchema, LocalInstallationSchema } from "@agents-hub/shared";
import React, { useEffect, useRef, useState } from "react";

async function readInstallation(method = "GET", body?: unknown) {
  const response = await fetch("/local-api/installation", {
    method,
    credentials: "same-origin",
    redirect: "error",
    ...(body
      ? { headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) }
      : {}),
  });
  const result = await response.json();
  if (!response.ok)
    throw new Error(result.error?.message ?? "No se pudo comprobar la instalación.");
  return result;
}
export function LocalInstallationPanel({
  busy,
  run,
}: { busy: boolean; run: (work: () => Promise<void>, success: string) => Promise<void> }) {
  const [plan, setPlan] = useState<ReturnType<typeof LocalInstallationSchema.parse> | null>(null);
  const [error, setError] = useState("");
  const [confirm, setConfirm] = useState(false);
  const [desktop, setDesktop] = useState(false);
  const [result, setResult] = useState<ReturnType<
    typeof LocalInstallationResultSchema.parse
  > | null>(null);
  const trigger = useRef<HTMLButtonElement>(null);
  const cancel = useRef<HTMLButtonElement>(null);
  const heading = useRef<HTMLHeadingElement>(null);
  useEffect(() => {
    let active = true;
    void readInstallation()
      .then((value) => {
        if (active) setPlan(LocalInstallationSchema.parse(value));
      })
      .catch((e: Error) => {
        if (active) setError(e.message);
      });
    return () => {
      active = false;
    };
  }, []);
  useEffect(() => {
    if (confirm) cancel.current?.focus();
    else if (result) heading.current?.focus();
  }, [confirm, result]);
  if (plan?.state === "unavailable") return null;
  return (
    <section className="local-section" aria-labelledby="install-title" aria-busy={busy}>
      <h2 id="install-title" ref={heading} tabIndex={-1}>
        {result ? "Agents-Hub instalado en este PC" : "Instalar en este PC"}
      </h2>
      {error ? (
        <p role="alert">{error} Reabre un paquete completo para comprobarlo de nuevo.</p>
      ) : !plan ? (
        <p>Comprobando la instalación…</p>
      ) : result ? (
        <>
          <p>
            Busca <strong>{result.label}</strong> en Inicio o Aplicaciones
            {desktop ? " y en el escritorio" : ""}. La consola seguirá visible; puedes cerrar
            Agents-Hub desde el panel.
          </p>
          <p>
            Cierra el compañero actual y ábrelo desde ese acceso para usar la copia instalada. Tu
            Hub no se reinició y tus datos se conservan.
          </p>
          <details>
            <summary>Ver accesos creados</summary>
            <ul>
              {result.shortcuts.map((shortcut) => (
                <li key={shortcut} className="break-words">
                  {shortcut}
                </li>
              ))}
            </ul>
          </details>
        </>
      ) : (
        <>
          <p>
            Guarda esta versión en tu usuario y crea un acceso para volver sin buscar la carpeta
            descargada. No requiere permisos de administrador.
          </p>
          <details>
            <summary>Carpetas del programa y los datos</summary>
            <p className="break-words">Programa: {plan.destination}</p>
            <p className="break-words">Datos conservados: {plan.data}</p>
          </details>
          {plan.state === "installed" && (
            <p>
              Ya hay una copia de esta versión. Se comprobará y reutilizará; los accesos ajenos no
              se reemplazan.
            </p>
          )}
          {plan.state === "partial" ? (
            <p role="alert">
              Hay una copia incompleta o incompatible. Se conservó sin reemplazar. Revisa la carpeta
              del programa o utiliza otro paquete antes de instalar esta versión.
            </p>
          ) : confirm ? (
            <>
              <p>
                Se creará un acceso en Inicio o Aplicaciones. No se iniciará automáticamente con el
                sistema, no se borrarán versiones anteriores ni se moverán tus datos.
              </p>
              <label className="flex items-center gap-3 py-3">
                <input
                  type="checkbox"
                  checked={desktop}
                  onChange={(event) => setDesktop(event.target.checked)}
                  disabled={busy}
                />
                Crear también un acceso en el escritorio
              </label>
              <div className="local-actions">
                <button
                  ref={cancel}
                  type="button"
                  disabled={busy}
                  onClick={() => {
                    setConfirm(false);
                    requestAnimationFrame(() => trigger.current?.focus());
                  }}
                >
                  Cancelar instalación
                </button>
                <button
                  type="button"
                  className="local-primary"
                  disabled={busy}
                  onClick={() =>
                    void run(async () => {
                      const installed = LocalInstallationResultSchema.parse(
                        await readInstallation("POST", { confirm: true, desktop }),
                      );
                      setResult(installed);
                      setConfirm(false);
                    }, "Instalación y accesos completos. Tus datos se conservan.")
                  }
                >
                  {busy ? "Instalando y comprobando…" : "Confirmar instalación y accesos"}
                </button>
              </div>
            </>
          ) : (
            <button ref={trigger} type="button" disabled={busy} onClick={() => setConfirm(true)}>
              Revisar instalación
            </button>
          )}
        </>
      )}
    </section>
  );
}
