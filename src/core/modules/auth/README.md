# Auth Module (Legacy Auth)

JWT-based email/password authentication: `signIn`, `signUp`, `logout`, `refreshToken` over GraphQL,
and `POST /auth/signin`, `/auth/signup`, `/auth/logout`, `/auth/refresh-token` over REST.

> **This module is deprecated in favour of IAM (Better-Auth) and will be removed.** Since 11.38.0
> its endpoints are **off unless explicitly enabled**. New projects should not register it — the
> one-argument `CoreModule.forRoot(envConfig)` never does. See
> [`.claude/rules/module-deprecation.md`](../../../../.claude/rules/module-deprecation.md) for the
> migration path.

## When this module exists at all

Only when a project passes the three-argument form:

```typescript
CoreModule.forRoot(CoreAuthService, AuthModule.forRoot(envConfig.jwt), envConfig);
```

The one-argument form (`CoreModule.forRoot(envConfig)`) registers IAM only, and nothing in this
directory is loaded. If you are reading this while planning a new project, that is the form you
want.

## Enabling the endpoints

Registering the module is no longer enough. Since 11.38.0 the endpoints answer **HTTP 410 Gone**
until asked for:

```typescript
// config.env.ts
auth: {
  legacyEndpoints: { enabled: true },   // or LEGACY_AUTH_ENABLED=true
},
```

The default flipped because a second, fully functional password-authentication surface that nobody
chose is a liability: it is served by `CoreAuthService` rather than Better-Auth, so it bypasses
every IAM-side control an operator may believe is now in force — two-factor, passkey enforcement,
Better-Auth session revocation.

Resolution is one exported function, `isLegacyEndpointEnabled(config, transport)`, shared by both
transports so they cannot answer differently:

| Configuration                               | Result                               |
| ------------------------------------------- | ------------------------------------ |
| `enabled: false`                            | off, whatever `graphql` / `rest` say |
| per-transport flag set (`graphql` / `rest`) | that flag wins                       |
| `enabled: true`                             | on                                   |
| nothing set                                 | **off**                              |

An explicit `enabled: false` is a hard off switch that a per-transport `true` cannot reopen — it is
the setting a project reached for to close legacy down, and an upgrade must never widen it.

## Knowing when you can turn it off

`CoreLegacyAuthDeprecationInitializer` reports at every boot, in both directions:

- while any endpoint is open: a deprecation warning plus the IAM migration percentage,
- while all are closed but users are still unmigrated: a warning that those users cannot sign in,
  naming the way back.

Both are best-effort — the status read runs detached from the boot so it cannot delay readiness.
The same figures are available on demand through the `betterAuthMigrationStatus` query
(`canDisableLegacyAuth` is the signal to act on).

## Relationship to IAM while both run

The two systems share one user collection and keep each other's credentials in step:

| Event                                       | Written by      | Mirrored into                         |
| ------------------------------------------- | --------------- | ------------------------------------- |
| Sign-up via IAM                             | IAM (scrypt)    | legacy (bcrypt)                       |
| Sign-up via Legacy                          | legacy (bcrypt) | IAM, on first IAM sign-in (migration) |
| Password reset via the legacy user endpoint | legacy          | IAM                                   |
| Password reset via IAM                      | IAM             | legacy (11.38.0+)                     |
| Password change via `update()`              | legacy          | IAM                                   |

`CoreAuthService.signIn` **delegates to IAM** as soon as a user carries an `iamId`, so for a
migrated user both endpoints answer from the IAM credential. That is worth knowing when debugging:
a stale legacy bcrypt hash is invisible through either API and only surfaces if IAM is switched
off.

Hash formats differ irreversibly (`bcrypt(sha256(pw))` vs `scrypt(sha256(pw))`), which is why the
mirrors exist rather than a one-off migration script.

## Extending

Standard Module Inheritance Pattern. Both endpoint guards are `protected` and must be called from
an override:

| Class                | Method to call                    |
| -------------------- | --------------------------------- |
| `CoreAuthResolver`   | `checkLegacyGraphQLEnabled(name)` |
| `CoreAuthController` | `checkLegacyRESTEnabled(name)`    |

Forgetting one re-opens a disabled endpoint. Use the exported `isLegacyEndpointEnabled()` rather
than re-implementing the table if you override the check itself.

## Related

- [`.claude/rules/module-deprecation.md`](../../../../.claude/rules/module-deprecation.md) — the migration roadmap
- [`.claude/rules/role-system.md`](../../../../.claude/rules/role-system.md) — `@Roles` vs `@UseGuards`, and why `refreshToken` is the one place `@UseGuards` is still required
- [`../better-auth/README.md`](../better-auth/README.md) — the system replacing this one
- [`../better-auth/INTEGRATION-CHECKLIST.md`](../better-auth/INTEGRATION-CHECKLIST.md) — integrating IAM