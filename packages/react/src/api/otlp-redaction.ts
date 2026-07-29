// ---------------------------------------------------------------------------
// Export-seam redaction for the BROWSER isolate's OTLP pipeline.
//
// The web client's `OtlpTracer` stamps the same credential-bearing values the
// worker's tracer does — `HttpClient` writes `url.full` and `url.query` on
// every `http.client` span, and a failed span carries the interpolated log
// message, `effect.cause`, and `exception.*` as event text — and ships them to
// `/v1/traces`, which the worker forwards to Axiom. The policy is shared with
// the Workers isolates (`@executor-js/sdk/shared`); only the seam differs.
//
// `OtlpTracer` has no processor hook: it builds the OTLP payload itself and
// hands it to `OtlpSerialization`. That handoff is the one chokepoint every
// exported span crosses, so the redaction wraps the serializer rather than the
// tracer — a tracer wrapper would have to re-implement `Tracer.Span`, and a
// per-request `HttpClient` transform would only cover the clients someone
// remembered to wire it into.
// ---------------------------------------------------------------------------

import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { OtlpSerialization } from "effect/unstable/observability/OtlpSerialization";
import type { TraceData } from "effect/unstable/observability/OtlpTracer";

import {
  STRIPPED_QUERY_ATTRIBUTE,
  redactSpanUrlAttribute,
  scrubSpanText,
} from "@executor-js/sdk/shared";

/** The OTLP span, taken off `TraceData` rather than redeclared — the payload
 *  shape is the contract this wrapper sits on. */
type OtlpSpan = TraceData["resourceSpans"][number]["scopeSpans"][number]["spans"][number];

/** Rewrite one span's payload in place. The `TraceData` handed to the
 *  serializer is freshly built per export batch and is not shared with the
 *  tracer's own span objects, so mutating it affects only what is serialized.
 *
 *  An OTLP attribute value is a tagged union (`stringValue`, `intValue`, …);
 *  only the string arm can carry a URL or free text. */
const scrubSpan = (span: OtlpSpan): void => {
  const stripped = new Set<string>();
  for (const attribute of span.attributes) {
    const value = attribute.value.stringValue;
    if (typeof value !== "string") continue;
    const result = redactSpanUrlAttribute(attribute.key, value);
    if (result === null) continue;
    attribute.value.stringValue = result.value;
    for (const key of result.stripped) stripped.add(key);
  }
  if (stripped.size > 0) {
    span.attributes.push({
      key: STRIPPED_QUERY_ATTRIBUTE,
      value: { stringValue: Array.from(stripped).sort().join(",") },
    });
  }
  span.events.forEach((event, index) => {
    for (const attribute of event.attributes) {
      const value = attribute.value.stringValue;
      if (typeof value !== "string") continue;
      attribute.value.stringValue = scrubSpanText(value);
    }
    // `name` is readonly on the event, so the entry is replaced rather than
    // assigned through — the attribute bags above are shared with the copy.
    span.events[index] = { ...event, name: scrubSpanText(event.name) };
  });
  if (typeof span.status.message === "string") {
    span.status.message = scrubSpanText(span.status.message);
  }
};

/** Wrap an `OtlpSerialization` layer so every span it serializes is scrubbed
 *  first. Metrics and logs pass through untouched — neither carries a span's
 *  URL attributes, and the log exporter is not installed on this surface. */
export const layerRedacted = (
  inner: Layer.Layer<OtlpSerialization>,
): Layer.Layer<OtlpSerialization> =>
  Layer.effect(
    OtlpSerialization,
    Effect.map(OtlpSerialization.asEffect(), (serialization) => ({
      ...serialization,
      traces: (data) => {
        for (const resourceSpan of data.resourceSpans) {
          for (const scopeSpan of resourceSpan.scopeSpans) {
            for (const span of scopeSpan.spans) scrubSpan(span);
          }
        }
        return serialization.traces(data);
      },
    })),
  ).pipe(Layer.provide(inner));
