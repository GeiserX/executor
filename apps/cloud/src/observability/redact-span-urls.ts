// ---------------------------------------------------------------------------
// Export-seam redaction for the Workers isolates' OTel span pipeline.
//
// The decisions (which query parameters are sensitive, how free text is
// scrubbed and capped) live in `@executor-js/sdk/shared` so the browser
// isolate's exporter applies the identical policy. This file is only the OTel
// `SpanProcessor` shell around them.
//
// The scrub runs at the span-processor seam rather than at the route, because
// this is the only chokepoint every span in the isolate must pass through on
// its way to the exporter — worker spans, Effect spans, Durable Object spans,
// and any route added later. A per-route middleware or a `TracerDisabledWhen`
// override would only cover the routes someone remembered to wire it into, and
// overriding the middleware's attribute handling would mean forking Effect
// internals.
//
// Three surfaces carry credentials out, not one:
//
//   - Attributes. `HttpMiddleware.tracer` stamps `url.full` and `url.query`
//     unconditionally on every `http.server` span, so `/api/oauth/callback`
//     carried the provider's `?code=…&state=…` verbatim on every OAuth connect.
//   - Events. Effect's default tracer logger writes the interpolated log
//     message as the EVENT NAME and the whole `effect.cause` as an event
//     attribute; the OTel bridge's `recordException` writes `exception.message`
//     and `exception.stacktrace` the same way. Every failed span has them.
//   - `status.message`, which the bridge sets to the first error's message.
//
// `url.path` is deliberately preserved: route-level visibility is what makes
// these traces worth exporting at all. Only the sensitive query parameters are
// removed, and their presence is recorded as a stripped-key list so a trace
// still shows that the request carried a `code`, without its value.
// ---------------------------------------------------------------------------

import type { Context } from "@opentelemetry/api";
import type { ReadableSpan, Span, SpanProcessor } from "@opentelemetry/sdk-trace-base";

import {
  SPAN_QUERY_ATTRIBUTE,
  SPAN_URL_ATTRIBUTES,
  STRIPPED_QUERY_ATTRIBUTE,
  redactSpanUrlAttributes,
  scrubSpanText,
} from "@executor-js/sdk/shared";

export { STRIPPED_QUERY_ATTRIBUTE, redactSpanUrlAttributes };

/** Rewrite every free-text value of a span event in place: the event name
 *  (Effect's log message) and each string attribute. Event attributes are not
 *  parseable URLs — `exception.message`, `exception.stacktrace`, and
 *  `effect.cause` are prose that may quote one — so they go through the text
 *  policy (URL query parameters stripped, then capped) rather than the URL
 *  parser. */
const scrubEvent = (event: { name: string; attributes?: Record<string, unknown> }): void => {
  event.name = scrubSpanText(event.name);
  const attributes = event.attributes;
  if (attributes === undefined) return;
  for (const [key, value] of Object.entries(attributes)) {
    if (typeof value !== "string") continue;
    attributes[key] = scrubSpanText(value);
  }
};

/** Wraps a span processor so every span is scrubbed of credential-bearing
 *  values before the inner processor (and therefore the exporter) sees it.
 *
 *  Attributes are rewritten in `onEnding`, the last hook the OTel SDK calls
 *  while the span is still mutable (`Span.end()` runs `onEnding` before setting
 *  `_ended`, so `setAttribute` still applies); `onEnd` receives a frozen
 *  `ReadableSpan`. `onEnding` is optional in the SpanProcessor interface, so
 *  `onEnd` re-checks the attribute bag and mutates it directly as a backstop
 *  for any SDK path that skips the earlier hook.
 *
 *  Events and `status.message` are scrubbed in `onEnd` only: `recordException`
 *  and `setStatus` both run inside `Span.end()`'s caller, so at `onEnding` time
 *  the events array is not yet final. `ReadableSpan` is readonly by TYPE, not
 *  frozen at runtime — the arrays and objects the SDK exposes are the live ones
 *  the exporter serializes, so mutating them here is what keeps the secret out
 *  of the export. */
export class UrlRedactingSpanProcessor implements SpanProcessor {
  constructor(private readonly inner: SpanProcessor) {}

  forceFlush(): Promise<void> {
    return this.inner.forceFlush();
  }

  onStart(span: Span, parentContext: Context): void {
    this.inner.onStart(span, parentContext);
  }

  onEnding(span: Span): void {
    this.redactAttributes(span.attributes, (key, value) => span.setAttribute(key, value));
    this.inner.onEnding?.(span);
  }

  onEnd(span: ReadableSpan): void {
    const attributes = span.attributes as Record<string, unknown>;
    this.redactAttributes(attributes, (key, value) => {
      attributes[key] = value;
    });
    for (const event of span.events) scrubEvent(event);
    const status = span.status as { code: number; message?: string };
    if (typeof status.message === "string") status.message = scrubSpanText(status.message);
    this.inner.onEnd(span);
  }

  shutdown(): Promise<void> {
    return this.inner.shutdown();
  }

  private redactAttributes(
    attributes: Record<string, unknown>,
    write: (key: string, value: string) => void,
  ): void {
    // Work on a copy so the redaction decision is made from the current values
    // and applied through the caller's writer (span API vs direct mutation).
    const draft: Record<string, unknown> = { ...attributes };
    const stripped = redactSpanUrlAttributes(draft);
    if (stripped.length === 0) return;
    for (const name of [...SPAN_URL_ATTRIBUTES, SPAN_QUERY_ATTRIBUTE]) {
      const value = draft[name];
      if (typeof value === "string" && value !== attributes[name]) write(name, value);
    }
    write(STRIPPED_QUERY_ATTRIBUTE, stripped.join(","));
  }
}
