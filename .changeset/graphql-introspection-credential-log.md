---
"executor": patch
---

**GraphQL introspection no longer logs a credential carried in the query string**

`query` is a supported credential carrier, so a GraphQL endpoint can be reached with `?token=<secret>`. Introspection built its request from a URL **string**, and `HttpClientRequest.setUrl` keeps a string verbatim as `request.url`. Every `HttpClientError` renders `${method} ${request.url}` into its `message` getter, and introspection logs the raw failure cause — so on any transport failure or non-JSON response, the connection's secret was written to the process log.

The request is now built from a URL **object**, which moves the query into `request.urlParams` and clears it from `request.url`. The secret is therefore absent from the error message, and from anything else that renders the request URL. Nothing changes on the wire: the client recombines url and urlParams when it executes the request.

The endpoint's own query string is handled the same way, not just the separately-supplied query parameters, since a configured endpoint can carry a credential too.
