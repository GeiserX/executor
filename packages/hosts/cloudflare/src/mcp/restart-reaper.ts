// ---------------------------------------------------------------------------
// Restart reaper — turn a Durable Object reset that killed an in-flight tool
// call into a prompt, replayable JSON-RPC error instead of a silent hang.
//
// ## The failure this exists for
//
// A deploy (or any isolate reset) destroys the DO mid-execution. The work is
// gone and unrecoverable: the result was never produced, so MCP stream
// resumability has nothing to replay. Worse, the client's POST SSE stream
// closes CLEANLY, so the MCP client neither errors nor reconnects — it hangs
// until its own request timeout with no server-side exception and no exported
// span. Production traces show the reset itself (`Durable Object reset because
// its code was updated`) only on session-establishment spans; the killed
// execution never exports anything at all.
//
// ## The two halves of the fix
//
// 1. A PRIMING EVENT on every POST tools/call stream, so the MCP TS SDK's
//    `hasPrimingEvent` is set and it will actually reconnect a broken POST
//    stream (`canResume = isReconnectable || hasPrimingEvent` in the SDK's
//    `_handleSseStream`). That half already ships in
//    `patches/agents@0.17.3.patch` (`emitPrimingEvent`); without it the error
//    this module writes would never be collected by anyone.
// 2. This reaper. On DO start, any POST stream that still has persisted
//    in-flight request ids has, by definition, not been answered — its
//    execution died with the previous isolate. We append a JSON-RPC error into
//    that stream's event log and drop the request-id key, so the reconnecting
//    client replays from `last-event-id` and receives a real error in seconds.
//
// Priming alone does NOT fix the hang (the reconnect finds nothing to replay);
// the reaper alone is never collected (the client never reconnects). Both are
// required.
//
// ## Scope
//
// This converts a silent hang into a prompt visible error. It does NOT recover
// the lost work — that is durable execution, and is deliberately out of scope.
// ---------------------------------------------------------------------------

import { Cause, Data, Effect, Exit } from "effect";
import type { EventStore } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import type { JSONRPCMessage, RequestId } from "@modelcontextprotocol/sdk/types.js";

/**
 * The agents SDK's fixed stream id for the standalone GET listen stream. Its
 * events are deliberately never auto-cleared and it carries no POST request
 * ids, so it can never look orphaned — but it is skipped explicitly rather
 * than relied on to be absent, so a future SDK change that starts recording
 * request ids against it cannot make the reaper cancel a live listen stream.
 */
const STANDALONE_STREAM_ID = "_GET_stream";

/**
 * JSON-RPC error code for a reaped request. `-32001` is the MCP SDK's
 * `RequestTimeout`: the client-visible semantics are exactly right (the request
 * will never be answered) and every MCP client already understands it, whereas a
 * private code lands in generic error handling.
 */
export const RESTART_REAP_ERROR_CODE = -32001;

/**
 * The client-facing message for a reaped request.
 *
 * ## Retry safety — deliberately does NOT say "please retry"
 *
 * `execute` runs ARBITRARY user code. An execution killed by an isolate reset
 * may have already performed real, non-idempotent side effects — a charge, an
 * email, a write — before it died. The server cannot know how far it got: the
 * only evidence was in the dead isolate. A message that invites a retry invites
 * duplicating those effects, and an LLM client will take that invitation.
 *
 * So the message states what is known (the run was interrupted, the outcome is
 * unknown, effects may have been applied) and hands the retry decision to the
 * caller instead of pre-approving it. `data.retrySafe: false` carries the same
 * fact machine-readably.
 */
export const RESTART_REAP_ERROR_MESSAGE =
  "Execution was interrupted by a server restart and its outcome is unknown. " +
  "Any side effects it had already performed have been applied. " +
  "Do not retry automatically — verify the current state first, then re-run only if it is safe.";

export class McpRestartReapError extends Data.TaggedError("McpRestartReapError")<{
  readonly streamId: string;
  readonly requestId: RequestId;
  readonly cause: unknown;
}> {}

/**
 * Raised (and immediately caught) purely so the reap ends its span as a
 * FAILURE. Killed executions currently export no span at all, so their
 * invisibility in o11y is half the reported bug; failing the span is what
 * makes "a deploy ate N tool calls" a queryable error rather than an absence.
 */
export class McpRestartReapedExecutions extends Data.TaggedError("McpRestartReapedExecutions")<{
  readonly streamCount: number;
  readonly requestCount: number;
}> {
  override get message(): string {
    return `Reaped ${this.requestCount} in-flight MCP request(s) across ${this.streamCount} stream(s) killed by a server restart`;
  }
}

/**
 * The narrow slice of the agents `McpAgent` the reaper drives.
 *
 * THIS IS THE SEAM. `getOpenStreamRequestIds` is `@internal` in the agents SDK
 * (added by `patches/agents@0.17.3.patch`) and the event store's `storeEvent`
 * is public-ish. Nothing else in this module knows a storage key or prefix — no
 * `__mcp_stream_reqs__:`, no `__mcp_event__:<streamId>:<seqHex>`, no
 * zero-padding. An `agents` upgrade that moves this surface breaks HERE, at one
 * structurally-typed interface with a compile error, rather than silently
 * reading nothing from hand-rolled key scans.
 */
export interface RestartReapAgent {
  readonly getOpenStreamRequestIds: () => Promise<
    ReadonlyArray<{ readonly streamId: string; readonly requestIds: ReadonlyArray<RequestId> }>
  >;
  readonly deleteStreamRequestIds: (streamId: string) => Promise<void>;
}

/** The event-store slice the reaper needs: append one message to a stream. */
export type RestartReapEventStore = Pick<EventStore, "storeEvent">;

/**
 * Structurally narrow an unknown value to {@link RestartReapAgent}.
 *
 * The `agents` type declarations do not describe `getOpenStreamRequestIds`
 * (the patch adds it to the JS dist only), so this is the single place the
 * shape is asserted at runtime rather than assumed. When an upgrade drops the
 * method the reaper reports `unavailable` and the DO starts normally, instead
 * of throwing on every cold start.
 */
export const asRestartReapAgent = (candidate: unknown): RestartReapAgent | null => {
  if (typeof candidate !== "object" || candidate === null) return null;
  const agent = candidate as Partial<Record<keyof RestartReapAgent, unknown>>;
  return typeof agent.getOpenStreamRequestIds === "function" &&
    typeof agent.deleteStreamRequestIds === "function"
    ? (candidate as RestartReapAgent)
    : null;
};

/** Structurally narrow an unknown value to {@link RestartReapEventStore}. */
export const asRestartReapEventStore = (candidate: unknown): RestartReapEventStore | null => {
  if (typeof candidate !== "object" || candidate === null) return null;
  const store = candidate as { readonly storeEvent?: unknown };
  return typeof store.storeEvent === "function" ? (candidate as RestartReapEventStore) : null;
};

export const restartReapErrorMessage = (requestId: RequestId): JSONRPCMessage => ({
  jsonrpc: "2.0",
  id: requestId,
  error: {
    code: RESTART_REAP_ERROR_CODE,
    message: RESTART_REAP_ERROR_MESSAGE,
    // Machine-readable companion to the prose above. `retrySafe: false` is the
    // load-bearing field: a client that automates retries must not treat this
    // like a transport blip.
    data: { reason: "server_restart", retrySafe: false },
  },
});

export type RestartReapOutcome =
  | { readonly kind: "unavailable" }
  | {
      readonly kind: "reaped";
      readonly streamIds: ReadonlyArray<string>;
      readonly requestCount: number;
    };

export const restartReapLog = (input: {
  readonly sessionId: string;
  readonly streamIds: ReadonlyArray<string>;
  readonly requestCount: number;
}): Record<string, unknown> => ({
  event: "mcp_session_restart_reaped_requests",
  sessionId: input.sessionId,
  streamIds: [...input.streamIds],
  streamCount: input.streamIds.length,
  requestCount: input.requestCount,
});

/**
 * Reap every POST stream left with in-flight request ids by a previous isolate.
 *
 * Correctness rests on one invariant of the patched agents transport: a POST
 * stream's `__mcp_stream_reqs__` entry is written when the request is dispatched
 * and deleted the moment its final response is written (`sendOnStream`'s
 * `shouldClose` branch). So at DO start, a surviving entry means "dispatched,
 * never answered" — which after a restart can only be work the reset destroyed.
 * That is why this runs at START and nowhere else: mid-life the same entry
 * legitimately means "still running", and reaping it would cancel live work.
 *
 * The error is appended AFTER the priming event already in the stream, so its
 * event id sorts later and a `last-event-id: <primingId>` reconnect replays it.
 *
 * Per-request failures are collected rather than thrown: one unwritable stream
 * must not strand the others, and the reaper must never block DO startup.
 */
export const reapOrphanedRequests = (input: {
  readonly agent: RestartReapAgent;
  readonly eventStore: RestartReapEventStore;
}): Effect.Effect<RestartReapOutcome, McpRestartReapError> =>
  Effect.gen(function* () {
    const open = yield* Effect.promise(() =>
      Promise.resolve(input.agent.getOpenStreamRequestIds()),
    );
    const orphaned = open.filter(
      (entry) => entry.streamId !== STANDALONE_STREAM_ID && entry.requestIds.length > 0,
    );
    if (orphaned.length === 0) {
      return { kind: "reaped", streamIds: [], requestCount: 0 } as const;
    }

    const reapedStreamIds: string[] = [];
    let requestCount = 0;
    const failures: McpRestartReapError[] = [];

    for (const entry of orphaned) {
      const before = requestCount;
      // Every request id on the stream is reaped, not just the first: a client
      // may batch several JSON-RPC requests into one POST, and the transport
      // only closes the stream once ALL of them have responded. Leaving one
      // unanswered would hang the client exactly as before.
      for (const requestId of entry.requestIds) {
        const stored = yield* Effect.exit(
          Effect.promise(() =>
            Promise.resolve(
              input.eventStore.storeEvent(entry.streamId, restartReapErrorMessage(requestId)),
            ),
          ),
        );
        if (Exit.isFailure(stored)) {
          failures.push(
            new McpRestartReapError({
              streamId: entry.streamId,
              requestId,
              cause: Cause.squash(stored.cause),
            }),
          );
          continue;
        }
        requestCount += 1;
      }
      if (requestCount === before) continue;
      // Drop the request-id key only once its errors are durably stored, so a
      // reset DURING the reap leaves the stream reapable on the next start
      // rather than silently forgotten. Re-reaping is harmless: the client
      // takes the first error and the stream is torn down.
      yield* Effect.promise(() =>
        Promise.resolve(input.agent.deleteStreamRequestIds(entry.streamId)),
      );
      reapedStreamIds.push(entry.streamId);
    }

    const firstFailure = failures[0];
    if (firstFailure && reapedStreamIds.length === 0) return yield* firstFailure;
    return { kind: "reaped", streamIds: reapedStreamIds, requestCount } as const;
  });
