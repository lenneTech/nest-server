---
name: project-tus-protocol-dispatch-facts
description: How @tus/server 2.4.5 + srvx pick the method and build Location; why X-HTTP-Method-Override / method casing cannot bypass the 11.42.9 creation/termination enforcement; Location is requester-only
metadata:
  type: project
---

Verified 2026-10-07 (@tus/server 2.4.5, srvx NodeRequest), 11.42.9 review round 2:

- **Dispatch is `req.method` only.** Neither @tus/server nor srvx honours `X-HTTP-Method-Override` (despite it
  being in tus's allowed CORS headers); no method-override middleware in nest-server or the starter. Lowercase /
  mixed-case methods (`delete`, `Delete`) are refused 400 by Node's llhttp before any handler. So
  `CoreTusService.assertExtensionEnabled()` (reads the same `req.method`, upper-cased) cannot be sidestepped.
- **PostHandler order:** concat/defer-length checks → `onIncomingRequest(req,newId)` → `onUploadCreate` →
  `store.create`. The extension check sits inline in both Server options (not the overridable hooks), so nothing is
  created when `creation:false` (dir stayed empty in probe). `creation-with-upload` decision matches tus's own
  exact `content-type === 'application/offset+octet-stream'` test — no divergence to exploit.
- **Location (`generateUrl` + `uploadCollectionPath(req)`)**: host from Host / X-Forwarded-Host
  (`respectForwardedHeaders: true`, pre-existing), path from the creating request. It is only returned to the
  requester and never persisted (no POST_CREATE listener) — a client can only spoof its own Location. Not a finding.
- `TusModule.forRoot()` reads `ConfigService.get('tus')` at decorator-evaluation time; no request path can
  influence roles. Consumer scan: only turbo has a `tus` block (allowedTypes/maxSize/path) — tightening, no roles.

Related: [[project-file-tus-access-model]].
