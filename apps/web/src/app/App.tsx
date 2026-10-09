import React from "react";
import { useEffect, useState } from "react";
import { Shell } from "../components/Shell.js";
import { useHub } from "../context/HubContext.js";
import { MembersPanel } from "../features/auth/MembersPanel.js";
import { WebAccessView, hasWebEntry, readWebEntry } from "../features/auth/WebAccessView.js";
import { LocksPanel } from "../features/locks/LocksPanel.js";
import { MessageFeed } from "../features/messages/MessageFeed.js";
import { AgentsPanel } from "../features/status/AgentsPanel.js";

export function AppContent() {
  const { auth } = useHub();
  const [entryRevision, setEntryRevision] = useState(0);
  useEffect(() => {
    const onHashChange = () => {
      if (readWebEntry()) setEntryRevision((value) => value + 1);
    };
    window.addEventListener("hashchange", onHashChange);
    return () => window.removeEventListener("hashchange", onHashChange);
  }, []);

  if (!auth || hasWebEntry()) {
    return (
      <WebAccessView key={entryRevision} onCancel={() => setEntryRevision((value) => value + 1)} />
    );
  }

  return (
    <Shell>
      {{
        messages: (active) => <MessageFeed active={active} />,
        agents: (active) => <AgentsPanel active={active} />,
        locks: (active) => <LocksPanel active={active} />,
        members: (active) => <MembersPanel active={active} />,
      }}
    </Shell>
  );
}
