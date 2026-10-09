import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import React from "react";
import ReactDOM from "react-dom/client";
import { AppContent } from "./app/App.js";
import { HubProvider } from "./context/HubContext.js";
import { LocalControlView } from "./features/local/LocalControlView.js";
import "./index.css";

const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      retry: 1,
      refetchOnWindowFocus: false,
      staleTime: 2000,
    },
  },
});

const rootElement = document.getElementById("root");
if (rootElement) {
  ReactDOM.createRoot(rootElement).render(
    <React.StrictMode>
      <QueryClientProvider client={queryClient}>
        {new URLSearchParams(window.location.search).has("local-control") ? (
          <LocalControlView />
        ) : (
          <HubProvider>
            <AppContent />
          </HubProvider>
        )}
      </QueryClientProvider>
    </React.StrictMode>,
  );
}
