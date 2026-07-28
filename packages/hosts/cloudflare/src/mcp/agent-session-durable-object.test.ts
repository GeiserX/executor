import { describe, expect, it } from "@effect/vitest";
import { Cause, Effect, Exit } from "effect";
import type * as Tracer from "effect/Tracer";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { Transport } from "@modelcontextprotocol/sdk/shared/transport.js";
import type {
  JSONRPCMessage,
  MessageExtraInfo,
  RequestId,
} from "@modelcontextprotocol/sdk/types.js";
import { DurableObjectEventStore } from "agents/mcp";

import { defaultMcpResource } from "@executor-js/host-mcp";
import type { ExecutionEngine, ExecutionResult, ResumeResponse } from "@executor-js/execution";

import {
  McpAgentSessionDOBase,
  type McpApprovalOwner,
  type McpSessionModelResumeResult,
  type SessionMeta,
} from "./agent-session-durable-object";
import { RESTART_REAP_ERROR_CODE } from "./restart-reaper";

class MemoryStorage {
  private readonly data = new Map<string, unknown>();
  alarm: number | undefined;

  readonly sql = {
    exec: () => [],
  };

  async get<T>(key: string): Promise<T | undefined> {
    return this.data.get(key) as T | undefined;
  }

  async put(key: string, value: unknown): Promise<void> {
    this.data.set(key, value);
  }

  async setAlarm(time: number | Date): Promise<void> {
    this.alarm = typeof time === "number" ? time : time.getTime();
  }

  async deleteAlarm(): Promise<void> {
    this.alarm = undefined;
  }

  async delete(key: string | readonly string[]): Promise<void> {
    if (typeof key === "string") {
      this.data.delete(key);
      return;
    }
    for (const entry of key) {
      this.data.delete(entry);
    }
  }

  async deleteAll(): Promise<void> {
    this.data.clear();
  }

  // Mirrors DurableObjectStorage's SORTED key-value surface, including `start`
  // and `reverse`. The real agents `DurableObjectEventStore` depends on that
  // ordering for both sequence recovery (`reverse`+`limit: 1`) and replay
  // (`start`), so a list that returned insertion order would quietly make
  // event-store assertions meaningless.
  async list<T>(
    options: {
      readonly prefix?: string;
      readonly start?: string;
      readonly limit?: number;
      readonly reverse?: boolean;
    } = {},
  ): Promise<Map<string, T>> {
    const keys = [...this.data.keys()]
      .filter((key) => (options.prefix === undefined ? true : key.startsWith(options.prefix)))
      .filter((key) => (options.start === undefined ? true : key >= options.start))
      .sort();
    if (options.reverse === true) keys.reverse();
    const limited = options.limit === undefined ? keys : keys.slice(0, options.limit);
    return new Map(limited.map((key) => [key, this.data.get(key) as T]));
  }

  async blockConcurrencyWhile<T>(callback: () => T | Promise<T>): Promise<T> {
    return callback();
  }

  get id(): { readonly name: string } {
    return { name: "streamable-http:session-reconnect" };
  }

  get storage(): MemoryStorage {
    return this;
  }

  waitUntil(_promise: Promise<unknown>): void {}
}

type HarnessSession = {
  alarm: () => Promise<void>;
  ctx: MemoryStorage;
  dbHandle: { readonly end: () => void } | null;
  engine: ExecutionEngine<Cause.YieldableError> | null;
  getSessionId: () => string;
  initialized: boolean;
  lastActivityMs: number;
  maxPausedSessionIdleMs: () => number;
  onStart: () => Promise<void>;
  pendingApprovalLeases: Map<string, never>;
  props: Record<string, unknown>;
  runMcpAgentOnStart: () => Promise<void>;
  server?: McpServer;
  /** Inherited from the real `McpAgent`; the reaper tests drive them directly. */
  setStreamRequestIds: (streamId: string, requestIds: RequestId[]) => Promise<void>;
  getStreamRequestIds: (streamId: string) => Promise<RequestId[] | undefined>;
  /** The base's telemetry seam; the span test swaps in a recording tracer. */
  withTelemetry: <A, E>(effect: Effect.Effect<A, E>) => Effect.Effect<A, E>;
  sessionMeta: SessionMeta;
  sessionTimeoutMs: () => number;
  resumeExecutionForModel: (
    executionId: string,
    identity: McpApprovalOwner,
    response: ResumeResponse,
  ) => Promise<McpSessionModelResumeResult>;
  validateMcpSessionOwner: (identity: {
    readonly accountId: string;
    readonly organizationId: string;
  }) => Promise<"ok" | "not_found" | "forbidden" | "terminated">;
};

class StaleCloseTransport implements Transport {
  onclose?: () => void;
  onerror?: (error: Error) => void;
  onmessage?: (message: JSONRPCMessage, extra?: MessageExtraInfo) => void;

  async start(): Promise<void> {}

  async close(): Promise<void> {}

  async send(_message: JSONRPCMessage): Promise<void> {}
}

class RestoredTransport implements Transport {
  onclose?: () => void;
  onerror?: (error: Error) => void;
  onmessage?: (message: JSONRPCMessage, extra?: MessageExtraInfo) => void;

  async start(): Promise<void> {}

  async close(): Promise<void> {
    this.onclose?.();
  }

  async send(_message: JSONRPCMessage): Promise<void> {}
}

const makeServer = () => new McpServer({ name: "executor-test", version: "1.0.0" });

const makeDeferred = (): { readonly promise: Promise<void>; readonly resolve: () => void } => {
  let resolve: () => void = () => undefined;
  const promise = new Promise<void>((settle) => {
    resolve = settle;
  });
  return { promise, resolve };
};

type ResumeCall = {
  readonly executionId: string;
  readonly response: ResumeResponse;
};

const completed = (result: unknown): ExecutionResult => ({
  status: "completed",
  result: { result },
});

const makeEngine = (
  resultForResume: (executionId: string, response: ResumeResponse) => ExecutionResult | null = () =>
    completed("resume-result"),
): { readonly calls: ResumeCall[]; readonly engine: ExecutionEngine<Cause.YieldableError> } => {
  const calls: ResumeCall[] = [];
  return {
    calls,
    engine: {
      execute: () => Effect.succeed({ result: "execute-result" }),
      executeWithPause: () => Effect.succeed(completed("execute-result")),
      resume: (executionId, response) =>
        Effect.sync(() => {
          calls.push({ executionId, response });
          return resultForResume(executionId, response);
        }),
      getPausedExecution: () => Effect.succeed(null),
      pausedExecutionCount: () => Effect.succeed(0),
      hasPausedExecutions: () => Effect.succeed(false),
      getDescription: Effect.succeed("test engine"),
    },
  };
};

const approval = {
  action: "accept",
  content: { approved: true },
} satisfies ResumeResponse;

const makeHarnessSession = async (): Promise<HarnessSession> => {
  const sessionId = "session-reconnect";
  const sessionMeta: SessionMeta = {
    organizationId: "org-1",
    organizationName: "Org 1",
    userId: "user-1",
    resource: defaultMcpResource,
  };
  const storage = new MemoryStorage();
  const server = makeServer();
  await server.connect(new StaleCloseTransport());

  const session = Object.create(McpAgentSessionDOBase.prototype) as HarnessSession;
  session.ctx = storage;
  session.dbHandle = { end: () => undefined };
  session.engine = makeEngine().engine;
  session.getSessionId = () => sessionId;
  session.initialized = true;
  session.lastActivityMs = Date.now() - 10;
  session.maxPausedSessionIdleMs = () => 1_000;
  session.pendingApprovalLeases = new Map<string, never>();
  session.props = {};
  session.server = server;
  session.sessionMeta = sessionMeta;
  session.sessionTimeoutMs = () => 1;
  session.runMcpAgentOnStart = async () => {
    const restored = session.server ?? makeServer();
    session.server = restored;
    await restored.connect(new RestoredTransport());
    session.engine = makeEngine().engine;
    session.initialized = true;
  };

  return session;
};

describe("McpAgentSessionDOBase transport restore", () => {
  it("restores a same-session request after idle disposal leaves a stale server transport", async () => {
    const session = await makeHarnessSession();

    await session.alarm();

    await expect(
      session.validateMcpSessionOwner({ accountId: "user-1", organizationId: "org-1" }),
    ).resolves.toBe("ok");
  });

  it("single-flights concurrent same-session restore after idle disposal", async () => {
    const session = await makeHarnessSession();
    const firstRestoreEntered = makeDeferred();
    const finishRestore = makeDeferred();
    let onStartCalls = 0;
    let restoredServer: McpServer | undefined;

    session.runMcpAgentOnStart = async () => {
      onStartCalls += 1;
      const restored = session.server ?? makeServer();
      restoredServer ??= restored;
      session.server = restored;
      firstRestoreEntered.resolve();
      await finishRestore.promise;
      await restored.connect(new RestoredTransport());
      session.initialized = true;
    };

    await session.alarm();

    const first = session.validateMcpSessionOwner({
      accountId: "user-1",
      organizationId: "org-1",
    });
    const second = session.validateMcpSessionOwner({
      accountId: "user-1",
      organizationId: "org-1",
    });

    await firstRestoreEntered.promise;
    await Promise.resolve();
    finishRestore.resolve();

    await expect(Promise.all([first, second])).resolves.toEqual(["ok", "ok"]);
    expect(onStartCalls).toBe(1);
    expect(session.server).toBe(restoredServer);
  });

  it("single-flights SDK onStart callers with same-session restore", async () => {
    const session = await makeHarnessSession();
    const firstStartEntered = makeDeferred();
    const finishStart = makeDeferred();
    let onStartCalls = 0;

    session.runMcpAgentOnStart = async () => {
      onStartCalls += 1;
      const restored = session.server ?? makeServer();
      session.server = restored;
      firstStartEntered.resolve();
      await finishStart.promise;
      await restored.connect(new RestoredTransport());
      session.initialized = true;
    };

    await session.alarm();

    const restore = session.validateMcpSessionOwner({
      accountId: "user-1",
      organizationId: "org-1",
    });
    const sdkStart = session.onStart();

    await firstStartEntered.promise;
    await Promise.resolve();
    finishStart.resolve();

    await expect(Promise.all([restore, sdkStart])).resolves.toEqual(["ok", undefined]);
    expect(onStartCalls).toBe(1);
  });

  it("single-flights model resume restore with SDK onStart", async () => {
    const session = await makeHarnessSession();
    const firstStartEntered = makeDeferred();
    const finishStart = makeDeferred();
    const restoredEngine = makeEngine(() => completed("model-result"));
    let onStartCalls = 0;

    session.runMcpAgentOnStart = async () => {
      onStartCalls += 1;
      const restored = session.server ?? makeServer();
      session.server = restored;
      firstStartEntered.resolve();
      await finishStart.promise;
      await restored.connect(new RestoredTransport());
      session.engine = restoredEngine.engine;
      session.initialized = true;
    };

    await session.alarm();

    const resume = session.resumeExecutionForModel(
      "exec-model",
      { accountId: "user-1", organizationId: "org-1" },
      approval,
    );
    const sdkStart = session.onStart();

    await firstStartEntered.promise;
    await Promise.resolve();
    finishStart.resolve();

    const [resumeResult] = await Promise.all([resume, sdkStart]);
    expect(resumeResult).toMatchObject({
      status: "result",
      result: {
        structuredContent: {
          status: "completed",
          result: "model-result",
        },
      },
    });
    expect(onStartCalls).toBe(1);
    expect(restoredEngine.calls).toEqual([{ executionId: "exec-model", response: approval }]);
  });
});

// Restart reaping, driven through the DO's real start path against the real
// agents storage layout (`McpAgent.getOpenStreamRequestIds` and
// `DurableObjectEventStore`, both inherited off the live prototype chain rather
// than stubbed). This is the integration half of restart-reaper.test.ts: it
// pins that the reaper actually FIRES on start, that it is wired to the same
// event store the transport writes through, and that a normal session start
// stays inert.
//
// The failure being covered: a deploy resets the isolate mid tool call. The
// execution dies unrecoverably and the client's POST stream closes cleanly, so
// without this the client hangs to its own timeout with no error and no span.
describe("McpAgentSessionDOBase restart reaping", () => {
  /**
   * A tracer that records ended spans with their final `Exit`. Effect's OTEL
   * tracer maps a failed Exit to `SpanStatusCode.ERROR` plus a recorded
   * exception, so asserting the Exit here is asserting what Axiom would show.
   */
  const recordingTracer = () => {
    const ended: Array<{
      readonly name: string;
      readonly attributes: Map<string, unknown>;
      exit?: Exit.Exit<unknown, unknown>;
    }> = [];
    const tracer: Tracer.Tracer = {
      span: (options) => {
        const attributes = new Map<string, unknown>();
        const record = { name: options.name, attributes } as (typeof ended)[number];
        let status: Tracer.SpanStatus = { _tag: "Started", startTime: options.startTime };
        return {
          _tag: "Span",
          name: options.name,
          spanId: "1234567890abcdef",
          traceId: "4268a606000000000000000000000000",
          parent: options.parent,
          annotations: options.annotations,
          get status() {
            return status;
          },
          attributes,
          links: options.links,
          sampled: options.sampled,
          kind: options.kind,
          end: (endTime, exit) => {
            status = { _tag: "Ended", startTime: options.startTime, endTime, exit };
            record.exit = exit;
            ended.push(record);
          },
          attribute: (key, value) => {
            attributes.set(key, value);
          },
          event: () => undefined,
          addLinks: () => undefined,
        };
      },
    };
    return { tracer, ended };
  };

  const replayFrom = async (
    session: HarnessSession,
    lastEventId: string,
  ): Promise<ReadonlyArray<JSONRPCMessage>> => {
    const store = new DurableObjectEventStore(session.ctx as never);
    const replayed: JSONRPCMessage[] = [];
    await store.replayEventsAfter(lastEventId, {
      send: async (_eventId: string, message: JSONRPCMessage) => {
        replayed.push(message);
      },
    });
    return replayed;
  };

  /**
   * Reproduce the pre-restart on-disk state: the transport primed the POST
   * stream and persisted its in-flight request ids, then the isolate died
   * before any response was written. Only durable state is set up — exactly
   * what actually survives a reset.
   */
  const seedKilledCall = async (
    session: HarnessSession,
    streamId: string,
    requestIds: ReadonlyArray<RequestId>,
  ): Promise<string> => {
    const store = new DurableObjectEventStore(session.ctx as never);
    const primingId = await store.storeEvent(streamId, {
      jsonrpc: "2.0",
      method: "notifications/message",
      params: { level: "debug", data: "mcp-stream-priming" },
    });
    await session.setStreamRequestIds(streamId, [...requestIds]);
    return primingId;
  };

  it("turns a call killed by the restart into a replayable error on the next start", async () => {
    const session = await makeHarnessSession();
    const primingId = await seedKilledCall(session, "killed-stream", [11]);

    await session.onStart();

    const replayed = await replayFrom(session, primingId);
    expect(replayed.length, "the reconnect replays exactly one error").toBe(1);
    expect(replayed[0], "and it names the restart without inviting a blind retry").toMatchObject({
      jsonrpc: "2.0",
      id: 11,
      error: { code: RESTART_REAP_ERROR_CODE, data: { retrySafe: false } },
    });
    expect(
      await session.getStreamRequestIds("killed-stream"),
      "the reaped stream no longer looks like running work to the idle alarm",
    ).toBeUndefined();
  });

  it("reaps every concurrent in-flight request on the session", async () => {
    // Several tool calls can be in flight on one session at once; a reset
    // kills all of them. Missing any one leaves that client call hanging.
    const session = await makeHarnessSession();
    const first = await seedKilledCall(session, "killed-a", [1]);
    const second = await seedKilledCall(session, "killed-b", [2, 3]);

    await session.onStart();

    expect(
      (await replayFrom(session, first)).map((m) => (m as { readonly id?: RequestId }).id),
      "the single-request stream is reaped",
    ).toEqual([1]);
    expect(
      (await replayFrom(session, second)).map((m) => (m as { readonly id?: RequestId }).id),
      "and both requests batched on the other stream are too",
    ).toEqual([2, 3]);
  });

  it("ends the reap span as a failure so the loss is visible in the trace store", async () => {
    // The observability half of the bug: a killed execution exports NOTHING —
    // no exception, no span — so an outage of this shape is invisible. The
    // reap deliberately ends its span on a failed Exit, which the OTEL tracer
    // renders as status ERROR with a recorded exception; absence would look
    // exactly like health. Asserted against the real span lifecycle via a
    // recording tracer rather than trusting the annotation call.
    const session = await makeHarnessSession();
    await seedKilledCall(session, "traced-stream", [1, 2]);
    // The DO runs each method in its own `Effect.runPromise`, so a tracer
    // cannot be injected from outside. `withTelemetry` is the base's own seam
    // for installing one — the same hook cloud uses to provide the real OTEL
    // tracer — so the recording tracer goes in exactly where production's does.
    const spans = recordingTracer();
    session.withTelemetry = (effect) => Effect.withTracer(effect, spans.tracer);

    await session.onStart();

    const reapSpan = spans.ended.find((span) => span.name === "McpSessionDO.restart_reap");
    expect(reapSpan, "the reap exports its own span").toBeDefined();
    expect(reapSpan?.exit && Exit.isFailure(reapSpan.exit), "and ends it as a FAILURE").toBe(true);
    expect(
      reapSpan?.attributes.get("exception.message"),
      "carrying how much work the restart destroyed",
    ).toContain("2 in-flight MCP request(s)");
  });

  it("writes nothing when a start finds no interrupted work", async () => {
    // The overwhelmingly common case — an ordinary cold start or a restore
    // after idle disposal. A false positive here would inject a spurious error
    // into a healthy session, so inertness is asserted directly.
    const session = await makeHarnessSession();
    const store = new DurableObjectEventStore(session.ctx as never);
    const streamId = "completed-stream";
    const primingId = await store.storeEvent(streamId, {
      jsonrpc: "2.0",
      method: "notifications/message",
      params: { level: "debug", data: "mcp-stream-priming" },
    });
    const response: JSONRPCMessage = { jsonrpc: "2.0", id: 1, result: { ok: true } };
    await store.storeEvent(streamId, response);
    // The transport deletes the request-ids key as it writes the final
    // response, so a completed call leaves nothing behind to reap.

    await session.onStart();

    expect(
      await replayFrom(session, primingId),
      "the completed call's result is the only thing replayed",
    ).toEqual([response]);
  });
});
