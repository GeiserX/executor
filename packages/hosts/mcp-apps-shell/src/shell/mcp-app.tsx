import React from "react";
import { createRoot } from "react-dom/client";
import { useApp } from "@modelcontextprotocol/ext-apps/react";
import { McpAppsShell } from "./shell-app";

function ConnectedShellApp() {
  const { app, error: connectionError } = useApp({
    appInfo: { name: "Executor Shell", version: "1.0.0" },
    capabilities: {},
  });

  if (connectionError) {
    return (
      <div className="flex items-center justify-center h-full p-4">
        <div className="text-destructive text-sm">Connection error: {connectionError.message}</div>
      </div>
    );
  }

  if (!app) {
    return (
      <div className="flex items-center justify-center h-full p-4">
        <div className="text-sm text-muted-foreground">Connecting</div>
      </div>
    );
  }

  return <McpAppsShell app={app} />;
}

createRoot(document.getElementById("root")!).render(
  <React.StrictMode>
    <ConnectedShellApp />
  </React.StrictMode>,
);
