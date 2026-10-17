---
name: project-route-authguard-redundant-under-global-guard
description: A route-level @UseGuards(AuthGuard(BETTER_AUTH)) next to @Roles (non-S_EVERYONE) adds no refusal behind the global BetterAuthRolesGuard; removal is decision-neutral. Probe recipe (ts-node, not tsx).
metadata:
  type: project
---

Reviewed 2026-10-13 (DEV-3616, starter UserController dropped six `AuthGuard(BETTER_AUTH)`): **0 decision
differences** across anonymous / non-admin / admin / USER API token without `@ApiTokenScopes` / legacy JWT,
on all six routes.

**Why it is neutral:** global guards run before route guards (AND semantics), so removing a route guard can
only widen where the global guard admits and the route guard refuses. `AuthGuard(BETTER_AUTH)` admits
unconditionally any `request.user` with `_authenticatedViaBetterAuth: true` and any API-token principal
(after the same `enforceApiTokenRoute()`). Every `request.user` writer in IAM mode sets one of the two
(`core-better-auth.middleware.ts`, `BetterAuthTokenService.createUserWithHasRole`, user mapper,
`core-api-token.middleware.ts`). It only refuses unflagged users — none exist in IAM-only mode.

**Where it is NOT neutral (re-check if seen):** a route with `@Roles(S_EVERYONE)` + the guard (the guard was
the only authentication); a project with no global roles guard (`registerRolesGuardGlobally: false`,
`betterAuth.enabled: false`) — though there the GraphQL twin (`user.resolver.ts`, `@Roles` only) was
already equally open. Legacy mode: removal admits Passport-JWT users (authenticated, role-checked by
RolesGuard) — functional change, not a hole.

**Probe recipe:** importing starter models under `tsx` fails (`CannotDetermineTypeError`, esbuild emits no
`design:type`). Use the starter's own `TS_NODE_TRANSPILE_ONLY=true node_modules/.bin/ts-node -P tsconfig.json
<probe>` from the starter dir, `require()` reflect-metadata and `@lenne.tech/nest-server` by absolute
starter path, build fake http ExecutionContexts, compare `BetterAuthRolesGuard` alone vs followed by
`new (AuthGuard(BETTER_AUTH))()`.

Related: [[project-api-token-module-security-model]], [[project-roles-metadata-merge-semantics]]
