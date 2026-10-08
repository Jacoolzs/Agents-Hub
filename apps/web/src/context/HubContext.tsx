import type { EventEnvelope } from "@agents-hub/shared";
import { useQueryClient } from "@tanstack/react-query";
import type React from "react";
import { createContext, useContext, useEffect, useRef, useState } from "react";
import { disconnectSession, heartbeatSession } from "../lib/api.js";
import { RealtimeManager } from "../lib/events.js";
import type { AuthSessionConfig, ConnectionStatus } from "../types/index.js";

interface HubContextType {
  auth: AuthSessionConfig | null;
  connectionStatus: ConnectionStatus;
  connect: (config: AuthSessionConfig) => void;
  disconnect: () => void;
  realtimeManager: RealtimeManager | null;
  events: EventEnvelope[];
  syncError: unknown | null;
}

const HubContext = createContext<HubContextType | undefined>(undefined);

export function HubProvider({ children }: { children: React.ReactNode }) {
  const queryClient = useQueryClient();
  const [auth, setAuth] = useState<AuthSessionConfig | null>(null);

  const [connectionStatus, setConnectionStatus] = useState<ConnectionStatus>("disconnected");
  const realtimeRef = useRef<RealtimeManager | null>(null);
  const [events, setEvents] = useState<EventEnvelope[]>([]);
  const [syncError, setSyncError] = useState<unknown | null>(null);
  const pendingDisconnect = useRef(new Map<string, ReturnType<typeof setTimeout>>());

  const connect = (config: AuthSessionConfig) => {
    setAuth(config);
  };

  const disconnect = () => {
    if (realtimeRef.current) {
      realtimeRef.current.destroy();
      realtimeRef.current = null;
    }
    setAuth(null);
    setConnectionStatus("disconnected");
    queryClient.clear();
  };

  useEffect(() => {
    if (!auth) {
      if (realtimeRef.current) {
        realtimeRef.current.destroy();
        realtimeRef.current = null;
      }
      setConnectionStatus("disconnected");
      return;
    }

    const pending = pendingDisconnect.current.get(auth.sessionId);
    if (pending) {
      clearTimeout(pending);
      pendingDisconnect.current.delete(auth.sessionId);
    }

    const manager = new RealtimeManager({
      baseUrl: auth.baseUrl,
      token: auth.token,
      projectId: auth.projectId,
      sessionId: auth.sessionId,
    });

    realtimeRef.current = manager;
    setEvents([]);
    setSyncError(null);
    const unsubError = manager.onRecoveryError(setSyncError);
    const heartbeat = setInterval(() => {
      void heartbeatSession(
        auth.baseUrl,
        auth.token,
        auth.sessionId,
        auth.projectId,
        auth.agentId,
      ).catch(setSyncError);
    }, 30000);

    const unsubStatus = manager.onStatusChange((status) => {
      setConnectionStatus(status);
    });

    const unsubEvent = manager.subscribe((event: EventEnvelope) => {
      setEvents((previous) => [...previous, event]);
      // Invalidate relevant queries when domain events arrive
      switch (event.type) {
        case "message.created":
          break;
        case "status.updated":
          void queryClient.invalidateQueries({ queryKey: ["team-status", auth.projectId] });
          void queryClient.invalidateQueries({ queryKey: ["statuses", auth.projectId] });
          break;
        case "lock.acquired":
        case "lock.released":
        case "lock.expired":
          void queryClient.invalidateQueries({ queryKey: ["locks", auth.projectId] });
          void queryClient.invalidateQueries({ queryKey: ["team-status", auth.projectId] });
          break;
        case "agent.joined":
        case "agent.heartbeat":
        case "agent.left":
        case "agent.idle":
        case "membership.updated":
          void queryClient.invalidateQueries({ queryKey: ["team-status", auth.projectId] });
          break;
      }
    });

    void manager.connect();

    return () => {
      unsubStatus();
      unsubEvent();
      unsubError();
      clearInterval(heartbeat);
      manager.destroy();
      pendingDisconnect.current.set(
        auth.sessionId,
        setTimeout(() => {
          pendingDisconnect.current.delete(auth.sessionId);
          void disconnectSession(
            auth.baseUrl,
            auth.token,
            auth.sessionId,
            auth.projectId,
            auth.agentId,
          ).catch(() => {});
        }, 100),
      );
      if (realtimeRef.current === manager) {
        realtimeRef.current = null;
      }
    };
  }, [auth, queryClient]);

  return (
    <HubContext.Provider
      value={{
        auth,
        connectionStatus,
        connect,
        disconnect,
        realtimeManager: realtimeRef.current,
        events,
        syncError,
      }}
    >
      {children}
    </HubContext.Provider>
  );
}

export function useHub(): HubContextType {
  const context = useContext(HubContext);
  if (!context) {
    throw new Error("useHub must be used within a HubProvider");
  }
  return context;
}
