import type { EventEnvelope } from "@agents-hub/shared";
import { useQueryClient } from "@tanstack/react-query";
import type React from "react";
import { createContext, useContext, useEffect, useRef, useState } from "react";
import { RealtimeManager } from "../lib/events.js";
import type { AuthSessionConfig, ConnectionStatus } from "../types/index.js";

interface HubContextType {
  auth: AuthSessionConfig | null;
  connectionStatus: ConnectionStatus;
  connect: (config: AuthSessionConfig) => void;
  disconnect: () => void;
  realtimeManager: RealtimeManager | null;
}

const HubContext = createContext<HubContextType | undefined>(undefined);

export function HubProvider({ children }: { children: React.ReactNode }) {
  const queryClient = useQueryClient();
  const [auth, setAuth] = useState<AuthSessionConfig | null>(null);

  const [connectionStatus, setConnectionStatus] = useState<ConnectionStatus>("disconnected");
  const realtimeRef = useRef<RealtimeManager | null>(null);

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

    const manager = new RealtimeManager({
      baseUrl: auth.baseUrl,
      token: auth.token,
      projectId: auth.projectId,
      sessionId: auth.sessionId,
    });

    realtimeRef.current = manager;

    const unsubStatus = manager.onStatusChange((status) => {
      setConnectionStatus(status);
    });

    const unsubEvent = manager.subscribe((event: EventEnvelope) => {
      // Invalidate relevant queries when domain events arrive
      switch (event.type) {
        case "message.created":
          void queryClient.invalidateQueries({ queryKey: ["inbox", auth.projectId] });
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
          void queryClient.invalidateQueries({ queryKey: ["team-status", auth.projectId] });
          break;
      }
    });

    void manager.connect();

    return () => {
      unsubStatus();
      unsubEvent();
      manager.destroy();
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
