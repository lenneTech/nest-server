---
name: response-clone-and-ejs-costs
description: Measured costs of Response.clone().json() in the /iam/* middleware error path, the async-identity happy path, and a cached EJS render — reuse instead of re-benchmarking.
metadata:
  type: project
---

Measured on the 12-core dev laptop (Node 22, undici Response), 2026-09-02, while reviewing the
11.38.0 password-reset work.

| Operation | Cost |
|---|---|
| `await` an `async` fn that returns its argument by identity (the `wrapBetterAuthErrorResponse` happy path) | **~42 ns** |
| `response.clone().json()` on a small JSON error body + unmapped early return (the `/iam/*` 404 fall-through) | **~10 µs** |
| same + `Headers` rebuild + `new Response(JSON.stringify(...))` (a mapped error) | **~14 µs** |
| same on a **512 KB** body | **~2.7 ms** — cost is linear in body size, and `clone()` tees, so the body is held twice |
| `_.get(frozenConfig, 'a.b.c')` — i.e. `ConfigService.getFastButReadOnly` | **~95 ns** (matches the 79 ns in [[config-service-get-cost]]) |
| cached EJS render of `password-reset-en.ejs`, before vs after adding one `<% if %>` block | **2.3 µs → 3.1 µs** |

**Why:** these four questions recur on every review of the better-auth middleware and the mail path,
and each one costs ~10 minutes to re-measure. `TemplateService` compiles once and caches by file
path, so template edits are never the cost — the SMTP send dominates by four orders of magnitude.

**How to apply:** treat a per-request `clone().json()` on a SMALL body as free (µs against an HTTP
request) and an identity-returning async wrapper as free. Only push back when the cloned body can be
large or streamed — that is the only regime where the numbers above turn into a real cost.
