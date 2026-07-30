---
"executor": patch
---

Artifact tool results now include the web deep link beside the inline widget payload, not just on the no-apps fallback. Clients can lose a rendered widget in ways the server never sees — a reopened transcript that skips the resource re-read shows raw JSON — and the URL in the result is the model's way to point the user back at the artifact.
