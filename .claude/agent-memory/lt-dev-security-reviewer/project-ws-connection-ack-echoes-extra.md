---
name: project-ws-connection-ack-echoes-extra
description: Pre-existing, below bar — CoreModule's graphql-ws onConnect returns `extra`, which graphql-ws serializes as the connection_ack payload (user object + request headers, own data only)
metadata:
  type: project
---

All three `graphql-ws` `onConnect` handlers in `src/core.module.ts` end with `return extra;`. graphql-ws
(6.x, `server-*.js`) sends any OBJECT returned from `onConnect` as the `connection_ack` payload via
`JSON.stringify`. `extra` = `{ socket, request, user, headers }` and it DOES serialize (probe 2026-10-26:
~8.8 kB, includes `user` and the upgrade request incl. its cookie header — the `ltWsConnection`
registration is symbol-keyed and skipped).

So the authenticated client receives its own resolved user object (legacy path: whatever
`validateUser()` returns) and its own request headers. Own data only, no cross-user path found —
below the Critical/High bar and predating 12.0.0, so it was NOT reported.

**Why keep it:** if `validateUser()` / `mapSessionUser()` ever starts returning secret fields, or if
`extra` gains shared server state, this becomes a real disclosure channel with no response
interceptor in front of it (CheckSecurityInterceptor never sees a WS handshake).

**How to apply:** when a review touches `onConnect`, `extra`, or the user objects those helpers return,
re-run the probe (ws server in the repo, `JSON.stringify({type:'connection_ack', payload: extra})`) and
check what the payload carries. The fix would be `return true` (or a minimal object) instead of `extra`.
