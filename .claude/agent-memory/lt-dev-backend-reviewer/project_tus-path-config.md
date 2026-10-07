---
name: project_tus-path-config
description: 11.42.9 TUS changes — tus key read from ConfigService, applyPath() moves the controller, Location from req.url; what was verified and the prefix-workaround regression reported.
metadata:
  type: project
---

11.42.9 (reviewed 2026-10-07, uncommitted): `TusModule.forRoot()` without `config` reads
`ConfigService.get('tus')`; `applyPath()` writes PATH_METADATA onto the registered controller (config
`path` wins, else the declared route, remembered per class in a WeakMap); `generateUrl` builds Location
from `uploadCollectionPath(req)` = srvx `req.url` pathname (srvx NodeRequestURL uses Node `req.url`,
which Express leaves unstripped for Nest routes).

Verified by probe (dist + NestFactory, fake connection `{ db: { collection: () => ({}) } }`, see
`scratchpad/tusprobe/probe.cjs`): Location + HEAD 200 under `setGlobalPrefix('api')` and URI versioning;
a subclass WITHOUT its own `@Controller` gets own metadata, CoreTusController stays `tus`. All local
consumers put `CoreModule.forRoot()` before `TusModule.forRoot()` in one array, so ConfigService is
filled; a TusModule.forRoot() in a separately imported feature module silently falls back to defaults
(old behaviour, not a regression). `datastore.extensions` narrowing never removes `expiration`, the only
extension @tus/server's cleanup checks.

**Reported (High, migration guide):** `path: '/api/tus'` under `setGlobalPrefix('api')` — the only
config that made resumes work before (old README: "Ensure client uses same path as config") — now
mounts at `/api/api/tus`; POST `/api/tus` → 404 (probe-proven). Same for a path-stripping reverse
proxy with `path` set to the public path. No local consumer sets a non-default path (turbo: `/tus`).
Related: [[tus-end-callback-normalization]].
