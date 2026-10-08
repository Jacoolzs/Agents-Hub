import React from "react";
import { Shell } from "../components/Shell.js";
import { useHub } from "../context/HubContext.js";
import { ConnectView } from "../features/auth/ConnectView.js";
import { MembersPanel } from "../features/auth/MembersPanel.js";
import { LocksPanel } from "../features/locks/LocksPanel.js";
import { MessageFeed } from "../features/messages/MessageFeed.js";
import { AgentsPanel } from "../features/status/AgentsPanel.js";

export function AppContent() {
  const { auth } = useHub();

  if (!auth) {
    return <ConnectView />;
  }

  return (
    <Shell>
      {{
        messages: <MessageFeed />,
        agents: <AgentsPanel />,
        locks: <LocksPanel />,
        members: <MembersPanel />,
      }}
    </Shell>
  );
}
