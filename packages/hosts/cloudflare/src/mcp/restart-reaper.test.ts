// Unit coverage for the restart reaper (see restart-reaper.ts). A Durable
// Object reset kills an in-flight tool execution outright: the result is never
// produced, so resumability has nothing to replay, and the client's POST stream
// closes CLEANLY so the MCP client neither errors nor reconnects — it hangs to
// its own timeout with no server-side signal at all.
//
// The reaper's job is to make that failure REACHABLE: at DO start, any POST
// stream still carrying persisted in-flight request ids was killed mid-flight,
// so an error is appended to its event log and the request-id key dropped. The
// reconnecting client (primed by the SSE priming event — see
// agents-priming-event.test.ts) replays from `last-event-id` and collects it.
//
// These tests drive the REAL `DurableObjectEventStore` so the assertions cover
// actual event ordering and replay, not a hand-rolled model of it. What's
// pinned:
//   1. An orphaned in-flight request yields an error that a `last-event-id`
//      reconnect after the priming event actually replays.
//   2. No false positives: a stream the transport already finished (its
//      request-ids key deleted on the final response) is left untouched.
//   3. Concurrent in-flight requests — several streams, and several batched
//      requests on ONE stream — are ALL reaped; missing any one still hangs
//      the client.
//   4. The standalone GET stream is never reaped.
//   5. Retry safety: the error does not invite an automatic retry.
import { describe, expect, it } from "@effect/vitest";
import { Effect, Exit } from "effect";
import { DurableObjectEventStore } from "agents/mcp";
import type { JSONRPCMessage, RequestId } from "@modelcontextprotocol/sdk/types.js";

import {
  RESTART_REAP_ERROR_CODE,
  RESTART_REAP_ERROR_MESSAGE,
  asRestartReapAgent,
  asRestartReapEventStore,
  reapOrphanedRequests,
  type RestartReapAgent,
} from "./restart-reaper";

type ListOptions = {
  readonly prefix?: string;
  readonly start?: string;
  readonly limit?: number;
  readonly reverse?: boolean;
};

/** Minimal in-memory stand-in for DurableObjectStorage's sorted KV surface. */
const makeFakeStorage = () => {
  const entries = new Map<string, unknown>();
  return {
    entries,
    put: (key: string, value: unknown) => {
      entries.set(key, value);
      return Promise.resolve();
    },
    delete: (keys: string | ReadonlyArray<string>) => {
      for (const key of Array.isArray(keys) ? keys : [keys]) entries.delete(key);
      return Promise.resolve();
    },
    list: (options: ListOptions = {}) => {
      const keys = [...entries.keys()]
        .filter((key) => (options.prefix === undefined ? true : key.startsWith(options.prefix)))
        .filter((key) => (options.start === undefined ? true : key >= options.start))
        .sort();
      if (options.reverse === true) keys.reverse();
      const limited = options.limit === undefined ? keys : keys.slice(0, options.limit);
      return Promise.resolve(new Map(limited.map((key) => [key, entries.get(key)])));
    },
  };
};

/**
 * Stands in for the patched `McpAgent`'s stream-request-id bookkeeping. The
 * real transport writes an entry when a POST dispatches and deletes it the
 * instant the final response is written, so "an entry survived a restart"
 * means "dispatched, never answered" — the exact condition the reaper acts on.
 */
const makeStreamRequestIds = (
  initial: ReadonlyArray<{ readonly streamId: string; readonly requestIds: RequestId[] }> = [],
) => {
  const open = new Map(initial.map((entry) => [entry.streamId, entry.requestIds] as const));
  const agent: RestartReapAgent = {
    getOpenStreamRequestIds: () =>
      Promise.resolve([...open].map(([streamId, requestIds]) => ({ streamId, requestIds }))),
    deleteStreamRequestIds: (streamId: string) => {
      open.delete(streamId);
      return Promise.resolve();
    },
  };
  return { agent, open };
};

/** The priming notification the patched transport writes at the head of every POST tools/call stream. */
const PRIMING_MESSAGE: JSONRPCMessage = {
  jsonrpc: "2.0",
  method: "notifications/message",
  params: { level: "debug", data: "mcp-stream-priming" },
};

const replayAfter = async (
  store: DurableObjectEventStore,
  lastEventId: string,
): Promise<ReadonlyArray<JSONRPCMessage>> => {
  const replayed: JSONRPCMessage[] = [];
  await store.replayEventsAfter(lastEventId, {
    send: async (_eventId: string, message: JSONRPCMessage) => {
      replayed.push(message);
    },
  });
  return replayed;
};

const eventKeys = (storage: ReturnType<typeof makeFakeStorage>): ReadonlyArray<string> =>
  [...storage.entries.keys()].sort();

const runReap = (agent: RestartReapAgent, eventStore: DurableObjectEventStore) =>
  Effect.runPromise(Effect.exit(reapOrphanedRequests({ agent, eventStore })));

describe("restart reaper: orphaned in-flight requests", () => {
  it("writes a replayable error for a request the restart killed mid-flight", async () => {
    const storage = makeFakeStorage();
    const store = new DurableObjectEventStore(storage as never);
    const streamId = "post-stream";

    // The pre-restart state: the transport primed the stream and persisted the
    // request id, then the isolate died before any response was written.
    const primingId = await store.storeEvent(streamId, PRIMING_MESSAGE);
    const { agent, open } = makeStreamRequestIds([{ streamId, requestIds: [7] }]);

    const outcome = await runReap(agent, store);

    expect(Exit.isSuccess(outcome), "the reap succeeds").toBe(true);
    expect(outcome).toMatchObject({
      value: { kind: "reaped", streamIds: [streamId], requestCount: 1 },
    });

    const replayed = await replayAfter(store, primingId);
    expect(replayed, "a last-event-id reconnect after the priming event replays the error").toEqual(
      [
        {
          jsonrpc: "2.0",
          id: 7,
          error: {
            code: RESTART_REAP_ERROR_CODE,
            message: RESTART_REAP_ERROR_MESSAGE,
            data: { reason: "server_restart", retrySafe: false },
          },
        },
      ],
    );
    expect(open.has(streamId), "the reaped stream's request-id key is dropped").toBe(false);
  });

  it("reaps every request in a batched POST, not just the first", async () => {
    // The transport only closes a POST stream once ALL its request ids have
    // responded, so leaving one unanswered hangs the client exactly as before.
    const storage = makeFakeStorage();
    const store = new DurableObjectEventStore(storage as never);
    const streamId = "batched-stream";
    const primingId = await store.storeEvent(streamId, PRIMING_MESSAGE);
    const { agent } = makeStreamRequestIds([{ streamId, requestIds: [1, 2, "three"] }]);

    const outcome = await runReap(agent, store);

    expect(outcome).toMatchObject({ value: { kind: "reaped", requestCount: 3 } });
    const replayed = await replayAfter(store, primingId);
    expect(
      replayed.map((message) => (message as { readonly id?: RequestId }).id),
      "every batched request id gets its own error, in order",
    ).toEqual([1, 2, "three"]);
  });

  it("reaps concurrent in-flight requests across several streams on one session", async () => {
    const storage = makeFakeStorage();
    const store = new DurableObjectEventStore(storage as never);
    const primingIds = new Map<string, string>();
    for (const streamId of ["stream-a", "stream-b", "stream-c"]) {
      primingIds.set(streamId, await store.storeEvent(streamId, PRIMING_MESSAGE));
    }
    const { agent, open } = makeStreamRequestIds([
      { streamId: "stream-a", requestIds: [1] },
      { streamId: "stream-b", requestIds: [2] },
      { streamId: "stream-c", requestIds: [3] },
    ]);

    const outcome = await runReap(agent, store);

    expect(outcome).toMatchObject({
      value: { kind: "reaped", streamIds: ["stream-a", "stream-b", "stream-c"], requestCount: 3 },
    });
    for (const [streamId, primingId] of primingIds) {
      const replayed = await replayAfter(store, primingId);
      expect(replayed.length, `${streamId} replays exactly one error`).toBe(1);
      expect(replayed[0]).toMatchObject({ error: { code: RESTART_REAP_ERROR_CODE } });
    }
    expect(open.size, "no stream is left holding in-flight request ids").toBe(0);
  });
});

describe("restart reaper: no false positives", () => {
  it("leaves a normally-completed call alone", async () => {
    // A completed call: the transport wrote the response and deleted the
    // stream's request-ids key in the same `shouldClose` step, so there is
    // nothing for the reaper to see.
    const storage = makeFakeStorage();
    const store = new DurableObjectEventStore(storage as never);
    const streamId = "completed-stream";
    const primingId = await store.storeEvent(streamId, PRIMING_MESSAGE);
    const response: JSONRPCMessage = {
      jsonrpc: "2.0",
      id: 1,
      result: { content: [{ type: "text", text: "MARKER" }] },
    };
    await store.storeEvent(streamId, response);
    const keysBefore = eventKeys(storage);
    const { agent } = makeStreamRequestIds();

    const outcome = await runReap(agent, store);

    expect(outcome).toMatchObject({ value: { kind: "reaped", streamIds: [], requestCount: 0 } });
    expect(eventKeys(storage), "no event was appended").toEqual(keysBefore);
    expect(
      await replayAfter(store, primingId),
      "the reconnect still replays exactly the real result",
    ).toEqual([response]);
  });

  it("leaves a stream whose persisted request-id list is empty", async () => {
    const storage = makeFakeStorage();
    const store = new DurableObjectEventStore(storage as never);
    await store.storeEvent("empty-stream", PRIMING_MESSAGE);
    const keysBefore = eventKeys(storage);
    const { agent } = makeStreamRequestIds([{ streamId: "empty-stream", requestIds: [] }]);

    const outcome = await runReap(agent, store);

    expect(outcome).toMatchObject({ value: { kind: "reaped", streamIds: [], requestCount: 0 } });
    expect(eventKeys(storage)).toEqual(keysBefore);
  });

  it("never reaps the standalone GET listen stream", async () => {
    // `_GET_stream` is the session's long-lived server-to-client channel. Its
    // events are deliberately never auto-cleared, and it carries no POST
    // request ids — but the skip is explicit so a future SDK change that starts
    // recording ids against it cannot make the reaper cancel a live listener.
    const storage = makeFakeStorage();
    const store = new DurableObjectEventStore(storage as never);
    await store.storeEvent("_GET_stream", PRIMING_MESSAGE);
    const keysBefore = eventKeys(storage);
    const { agent, open } = makeStreamRequestIds([
      { streamId: "_GET_stream", requestIds: ["listen"] },
    ]);

    const outcome = await runReap(agent, store);

    expect(outcome).toMatchObject({ value: { kind: "reaped", streamIds: [], requestCount: 0 } });
    expect(eventKeys(storage), "the listen stream's event log is untouched").toEqual(keysBefore);
    expect(open.has("_GET_stream"), "its request-id entry is left in place").toBe(true);
  });
});

describe("restart reaper: retry safety", () => {
  it("does not invite an automatic retry", async () => {
    // `execute` runs arbitrary user code, which may already have charged a
    // card or sent mail before the isolate died. The server cannot know how
    // far it got, so the error must not pre-approve a retry — in prose or in
    // its machine-readable data.
    const store = new DurableObjectEventStore(makeFakeStorage() as never);
    const streamId = "side-effect-stream";
    const primingId = await store.storeEvent(streamId, PRIMING_MESSAGE);
    const { agent } = makeStreamRequestIds([{ streamId, requestIds: [1] }]);

    await runReap(agent, store);
    const [replayed] = await replayAfter(store, primingId);
    // Destructured off the JSON-RPC error OBJECT (a wire payload with a
    // `message` field), not a JS Error — hence the local names.
    const { message: wireMessage, data: wireData } = (
      replayed as { readonly error: { readonly message: string; readonly data: unknown } }
    ).error;

    expect(wireMessage.toLowerCase(), "the message never says 'please retry'").not.toContain(
      "please retry",
    );
    expect(wireMessage, "it states the outcome is unknown").toContain("outcome is unknown");
    expect(wireData, "and marks the request machine-readably retry-unsafe").toMatchObject({
      retrySafe: false,
    });
  });
});

describe("restart reaper: SDK seam", () => {
  it("stands down when the agents API the reaper depends on is missing", async () => {
    // `getOpenStreamRequestIds` is `@internal` in the agents SDK. If an upgrade
    // removes it the DO must still start; the reaper reports unavailable
    // rather than throwing on every cold start.
    expect(asRestartReapAgent({}), "an agent without the API is rejected").toBeNull();
    expect(asRestartReapAgent(null)).toBeNull();
    expect(
      asRestartReapAgent(makeStreamRequestIds().agent),
      "the real shape is accepted",
    ).not.toBeNull();
  });

  it("accepts the real DurableObjectEventStore as its event-store seam", () => {
    const store = new DurableObjectEventStore(makeFakeStorage() as never);
    expect(asRestartReapEventStore(store)).not.toBeNull();
    expect(
      asRestartReapEventStore(undefined),
      "a disabled event store stands the reaper down",
    ).toBeNull();
  });

  it("reports a failure when the event store cannot record the error", async () => {
    const failingStore = {
      storeEvent: () =>
        // oxlint-disable-next-line executor/no-promise-reject, executor/no-error-constructor -- boundary: models a rejecting SDK EventStore, whose contract is a rejected Promise.
        Promise.reject(new Error("storage unavailable")),
    };
    const { agent, open } = makeStreamRequestIds([{ streamId: "doomed", requestIds: [1] }]);

    const outcome = await Effect.runPromise(
      Effect.exit(reapOrphanedRequests({ agent, eventStore: failingStore })),
    );

    expect(Exit.isFailure(outcome), "the failure is reported, not swallowed").toBe(true);
    expect(
      open.has("doomed"),
      "the request-id key survives, so the next start can retry the reap",
    ).toBe(true);
  });
});
