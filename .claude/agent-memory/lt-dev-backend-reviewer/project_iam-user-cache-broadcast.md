---
name: project_iam-user-cache-broadcast
description: DEV-3895 CoreBetterAuthUserMapper Redis broadcast of invalidateUserCache — DI in the assembled CoreModule probed sound; how to boot CoreModule from a scratchpad probe
metadata:
  type: project
---

DEV-3895 reviewed 2026-10-29 (branch feature/dev-3895-better-auth-mapper-cache-invalidation): zero findings
above the bar. Same lifecycle shape as CoreTenantGuard (see [[project_redis-channel-registry]]).

Verified (re-check if the code moves):
- CoreBetterAuthModule is `@Global` and cached, so ONE mapper instance serves the request path, the WS
  onConnect/reauthenticate and `CoreUserService` — the self-receipt of its own broadcast only costs one extra
  WS re-check on the originating replica.
- Assembled `CoreModule.forRoot(e2eConfig + redis)` (IAM one-arg form): mapper.redisService IS the global
  CoreRedisService, channel `<prefix>:iam-user-cache:invalidate` held once, a foreign PUBLISH clears the cache
  entry and triggers `reauthenticate`, `app.close()` leaves no channel.
- Callers (`setRoles`, `update`) invalidate AFTER the write; SQL store commits per operation, so the remote
  re-read sees the new roles. Legacy login `update()` calls do not carry `roles` (no publish storm).
- Without `redis`: `enabled` false → both hooks and publish are no-ops; behaviour identical to before.

Probe tip (non-obvious): a scratchpad probe file has no tsconfig, so SWC rejects a local `@Module()` class
("Expression expected"). Pass `Test.createTestingModule({ imports: [CoreModule.forRoot(cfg)] })` directly, and
symlink the repo's node_modules into the probe dir or the config cannot load `unplugin-swc`.
