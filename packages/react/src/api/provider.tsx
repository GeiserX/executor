import { RegistryProvider } from "@effect/atom-react";
import * as React from "react";

import { FrontendErrorReporterProvider, type FrontendErrorReporter } from "./error-reporting";
import {
  ExecutorServerConnectionProvider,
  useExecutorServerConnection,
  type ExecutorServerConnectionInput,
} from "./server-connection";

function ExecutorRegistryProvider(props: React.PropsWithChildren<{ scopeKey?: string | null }>) {
  const connection = useExecutorServerConnection();
  // The registry caches query results, but the query atoms' cache keys don't
  // include the org (the org header is injected per request in
  // transformClient, below the atom layer). Folding the scope into the
  // registry key tears the whole cache down on an org change, so a result
  // fetched for one org can never serve under another org's URL.
  const registryKey = props.scopeKey ? `${connection.key}#${props.scopeKey}` : connection.key;
  return <RegistryProvider key={registryKey}>{props.children}</RegistryProvider>;
}

export const ExecutorProvider = (
  props: React.PropsWithChildren<{
    connection?: ExecutorServerConnectionInput;
    onHandledError?: FrontendErrorReporter;
    /**
     * Org-scoped hosts pass the active org's slug so cached API results are
     * partitioned per org; hosts without org scoping omit it.
     */
    scopeKey?: string | null;
  }>,
) => (
  <FrontendErrorReporterProvider reporter={props.onHandledError}>
    <ExecutorServerConnectionProvider connection={props.connection}>
      <ExecutorRegistryProvider scopeKey={props.scopeKey}>
        {props.children}
      </ExecutorRegistryProvider>
    </ExecutorServerConnectionProvider>
  </FrontendErrorReporterProvider>
);
