---
name: path-regex-and-esm-switch-costs
description: Measured - `/\/+$/` on a request path is O(n^2) (~120-150 ms at the 16 KB URL limit, URL counts toward maxHeaderSize); callerDirectory() ~6 us; 12.0.0 ESM switch adds no per-request cost.
metadata:
  type: project
---

Measured 2026-10-26 during the 12.0.0 (ESM dist) review.

- `path.replace(/\/+$/, '')` backtracks quadratically when the path is many slashes followed by a
  non-slash char: 4000 -> 7.6 ms, 8000 -> 31 ms, 16000 -> ~120-150 ms per call. Node's default
  `maxHeaderSize` (16384) INCLUDES the request URL (probed: 16300-char path -> 200, 17000 -> 431),
  so ~16 KB is the attacker's ceiling without a proxy. `CoreBetterAuthApiMiddleware` runs it on every
  `/iam/*` request, unauthenticated — `normalizeResetPassword()` (pre-existing) and, from 12.0.0,
  `normalizeNativePasswords()`. Fix shape: one linear trim (`charCodeAt` loop) computed once in `use()`.
  **Fixed the same day** with exactly that: `normalizeIamRoutePath()`, pinned by a 40 000-slash case in
  `tests/unit/password-field-paths.spec.ts` (mutation `iam-route-path-quadratic-regex`).
- `callerDirectory()` (V8 CallSite capture, replaces `__dirname` in the core): ~6 us/call at stack
  depth 20. Its call sites are memoised (email template resolution), admin-only (Hub email), or
  migration-only — never a per-request concern.
- The ESM switch touched no per-request code beyond import specifiers. The tenant guard's per-call lazy
  `require()` of the IAM handler classes became a 2-entry Set lookup (faster); `interceptor.helper`'s
  per-call deep `require()` of TypeMetadataStorage became a static import.
- Dual-package check: better-auth / jose / @tus/server are ESM-only (one instance via require(esm));
  rxjs's `node` condition picks CJS for both import and require; graphql has no exports map (both
  resolve `index.js`). No duplicate instances introduced for a CJS consumer like the starter.

**Why:** these were the open questions the 12.0.0 change summary raised; re-measuring them costs time.
**How to apply:** re-check only if a regex on `req.path`/`originalUrl` or a new `callerDirectory()` call
lands on a per-request path, or a dual package gains a `require` condition.
