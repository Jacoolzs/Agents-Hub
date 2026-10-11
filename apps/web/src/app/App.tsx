import React from "react";
import { useEffect, useState } from "react";
import { Shell } from "../components/Shell.js";
import { useHub } from "../context/HubContext.js";
import {
  DeviceConnectionPanel,
  readDeviceRequest,
} from "../features/auth/DeviceConnectionPanel.js";
import { MembersPanel } from "../features/auth/MembersPanel.js";
import { WebAccessView, hasWebEntry, readWebEntry } from "../features/auth/WebAccessView.js";
import { LocksPanel } from "../features/locks/LocksPanel.js";
import { MessageFeed } from "../features/messages/MessageFeed.js";
import { AgentsPanel } from "../features/status/AgentsPanel.js";

const initialDeviceRequest = readDeviceRequest();

export function AppContent() {
  const { auth } = useHub();
  const [entryRevision, setEntryRevision] = useState(0);
  const [deviceRequest, setDeviceRequest] = useState(initialDeviceRequest);
  useEffect(() => {
    const onHashChange = () => {
      if (readWebEntry()) setEntryRevision((value) => value + 1);
      const device = readDeviceRequest();
      if (device) setDeviceRequest(device);
    };
    window.addEventListener("hashchange", onHashChange);
    return () => window.removeEventListener("hashchange", onHashChange);
  }, []);

  if (!auth || hasWebEntry() || (deviceRequest && !auth.browserUser)) {
    return (
      <WebAccessView key={entryRevision} onCancel={() => setEntryRevision((value) => value + 1)} />
    );
  }

  if (deviceRequest)
    return (
      <main className="local-main">
        <DeviceConnectionPanel
          key={`${auth.userId}/${auth.projectId}/${auth.sessionId}/${deviceRequest}`}
          initialRequest={deviceRequest}
          onClose={() => setDeviceRequest(null)}
        />
      </main>
    );

  return (
    <Shell>
      {{
        messages: (active) => <MessageFeed active={active} />,
        agents: (active) => <AgentsPanel active={active} />,
        locks: (active) => <LocksPanel active={active} />,
        members: (active) => (
          <>
            <MembersPanel active={active} />
            {active && auth.browserUser && (
              <DeviceConnectionPanel key={`${auth.userId}/${auth.projectId}/${auth.sessionId}`} />
            )}
          </>
        ),
      }}
    </Shell>
  );
}
