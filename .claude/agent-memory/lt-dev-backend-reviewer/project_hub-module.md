---
name: hub-module
description: The Hub admin cockpit (src/core/modules/hub) deliberately bypasses all 4 global response interceptors via @Res() pre-serialized JSON; maskConfigDeep is the compensating control. Don't re-flag the bypass.
metadata:
  type: project
---

`src/core/modules/hub/` (new in 11.31.x, admin operator cockpit) has two review-relevant design choices that a future reviewer will otherwise waste time re-flagging:

**1. `@Res()` interceptor bypass is intentional.** Every sidecar in `core-hub.controller.ts` /
`core-hub-actions.controller.ts` writes `res.type(...).send(JSON.stringify(data))` manually to bypass
the 4 global response interceptors (esp. `CheckSecurityInterceptor`, which mutates plain objects in
place and would corrupt the live config object). The compensating control for config is
`maskConfigDeep` (`helpers/hub-mask.helper.ts`): deep-clone + key/URI-credential heuristics + union of
FRAMEWORK_SECRET_FIELDS and project `security.secretFields`. Other sidecars are secret-free by
construction (stats, value-free query SHAPES, secret-free traces, `redactSensitiveText`-redacted logs).
Do NOT flag "sidecars miss securityCheck/interceptors" — there are no domain Models here, and the
bypass is the whole point. Verified by `tests/stories/hub.story.test.ts` (masking + 401/403 gating).

**2. Role gating is runtime class-metadata, not source `@Roles`.** `CoreHubModule.forRoot()` does
`Reflect.defineMetadata('roles', resolved.roles, Ctrl)` (default `[ADMIN]`) on BOTH controllers (same
pattern as the permissions module). Sidecar methods carry NO `@Roles` — they inherit the class metadata
because both guards resolve `[handler, class]` via `mergeRolesMetadata`. Only `root`/`page`/`hubJs`/
`authPage` carry explicit `@Roles(S_EVERYONE)` (public shell chrome + no-secret client bundle). This
whole model presumes a global APP_GUARD is registered (it is, by CoreAuthModule or CoreBetterAuthModule).
`hub.roles: false` deletes the metadata → fully public (documented dangerous opt-out).

**Known finding at review time (uncommitted develop, 2026-07):** `core.module.ts` forwards only
`controller`/`htmlService`/`service` from `overrides.hub` — it drops `actionsController` and
`actionsService`, which `ICoreModuleOverrides.hub` + `CoreHubModuleOptions` both declare. A project's
`actionsService` override (advertised as the place to "veto or extend actions") is silently a no-op.
Verify whether this was fixed before re-reviewing. See [[swc-tdz-import-cycles]] for the leaf discipline
that `email.service.ts` → `hub.constants.ts` (HUB_EMAIL_CAPTURE) relies on.
