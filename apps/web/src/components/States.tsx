import type React from "react";
import { ApiClientError } from "../lib/api.js";

export function LoadingSpinner({ message = "Cargando..." }: { message?: string }) {
  return (
    <div className="flex flex-col items-center justify-center p-8 space-y-3 text-slate-400">
      <div className="w-8 h-8 border-2 border-indigo-500 border-t-transparent rounded-full animate-spin" />
      <span className="text-sm">{message}</span>
    </div>
  );
}

export function EmptyState({
  title,
  description,
  action,
}: {
  title: string;
  description: string;
  action?: React.ReactNode;
}) {
  return (
    <div className="flex flex-col items-center justify-center p-8 text-center border border-dashed border-slate-800 rounded-lg bg-slate-900/30">
      <h3 className="text-base font-semibold text-slate-300">{title}</h3>
      <p className="mt-1 text-sm text-slate-400 max-w-sm">{description}</p>
      {action && <div className="mt-4">{action}</div>}
    </div>
  );
}

export function ErrorBanner({
  error,
  onDismiss,
}: {
  error: unknown;
  onDismiss?: () => void;
}) {
  if (!error) return null;

  let code = "ERROR";
  let message = "Ha ocurrido un error inesperado";
  let requestId: string | undefined;

  if (error instanceof ApiClientError) {
    code = error.code;
    message = error.message;
    requestId = error.requestId;
  } else if (error instanceof Error) {
    message = error.message;
  }

  const isRateLimit = code === "RATE_LIMITED";

  return (
    <div
      role="alert"
      className={`p-4 rounded-lg border text-sm flex items-start justify-between ${
        isRateLimit
          ? "bg-amber-950/40 border-amber-800 text-amber-200"
          : "bg-rose-950/40 border-rose-800 text-rose-200"
      }`}
    >
      <div className="space-y-1">
        <div className="font-semibold flex items-center gap-2">
          <span className="px-1.5 py-0.5 rounded text-xs bg-slate-900/60 font-mono">{code}</span>
          <span>{isRateLimit ? "Límite de peticiones alcanzado" : message}</span>
        </div>
        {isRateLimit && (
          <p className="text-xs text-amber-300/80">
            Demasiadas peticiones enviadas al servidor. Por favor espera unos momentos antes de
            reintentar.
          </p>
        )}
        {requestId && <p className="text-xs text-slate-400 font-mono">Req ID: {requestId}</p>}
      </div>
      {onDismiss && (
        <button
          type="button"
          onClick={onDismiss}
          className="text-slate-400 hover:text-slate-200 text-sm ml-4 font-bold"
        >
          ✕
        </button>
      )}
    </div>
  );
}
