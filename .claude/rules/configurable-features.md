# Configurable Features Pattern

This document describes the standard pattern for implementing optional, configurable features in @lenne.tech/nest-server.

## "Presence Implies Enabled" Pattern

When implementing configurable features, follow this pattern for activation logic:

### Rules

1. **No configuration** (`undefined` or `null`): Feature is **disabled** (backward compatible)
2. **Empty object** (`{}`): Feature is **enabled** with all default values
3. **Partial configuration** (`{ max: 5 }`): Feature is **enabled**, missing values use defaults
4. **Explicit disable** (`{ enabled: false, ... }`): Feature is **disabled**, allows pre-configuration

### Benefits

- **Backward Compatible**: Existing projects without config continue to work unchanged
- **Efficient**: No need to set `enabled: true` redundantly when already providing config
- **Flexible**: Can pre-configure without activating via `enabled: false`
- **Intuitive**: Providing a config object signals intent to use the feature

### Implementation Example

```typescript
interface IFeatureConfig {
  enabled?: boolean;  // Optional - presence of config implies true
  max?: number;
  windowSeconds?: number;
}

const DEFAULT_CONFIG: Required<IFeatureConfig> = {
  enabled: false,  // Default is false, but overridden by presence
  max: 10,
  windowSeconds: 60,
};

class FeatureService {
  private config: Required<IFeatureConfig> = DEFAULT_CONFIG;

  /**
   * Configure the feature
   *
   * Follows the "presence implies enabled" pattern:
   * - If config is undefined/null: feature stays disabled (backward compatible)
   * - If config is an object (even empty {}): feature is enabled by default
   * - Unless `enabled: false` is explicitly set
   */
  configure(config: IFeatureConfig | undefined | null): void {
    // No config = stay disabled (backward compatible)
    if (config === undefined || config === null) {
      return;
    }

    // Presence of config implies enabled, unless explicitly disabled
    const enabled = config.enabled !== false;

    this.config = {
      ...DEFAULT_CONFIG,
      ...config,
      enabled,
    };
  }
}
```

### Usage Examples

```typescript
// config.env.ts

// Feature disabled (no config)
// rateLimit: undefined  // or just don't define it

// Feature enabled with all defaults
auth: {
  rateLimit: {}
}

// Feature enabled with custom max
auth: {
  rateLimit: { max: 20 }
}

// Feature enabled with full configuration
auth: {
  rateLimit: {
    max: 10,
    windowSeconds: 60,
    message: 'Too many requests'
  }
}

// Pre-configured but disabled (for testing or gradual rollout)
auth: {
  rateLimit: {
    enabled: false,
    max: 10,
    windowSeconds: 60
  }
}
```

## Boolean Shorthand Pattern

For simple enable/disable scenarios, support `boolean | object` configuration:

### Rules

1. **`true`**: Feature is **enabled** with all default values
2. **`false`**: Feature is **disabled**
3. **`{}`**: Feature is **enabled** with all default values (same as `true`)
4. **`{ option: value }`**: Feature is **enabled** with custom settings
5. **`{ enabled: false }`**: Feature is **disabled** (allows pre-configuration)
6. **`undefined`**: Feature is **disabled** (default)

### Benefits

- **Concise**: `jwt: true` instead of `jwt: {}`
- **Readable**: Clear intent at a glance
- **Flexible**: Can still use objects for customization

### Implementation Example

```typescript
// Interface definition
interface IBetterAuth {
  jwt?: boolean | IBetterAuthJwtConfig;
  twoFactor?: boolean | IBetterAuthTwoFactorConfig;
  passkey?: boolean | IBetterAuthPasskeyConfig;
}

interface IBetterAuthJwtConfig {
  enabled?: boolean;
  expiresIn?: string;
}

// Helper functions
function isPluginEnabled<T extends { enabled?: boolean }>(
  config: boolean | T | undefined
): boolean {
  if (config === undefined) return false;
  if (typeof config === 'boolean') return config;
  return config.enabled !== false;
}

function getPluginConfig<T extends { enabled?: boolean }>(
  config: boolean | T | undefined
): T | undefined {
  if (!isPluginEnabled(config)) return undefined;
  if (typeof config === 'boolean') return {} as T;
  return config;
}

// Usage in build logic
const jwtConfig = getPluginConfig(config.jwt);
if (jwtConfig) {
  plugins.push(jwt({ expirationTime: jwtConfig.expiresIn || '15m' }));
}
```

### Usage Examples

```typescript
// config.env.ts

betterAuth: {
  // Boolean shorthand - enable with defaults
  jwt: true,
  twoFactor: true,
  passkey: true,
}

// Equivalent to:
betterAuth: {
  jwt: {},
  twoFactor: {},
  passkey: {},
}

// Mixed - some with defaults, some customized
betterAuth: {
  jwt: true,                        // Enable with defaults
  twoFactor: { appName: 'My App' }, // Enable with custom settings
  passkey: false,                   // Explicitly disabled
}

// Pre-configured but disabled
betterAuth: {
  jwt: { enabled: false, expiresIn: '1h' }, // Ready to enable later
}
```

## Numeric Sentinel Pattern

A numeric knob without a separate boolean uses `0` as its "off" sentinel. **`0` has two
opposite meanings depending on what the number bounds — pick the right family and say
which one you are in.** Filing a cap and a TTL under one rule is how someone later builds
an eternal cache out of `cacheTtlMs: 0`.

### Family A — `0` = NO LIMIT (permissive)

For a knob that **bounds** something (a cap, a quota, a maximum). `0` means "unbounded".

| Config | `0` means |
|--------|-----------|
| `ai.deferToolSummaryChars` | descriptions are not truncated |
| `ai.budget.user.maxTokens` / `.maxPrompts` | unlimited |
| `ai.budget.tenant.maxTokens` / `.maxPrompts` | unlimited |
| `ai.maxRunMs` | a run is bounded only by `maxIterations` x the per-call timeout |

Rules:

1. **`0` and `undefined` both mean unbounded.** `@default 0`.
2. **Never invert it.** `maxTokens: 0` must not mean "may spend nothing" — that turns a
   missing config value into a lockout.
3. **Negative and `NaN` behave like `0`.** A misconfigured value degrades to "no limit",
   never throws, never applies a nonsensical bound. Guard with `typeof v === 'number' && v > 0`,
   **not** `v <= 0` — `NaN <= 0` is `false`, so a bare comparison lets `NaN` through and it
   propagates into arithmetic (`now + NaN`).

### Family B — `0` = FEATURE OFF (restrictive)

For a knob that **enables** something whose size it also configures (a TTL, an interval,
a retry count). `0` means "do not do this at all".

| Config | `0` means | `undefined` means |
|--------|-----------|-------------------|
| `multiTenancy.cacheTtlMs` | no caching | **30000** (caching ON) — not "off" |

Rules:

1. **`0` and `undefined` differ here.** `undefined` falls back to the documented default,
   which is usually ON. Document the real default (`@default 30000`), never `@default 0`.
2. **`NaN` must be normalised explicitly.** `ttl <= 0` does not catch it; coerce first
   (`Number.isFinite(ttl) && ttl > 0`), or a "disabled" value silently becomes an
   expiry of `now + NaN` — every lookup misses while the cache grows.

### Family C — `0` = NO LIMIT, but an INVALID value falls back to the DEFAULT

A third shape, and it exists because Family A's rule is wrong for one class of knob. Family A says
"negative and `NaN` behave like `0`", i.e. a misconfigured value degrades to *unbounded*. That is
right for a cap on tool-description length. It is exactly backwards for a knob that bounds the
lifetime of a **credential**.

| Config | `0` | invalid (negative, `NaN`, `''`, a word) |
|--------|-----|------------------------------------------|
| `auth.passwordReset.tokenExpiresInMinutes` | never expires — the explicit opt-out | **the default (60)**, never "unbounded" |

The asymmetry is the protection: switching off the expiry of an account-takeover credential is a
decision somebody has to state, and a typo in an environment variable must never be the thing that
states it. Note `Number('')` is `0`, so an empty value has to be rejected *before* the coercion or
it reads as a deliberate opt-out.

**When adding a knob, ask what a misconfiguration should cost.** If the answer is "a bound nobody
intended to remove", it belongs here and not in Family A.

### Both families

**Warn when the knob is inert.** If a value only takes effect together with another
setting, log once at runtime when it is set while that other setting is off. A silently
ignored number is indistinguishable from a broken feature — see
`CoreAiPromptBuilderService.warnOnOrphanedSummaryCap()` for the reference implementation.

## Explicit Opt-In Pattern (with a hard off switch)

A fourth shape, distinct from the three above, for a feature whose default was **deliberately
flipped from on to off** and where an explicit "off" must be irreversible by a narrower setting.

### Rules

1. **Absent, `{}`, or any partial config without `enabled: true`**: feature is **disabled**.
   Presence of the config block does NOT imply consent — that is what separates this from
   "presence implies enabled".
2. **`enabled: true`**: feature is **enabled**.
3. **A narrower per-scope flag** (per transport, per surface) overrides `enabled` for its own
   scope only.
4. **`enabled: false` is a HARD off switch** that no narrower flag can reopen.
5. **Non-boolean values read as "not set".** Config arrives as JSON through `NEST_SERVER_CONFIG` /
   `NSC__*`, so a string is reachable — and `'false'` is truthy. Reading it as "on" would turn a
   deployment's attempt to switch something off into switching it on.

Rule 4 is the one that earns the pattern its own name. "Presence implies enabled" has no
irreversible off, and boolean shorthand has no scoping. Use this shape when the feature is a
security surface being retired: the default must fail closed, and a project that already closed
it must not have that decision widened by an upgrade.

Applied to: `auth.legacyEndpoints` (`isLegacyEndpointEnabled()`).

## Applied Features

This pattern is currently applied to:

| Feature | Config Path | Pattern | Default Values |
|---------|-------------|---------|----------------|
| Password-Reset Link (IAM) | `betterAuth.emailVerification.passwordResetLink` | Explicit Value with derived default | **`<appUrl>/auth/reset-password?token={token}` since 11.38.0.** Before, the mail carried the link Better-Auth generates, which points at the **API** (`https://api.example.com/iam/reset-password/<token>?callbackURL=…`) and redirects to the app from there. It works, but puts a domain the recipient does not recognise into a password mail — what people are trained to check before clicking. In this stack app and API hosts are the norm, so the app is the better default. **What it gives up:** Better-Auth's redirect route validates the token and its expiry BEFORE forwarding, so an expired link produced an error page rather than a form that fails on submit; linking straight to the app moves that error later. It is **not** a security difference — the token reaches the app URL either way, and the `callbackURL` origin check exists only because of the hop it removes. `{token}` is substituted anywhere in the value (so a PATH-parameter page configures `…/reset-password/{token}`); without the placeholder `?token=` is appended. A relative value resolves against `appUrl`. `false` keeps Better-Auth's link, including the early validation. Falls back to Better-Auth's link when no `appUrl` can be resolved — a guessed host would 404, which is worse than a working link. Separate from `email.passwordResetLink`, which serves the LEGACY flow. Since 11.38.0 both DEFAULTS produce `?token=`; the path-segment rule applies only to a CONFIGURED legacy value without `{token}` (a boot warning names that divergence). Resolution order here gained a step: explicit config → the caller's validated `redirectTo` → `<appUrl>/auth/reset-password` → Better-Auth's own link; `false` still wins over a `redirectTo`. Implementation: `core-better-auth-email-verification.service.ts` → `buildPasswordResetUrl()` |
| Security Headers | `security.headers` | Boolean Shorthand — **safe default** | **ON without configuration** (11.38.0+). `X-Content-Type-Options: nosniff`, `X-Frame-Options: DENY`, `Referrer-Policy: strict-origin-when-cross-origin`, `X-Powered-By` removed. HSTS `max-age=31536000; includeSubDomains`, **`preload` off** (it commits every subdomain to a browser-vendor list that is awkward to reverse — the domain owner's decision, not a framework default). **No CSP** — a wrong one breaks the app rather than hardening it, and this package serves its own HTML from the Hub and the GraphQL playground; set `contentSecurityPolicy` explicitly if you want one. Registered as MIDDLEWARE, not an interceptor, so a request a guard rejects carries the headers too — those are the responses an attacker generates most of. **HSTS is decided by the request protocol, never by configuration**: `x-forwarded-proto` first (first hop of a chain), connection protocol as fallback. A browser REMEMBERS the header, so one sent from a dev server over `http://localhost` makes every project on that host unreachable over http for up to a year, unrecoverably — which is why no flag can switch it on where it does not belong. This also makes `trustProxy` load-bearing: behind a TLS-terminating proxy the inward connection is plain http. A reverse proxy setting the same headers wins (it writes last); this layer exists so a deployment without one, or a local instance, is not bare. `false` disables everything. Implementation: `common/middlewares/security-headers.middleware.ts` |
| Password-Reset Enumeration | `auth.passwordReset.preventUserEnumeration` | Explicit Boolean — **safe default** | **`true` since 11.38.0.** `POST /users/password/reset-request` answers identically for a known and an unknown address; before, it answered 404 vs 201, a working oracle for "does this person have an account", which in a multi-tenant product also answers who works at which customer. Deliberately NOT the same switch as `auth.preventUserEnumeration` (which governs SIGN-IN messages and defaults to `false`): at sign-in the distinction is genuine UX, while a reset request carries no password at all — the only thing given up is the form's ability to say "unknown address". **The status code is the smaller half.** Response TIME separates the cases far more: the known path sends mail, a network round trip orders of magnitude above everything else. `setPasswordResetTokenForEmail()` returns `null` instead of throwing and still generates a token so the CPU cost matches, but the send lives in the CALLER — a `sendPasswordResetMail()` that AWAITS it leaks the difference regardless. The reference implementation (`src/server/modules/user/user.service.ts`) does not await; copy that shape. Set `false` to restore the pre-11.38.0 behaviour |
| Legacy Auth Endpoints | `auth.legacyEndpoints` | **Explicit Opt-In** (a fourth shape — see below) | **`enabled: false` since 11.38.0** (was `true`). The legacy password-authentication surface — `signIn`/`signUp`/`logout`/`refreshToken` over GraphQL, `/auth/*` over REST — is reachable only when asked for. Disabled endpoints answer HTTP 410 Gone. Only relevant for the three-argument `CoreModule.forRoot(CoreAuthService, AuthModule.forRoot(...), envConfig)`; the one-argument form never registers the module. Resolution, via the exported `isLegacyEndpointEnabled(config, transport)`: `enabled: false` wins over everything; else a per-transport boolean (`graphql` / `rest`) wins; else `enabled === true`; else **off**. The asymmetry is deliberate — an explicit `enabled: false` is a HARD off switch that a per-transport `true` cannot reopen, because it is the setting a project reached for to close legacy down and an upgrade must never widen it. Non-boolean values (config arrives as JSON through `NSC__*`) are read as "not set", so the string `'false'` cannot switch a transport ON by truthiness. `CoreLegacyAuthDeprecationInitializer` reports both directions at boot: a warning while the surface is open, and a warning when it is closed while users are still unmigrated. Env var: `LEGACY_AUTH_ENABLED`, matched strictly against `'true'`. Implementation: `auth/helpers/legacy-endpoints.helper.ts` |
| Password-Reset Token Lifetime | `auth.passwordReset.tokenExpiresInMinutes` | **Numeric Sentinel — Family C** (see above) | **60 minutes since 11.38.0. Before that the legacy reset token NEVER expired** — `resetPassword()` looked it up by value and compared no time, while the exception it threw read "Invalid or expired password reset token", claiming a check that did not exist. A reset link takes over an EXISTING account, so an unbounded one means a mail in an archive or a restored backup opens that account years later. The IAM half already expired after an hour (Better-Auth's `resetPasswordTokenExpiresIn`); only the legacy half had nothing. `0` opts out; an invalid value falls back to 60, never to unbounded. **A token minted before 11.38.0 carries no timestamp and is treated as EXPIRED** — reading "no timestamp" as "valid forever" would preserve the defect permanently rather than for a migration window. An expired token is answered exactly like an unknown one (404, same message) and deleted on sight. Model field `passwordResetTokenExpiresAt`, `@Restricted(S_NO_ONE)`. Implementation: `core-user.service.ts` → `passwordResetTokenExpiryMinutes()` / `isPasswordResetTokenExpired()` |
| Legacy Password-Reset Link | `email.passwordResetLink` | Explicit Value with derived default | **`<appUrl>/auth/reset-password?token={token}` since 11.38.0.** Two conventions live here and which applies depends on whether the option is set AT ALL: unset yields `?token=`, the same string written out yields a PATH segment. That is deliberate — a project that configures such a value has a page built for a path parameter, and moving it silently would break the flow this release repairs — and because it is not guessable, `CoreUserService` **warns once at boot** when a configured value carries no `{token}`. The warning names a precondition: `{token}` is substituted by `buildPasswordResetLink()` and nothing else, so a caller still concatenating by hand must switch FIRST or it mails the placeholder verbatim. Returns `null` rather than a string containing `undefined`; resolves `appUrl` through `resolveServerUrls` (localhost defaults, host-split `baseUrl`) and honours `cors.deriveAppUrl` |
| SMTP TLS Mode | `email.smtp.secure` + `SMTP_REQUIRE_TLS` | Derived from the port | **`secure` follows `SMTP_PORT` unless set to `'true'`/`'false'`.** It is not an independent setting: 465 negotiates TLS immediately, everything else upgrades via STARTTLS. The production profile shipped 587 + `secure: true` — a pair that cannot connect — so a deployment configuring only host and credentials sent NO mail, invisibly, because authentication mail is not awaited. Only the two canonical values override; anything else defers to the port, which is the only rule under which no input produces an unconnectable pair. `requireTLS` defaults to **true**: `secure: false` alone means opportunistic STARTTLS, and an on-path attacker stripping the capability line gets credentials and a live reset link in plaintext. `EmailService` warns once when the resolved pair cannot connect — reported, not overruled. Implementation: `config.helper.ts` → `resolveSmtpSecure()` / `isImpossibleSmtpTlsCombination()` |
| Legacy Auth Rate Limiting | `auth.rateLimit` | Presence Implies Enabled | `max: 10`, `windowSeconds: 60`. Counters live in a `RateLimitStore`: `RedisRateLimitStore` when `redis` is configured (limit enforced EXACTLY across replicas instead of `max × replicas`), else `InMemoryRateLimitStore` (previous behavior). On a Redis outage it degrades to the in-memory counter and logs once per transition — never a 500, never "allowed". `check()` / `reset()` / `clear()` are ASYNC since 11.33.0; `getStats().activeEntries` is `-1` on the Redis store |
| BetterAuth Rate Limiting | `betterAuth.rateLimit` | Presence Implies Enabled | `max: 10`, `windowSeconds: 60`. Same `RateLimitStore` selection, degradation and async signatures as the Legacy Auth row (namespace `better-auth`) |
| BetterAuth JWT Plugin | `betterAuth.jwt` | Boolean Shorthand | `expiresIn: '15m'` |
| BetterAuth 2FA Plugin | `betterAuth.twoFactor` | Boolean Shorthand | `appName: 'Nest Server'` |
| BetterAuth Passkey Plugin | `betterAuth.passkey` | Boolean Shorthand | `rpName: 'Nest Server'` |
| BetterAuth Cross-Subdomain Cookies | `betterAuth.crossSubDomainCookies` | Boolean Shorthand | `domain: auto (appUrl → baseUrl without api. prefix)` |
| BetterAuth Disable Sign-Up | `betterAuth.emailAndPassword.disableSignUp` | Explicit Boolean | `false` (sign-up enabled) |
| BetterAuth Native Password Reset | `betterAuth.emailAndPassword.passwordReset` | Explicit Boolean | **`true` — ON by default, and there is no other off switch.** Better-Auth treats the PRESENCE of an `emailAndPassword.sendResetPassword` hook as the enable flag, and `CoreBetterAuthModule` always injects one (delegating to `CoreBetterAuthEmailVerificationService.sendPasswordResetEmail()`). So `POST /iam/request-password-reset` is a live, **unauthenticated**, token-minting, mail-sending endpoint on every deployment — before 11.36.1 it answered `RESET_PASSWORD_DISABLED` because no hook was wired. Set `false` to withhold the hook and restore that refusal, for deployments whose reset policy is support-mediated or SSO-primary. **Two things bound the abuse and both need checking:** a per-ADDRESS cooldown in the mailer (reuses `emailVerification.resendCooldownSeconds`, own namespace so a pending verification mail cannot block a reset), and the IP-axis `betterAuth.rateLimit` in front of the route — which is OFF unless configured. `/request-password-reset` is in `strictEndpoints`, so it gets the halved limit. Implementation: `better-auth.config.ts` (graft), `core-better-auth-email-verification.service.ts` (delivery) |
| BetterAuth Password-Reset Brevo Template | `betterAuth.emailVerification.passwordResetBrevoTemplateId` | Presence Implies Enabled | `undefined` → SMTP/EJS path. When set, the reset mail goes out through the Brevo transactional API with that template id. **Deliberately does NOT fall back to `brevoTemplateId`**: that one is the VERIFICATION mail, and reusing it would tell somebody who asked to reset their password to confirm their address instead. A Brevo send that resolves to `null` (its way of reporting failure unless `brevo.throwOnError` is set) falls THROUGH to SMTP rather than returning, so an outage does not leave a locked-out user with no mail at all. Template variables: `name`, `link`, `appName` |
| BetterAuth Revoke Sessions on Password Reset | `betterAuth.emailAndPassword.revokeSessionsOnPasswordReset` | Explicit Boolean | `false` (existing sessions survive a reset). Forwarded to Better-Auth's native flag, which honours it on **all three** reset routes (password reset, email-OTP, phone-number). **Off by default because it is a behaviour change for an existing deployment** — after a reset the user is signed out everywhere, including on the devices they still hold. Turn it on where a reset is what somebody reaches for after a suspected takeover: otherwise the attacker keeps their session and the new password changes nothing for them. Matched with `=== true`, so a truthy-but-not-`true` value arriving as JSON through `NSC__*` / `NEST_SERVER_CONFIG` does not silently enable a sign-out-everywhere behaviour. **Prefer the named field over `betterAuth.options`**: it is validated (`=== true`), typed and discoverable. Until 11.36.1 the reason was harsher — `config.options` was spread SHALLOWLY over the resolved config (only `advanced` was deep-merged), so an `options.emailAndPassword` REPLACED the whole block including the scrypt `password.hash` / `password.verify` pair the framework installs, and every credential in the database stopped verifying, at runtime and without a boot error. Since 11.36.1 `emailAndPassword` is deep-merged too, with `password` merged key-by-key on top of the framework's pair (an explicit override still wins; an explicitly-`undefined` half is ignored, because Better-Auth resolves `password?.hash || hashPassword` and would otherwise switch hasher for writes while scrypt still handled reads). That merge is pinned against the REAL `createBetterAuthInstance()` by `tests/unit/better-auth-password-reset-wiring.spec.ts`, with registered mutation `betterauth-emailandpassword-shallow-merge` as its evidence. Implementation: `better-auth.config.ts` (`emailAndPassword` block) |
| BetterAuth Server-Managed User Fields | `betterAuth.additionalUserFields[].input` | Explicit Boolean | `true` (Better-Auth default). `input: false` makes Better-Auth reject client-supplied values (`FIELD_NOT_ALLOWED` HTTP 400 on `/iam/update-user`; server default substituted on sign-up). The core fields `roles`, `verified`, `verifiedAt`, `twoFactorEnabled`, `iamId` are hard-locked to `input: false` via `PROTECTED_INPUT_FALSE_KEYS`, **re-asserted after** the `additionalUserFields` merge (and for any shadow field whose `fieldName` maps to a protected column) — a project override cannot re-open them. Closes vertical privilege-escalation (self-granting `roles`), email-verification bypass and 2FA self-toggle via the Better-Auth native input path. nest-server's own role path (`UserService.setRoles` / `CrudService.update` `checkRoles`) is unaffected. `termsAndPrivacyAcceptedAt` is `input: false` by default but intentionally NOT hard-locked (consent timestamp, not a privilege boundary) |
| Hub (Operator Cockpit) | `hub` | Presence Implies Enabled — but NEVER implicitly (must be set per environment) | `path: 'hub'`, `roles: [ADMIN]`, `actions: true`, `pollIntervalMs: 5000`, `collectors: { logs: on, traces: on, queries: off }`, `mailbox: off` (when set: `mode: 'capture'`, throws in production/staging), `migrations: { dir: './migrations' }`, `db: on`, `emailPreview: on`. Build-free ADMIN-gated dashboard (dashboard, diagnostics, logs, request traces, query profiler, cron, db, models/ERD, migrations, files, config, auth-migration, error-codes, email preview, mailbox, AI). Query profiler opts the driver into `monitorCommands`. Mailbox is a Mailpit-style capture hooked into `EmailService` via the optional `HUB_EMAIL_CAPTURE` token. Mutating actions require `X-Hub-Request` header + type-to-confirm keyword and write `[HUB-ACTION]` audit logs. Overrides via `CoreModule.forRoot(env, { hub: { controller, actionsController, service, htmlService, actionsService } })` |
| System Setup | `systemSetup` | Enabled by Default (when BetterAuth active) | `initialAdmin: undefined` |
| GraphQL | `graphQl` | Explicit Disable (`false`) | Enabled (full GraphQL stack) |
| Mongoose Password Plugin | `security.mongoosePasswordPlugin` | Boolean Shorthand | `true` (enabled), `skipPatterns: []` |
| Mongoose Role Guard Plugin | `security.mongooseRoleGuardPlugin` | Boolean Shorthand | `true` (enabled), `allowedRoles: []`. Bypass: `RequestContext.runWithBypassRoleGuard()` or `force: true` |
| Mongoose Audit Fields Plugin | `security.mongooseAuditFieldsPlugin` | Boolean Shorthand | `true` (enabled) |
| Response Model Interceptor | `security.responseModelInterceptor` | Boolean Shorthand | `true` (enabled), `debug: false` |
| Translate Response Interceptor | `security.translateResponseInterceptor` | Boolean Shorthand | `true` (enabled) |
| Secret Fields Removal | `security.secretFields` | Array | `['password', 'verificationToken', ...]` |
| Multi-Tenancy | `multiTenancy` | Presence Implies Enabled | **`excludeSchemas` is an OFF SWITCH for isolation, per model** — a listed schema gets no tenant filter at all; since 11.35.0 the plugin WARNS once per model when the excluded schema declares `tenantId` (i.e. was built for isolation). The framework's own docs recommended `['User', 'Session']` until then; that is withdrawn — it is only right for the global-user model. Since 11.35.0 GraphQL operations over the WEBSOCKET also run inside a `RequestContext` (`CoreModule` installs a context-aware `execute`/`subscribe` pair inside `subscriptions`, where `ApolloDriver` forwards it): the tenant comes from the handshake header validated against an active membership, else from the subscriber's memberships, and an unresolvable tenant leaves the safety net to refuse the read rather than returning everything. `headerName: 'x-tenant-id'`, `membershipModel: 'TenantMember'`, `adminBypass: true`, `excludeSchemas: []`, `roleHierarchy: { member: 1, manager: 2, owner: 3 }`, `cacheTtlMs: 30000` (0 disables, process-local). System roles (`S_EVERYONE`, `S_USER`, `S_VERIFIED`) are checked as OR alternatives before real roles; method-level system roles take precedence; membership validated for context when system role grants access + header present. Hierarchy roles use level comparison, normal roles use exact match. Use `DefaultHR` or `createHierarchyRoles()` for type-safe role constants. Bypass: `RequestContext.runWithBypassTenantGuard()`. Cache invalidation: `invalidateUser(userId)` / `invalidateAll()` are **instance** methods on the singleton `CoreTenantGuard` — inject it and call `this.tenantGuard?.invalidateUser(userId)`, never `CoreTenantGuard.invalidateUser(...)` (there is no static). With `redis` configured, both additionally BROADCAST the invalidation to every replica (`<keyPrefix>:tenant-cache:invalidate` pub/sub); without Redis they clear the local process only, so other replicas stay stale until `cacheTtlMs`. A received broadcast clears locally without re-publishing |
| BetterAuth Tenant Skip | `betterAuth.skipTenantCheck` | Explicit Boolean | `true` (default). When `true` and no `X-Tenant-Id` header is sent, IAM endpoints (controller + resolver) skip `CoreTenantGuard` tenant validation. When header IS present, normal membership validation runs regardless. Set `false` for tenant-aware auth scenarios (subdomain-based, invite links, SSO per tenant) |
| Debug Process Input | `debugProcessInput` | Explicit Boolean | `false` (default). When `true`, logs a debug message when `prepareInput()` changes the input type during `process()`. Has performance cost due to `JSON.stringify` on every `process()` call — enable only for debugging |
| JSONTransport Production Guard | `email.smtp` with `jsonTransport` | Runtime Guard | Throws `Error` when `email.smtp` has a truthy `jsonTransport` property in `production` or `staging` environments (read from config `env` field). JSONTransport silently discards all outgoing mail — the guard prevents accidental misconfiguration that causes password-reset, 2FA, and verification emails to vanish. Use `{ jsonTransport: true }` only in CI/e2e/local environments |
| Cookies | `cookies` | Boolean Shorthand (default true) | `true` (enabled), `exposeTokenInBody: false`. When enabled: loads `cookie-parser`, sets CORS `credentials: true`, sets signed httpOnly session cookies. When `exposeTokenInBody: true`: a token stays in the response body alongside the cookies — but **the two carry DIFFERENT values** once the JWT plugin is also active. The body gets a JWT (what a bearer client needs), the cookie keeps the **opaque session token**, because Better-Auth resolves a session by exactly that value. Reading this row as "the same token in two places" is what produced 11.36.3: the cookie was written from the body's JWT, sign-in succeeded and every following request was anonymous. `setSessionCookies()` now refuses a JWT-shaped cookie value outright. Note `assertCookiesProductionSafe()` forbids `exposeTokenInBody` in `production`/`staging`, so this combination exists only in development and CI. JWT via `Authorization: Bearer` always works independently. **BetterAuth cookie name (since v11.27.6):** `createBetterAuthInstance()` pins `advanced.useSecureCookies: false` so BetterAuth's native handlers read the same UNPREFIXED `<cookiePrefix>.session_token` the helper writes (fixes a `401` split-brain on 2FA/passkey/`/token`); the `Secure` attribute is still applied on an `https://` baseURL via `advanced.defaultCookieAttributes`. Opt back into the `__Secure-` prefix with `betterAuth.options.advanced.useSecureCookies: true` only when BetterAuth manages cookies entirely |
| CORS | `cors` | Boolean Shorthand | `enabled: true`, `allowAll: false`, `deriveAppUrl: true`. Origins come from `appUrl`/`baseUrl`, resolved by the shared `resolveServerUrls()` helper (`cookies.helper.ts`) that ALL three CORS layers use (GraphQL, REST, BetterAuth `trustedOrigins`) — they can no longer drift. `appUrl` resolution: explicit → derived from a **host-split** localhost `baseUrl` (its `api.` label strips to a sibling host: `https://api.crm.localhost` → `https://crm.localhost`, as served by `lt dev up`; the port is preserved) → localhost default (`http://localhost:3001`, only for `env: local`/`ci`/`e2e` with a **port-split** localhost `baseUrl` — one host, API `:3000`, app `:3001`; `https://api.localhost` strips to the bare `localhost` the API already answers on and is therefore a port split, not a host split) → derived from `baseUrl` by stripping a leading `api.` label (`https://api.example.com` → `https://example.com`). **Security:** the derived origin receives credentialed CORS; set `deriveAppUrl: false` when the apex domain is not trusted, then list the frontend origin via `appUrl`/`allowedOrigins` (a host-split localhost `baseUrl` then falls back to the localhost default). The derivation never yields a bare TLD (`https://api.dev` unchanged) and never emits the opaque `null` origin (non-http(s) `baseUrl` passes through verbatim). `allowAll: true` mirrors the request origin for REST/GraphQL, but BetterAuth's `trustedOrigins` still resolve to `[appUrl]` (+ passkey origins) — an origin check has no "allow everything" mode, so a separately hosted frontend must appear in `appUrl`/`allowedOrigins` (or set `betterAuth.trustedOrigins` explicitly). `enabled: false` disables CORS on all layers including BetterAuth (`trustedOrigins: []`, which still trusts BetterAuth's own `baseURL`). Explicit `betterAuth.trustedOrigins` always takes precedence |
| Central Redis | `redis` | Boolean Shorthand + Presence Implies Enabled | `host: 'localhost'`, `port: 6379`, `db: 0`, `keyPrefix: <package.json name, slugified>` (per APPLICATION, not per framework — a constant default silently collides when two apps share one Redis; set it explicitly when sharing IS intended); `url` (takes precedence over host/port/db/credentials), `username`/`password`, `options` (passed to the ioredis constructor). `true` / `{}` enables with defaults; `{ enabled: false }` pre-configures without enabling; **absent = every consumer keeps its process-local fallback** (that fallback is the whole backward-compatibility story of 11.33.0). Requires the OPTIONAL peer `ioredis` — configured-but-missing **fails the boot** with a named error rather than crashing on first use. `keyPrefix` is applied by the framework per key, NOT as ioredis `keyPrefix` (that would collide with BullMQ's own prefix). One `CoreRedisService` serves all features: shared client (`getClient()`), one cached subscriber (`getSubscriber()` — a subscribing client cannot run commands), dedicated connections (`createClient(label)`); all are tracked and quit on shutdown. Switches on automatically: exact cross-replica rate limits via `RedisRateLimitStore` (see the Legacy Auth / BetterAuth / AI rate-limit rows), cron dedup (see Cron Job Deduplication row), `CoreRedisPubSub` as `PUB_SUB` for cluster-wide GraphQL subscriptions (**payloads must be JSON-serializable — `Date`, class instances, `Map`/`Set`, `undefined` do not survive**), tenant-cache invalidation broadcast, Hub collector mirroring, MCP session registry (turns a wrong-replica request from a misleading `404` into a `409` — `/ai/mcp` still REQUIRES sticky sessions, sessions are not portable) |
| File Access Roles | `file.downloadRoles`, `file.uploadRoles`, `file.deleteRoles` | Config-Driven Role List | `[RoleEnum.ADMIN]` each. **These are the only breaking change a single-replica project gets in 11.33.0** — six members moved from `@Roles(S_EVERYONE)` to these knobs: `GET /files/id/:id`, `GET /files/:filename` and `getFileInfo` (`downloadRoles`), `uploadFile` / `uploadFiles` (`uploadRoles`), `deleteFile` (`deleteRoles`). Plain role STRINGS, not `RoleEnum` members, so project roles work (`['company-admin', 'editor']`). Applied at boot by `applyFileRoles()` via `Reflect.defineMetadata('roles', …)` on the base-class methods — the same runtime mechanism `CorePermissionsModule` uses, because the value is only known from config. **`[]`, a non-array, or an array holding a non-string is REJECTED with a warning and the default applies** — an all-empty role set reads to the guards as "no roles required" and would OPEN the route, the exact opposite of the intent. **ADMIN is always unioned in**: both `CoreFileController` and `CoreFileResolver` carry a class-level `@Roles(RoleEnum.ADMIN)` and the guards UNION class + handler metadata, so these knobs can grant but never exclude admins. Both classes also carry `@SkipTenantCheck()` — GridFS and the S3 metadata collection are reached outside Mongoose, so `mongooseTenantPlugin` never scopes them and a role name alone cannot express a per-tenant rule; roles resolve against `user.roles`, never `membership.role`. **A subclass that OVERRIDES a member opts out permanently** (decorator metadata lives on the function object, and an override is a different function) — inherit the member instead. **Since 11.35.1 that opt-out is REPORTED**: `CoreFileAccessAuditInitializer` reads the roles off the class the project actually registered at `onApplicationBootstrap` (the earliest point at which the route table exists, which is why it is a provider and not part of `applyFileRoles()`) and warns when a member is open beyond ADMIN for a reason the configuration cannot explain — the case the construction-time warning below is structurally blind to. It only REPORTS: overwriting an override's metadata, the way `TusModule.applyRoles()` does, would silently relax a route a project pinned on purpose. Roles are the coarse filter only; per-file rules belong in `CoreFileService.checkRights()`, which now receives `currentUser` and can read raw metadata via `getRawFileInfo()`. **Since 11.35.0 a reused FILENAME resolves to the most recent file** in all three stores (`uploadDate` desc, `_id` tie-break) and every by-name read path resolves a document and then reads by ID — under GridFS the by-name metadata lookup answered the oldest document while `openDownloadStreamByName()` served the newest, so a per-file rule approved one file and the bytes of another came back. Consequence: `duplicateById()` keeps the source's filename and the copy carries no metadata, so the copy now wins the name and an `ownerId` rule refuses it — give the copy its own metadata or its own name. **Since 11.35.0 `CoreFileService` WARNS at construction** when `multiTenancy` is active AND a knob names a role other than ADMIN AND `checkRights()` is not overridden — the file stores are reached outside Mongoose, so these role names resolve against `user.roles` (global) and every holder reaches every tenant's files; only `checkRights()` can narrow that. Silent on the admin-only default and silent when a per-file rule exists. Implementation: `src/core/modules/file/file-roles.config.ts` (`FILE_ROLE_DEFAULTS`, `FILE_ROLE_MEMBERS`, the three warnings, the shared `hasDeclaredFilePolicy()` silencer) + `file-roles.helper.ts` (`applyFileRoles`) + `core-file-access-audit.initializer.ts` (the registered-class audit) |
| TUS Roles | `tus.roles` | Config-Driven Role List | `[RoleEnum.S_USER]` (was `S_EVERYONE` — breaking). A TUS upload writes into the SAME store the download routes guard, and the termination extension (on by default) can delete from it, so anonymous writes into a store only privileged callers may read is the wrong way round. Applied by `TusModule.applyRoles()` onto the registered controller class **and** onto `handleTus` / `handleTusWithId`. Same rejection rule as the file roles: `[]` / non-array / non-string → warning + `DEFAULT_TUS_CONFIG.roles`. **`OPTIONS` is deliberately exempt**: `handleTusOptions` / `handleTusOptionsWithId` keep their own handler-level `@Roles(RoleEnum.S_EVERYONE)`, because that is the CORS preflight — browsers send it WITHOUT credentials, and it returns server capabilities only. Gating it would make every browser upload fail before the first byte. `CoreTusController` also carries `@SkipTenantCheck()`. A custom controller is covered as long as it INHERITS the handlers; one that re-declares `@All()` / `@Roles()` carries its own metadata and thereby opts out — the documented way to hard-code a policy config must not be able to change. **Set `roles: [RoleEnum.S_EVERYONE]` explicitly if you accept attachments on a public form.** **Since 11.35.0 `tus.roles` is no longer the only gate**: `onUploadCreate` records the authenticated creator under `TUS_OWNER_METADATA_KEY` (`ltOwnerId`, always OVERWRITING any client-supplied value) and `onIncomingRequest` refuses HEAD/PATCH/DELETE naming an upload the caller does not own — with **404**, the file module's refusal policy. Before that, any authenticated caller who learned an upload id could APPEND BYTES to somebody else's upload, which are then migrated into the file store under the victim's filename. The finished file also gains `metadata.ownerId`, without which the documented per-file ownership rule could never authorize a tus-uploaded file (admin-only in practice). An OWNER-LESS upload stays reachable — uploads predating 11.35.0 have none, and neither does a deliberately public form. `readRequestUserId()` / `assertUploadOwnership()` are `protected`. Note that `@tus/server` v2 hands its hooks a WHATWG `ServerRequest`, so a guard's `req.user` is reachable only via `runtime.node.req`. Implementation: `src/core/modules/tus/tus.module.ts`, `src/core/modules/tus/core-tus.service.ts`, `src/core/modules/tus/tus.constants.ts` |
| File Storage | `file.storage` + `file.storageDir` + `s3` | Explicit Enum with DERIVED default | `'filesystem' \| 'gridfs' \| 's3'`. **Unset → derived**, most capable first: `'s3'` when `s3.bucket` is set, else `'gridfs'` when `mongoose.uri` is set, else `'filesystem'`. **Set → enforced**: an unavailable store FAILS THE BOOT (`assertFileStorageAvailable()`), it never falls back — a silent fallback puts files in a store the operator does not believe they are in, unrecoverably. A DERIVED driver is enforced too (`s3.bucket` set but `s3Service` not forwarded to `super()` → boot error). Metadata always lives in MongoDB whichever driver holds the bytes (`fs.files` / `s3-files` / `filesystem-files`) — it has to stay queryable for `findFileInfo()` and `checkRights()`. Reads consult ALL stores so switching drivers is forward-only with no migration; writes go to the active driver only. `'filesystem'` is pod-local: not shared between replicas, lost on restart unless `storageDir` is a mounted volume. `s3`: `bucket` (required — the one thing S3 cannot default, hence the eligibility test), `region: 'us-east-1'`, `forcePathStyle: false`, `autoCreateBucket: false` (off by design: production buckets come from infrastructure code, whose credentials usually cannot CreateBucket), `stagingBucket: bucket`, `presignedDownloads: false` (`true`/`{}` → `expiresInSeconds: 300`), `endpoint` (MinIO/RustFS), `accessKeyId`/`secretAccessKey` (omit → AWS default credential chain), `enabled: false` to pre-configure. Requires the OPTIONAL peer `@aws-sdk/client-s3`, plus `@aws-sdk/s3-request-presigner` for presigned downloads. `presignedDownloads` makes `GET /files/id/:id` answer `302` to a time-limited S3 URL instead of streaming — the URL is a bearer capability, authorized once at issue time. The resolved driver is logged at boot (`[CoreFileStorage] File storage: …`) |
| TUS S3 Staging | `tus.s3Staging` | Explicit Boolean (default ON when S3 configured) | `true` when `s3` is configured, otherwise inert. Stages in-progress uploads in `s3.stagingBucket` via `@tus/s3-store` instead of `tus.uploadDir` on local disk, so resumable uploads survive replica restarts and need no sticky sessions. Set `false` to force local disk. Missing OPTIONAL peer `@tus/s3-store` → warning + fall back to local disk (NOT a boot failure). **Give the staging bucket a lifecycle rule expiring incomplete multipart uploads** — the framework's own expiration cleanup is skipped in S3 mode (S3 is the right place for that policy), so aborted uploads otherwise accumulate parts nothing removes |
| Cron Job Deduplication | per job: `distributed` in `CronJobConfig` | Explicit Boolean | **`true` when `redis` is configured, otherwise `false`** — a single-replica project that upgrades must not silently gain a `cron-locks` collection, a lease write per tick, and a new way for a tick to be skipped. A Redis-less multi-replica fleet opts in per job with `distributed: true` (MongoDB lease). Mechanism: BullMQ job scheduler when Redis + the OPTIONAL peer `bullmq` are present AND `cronTime` is a string without `utcOffset`; otherwise local timer + lease (Redis `SET NX`, else a TTL-indexed `cron-locks` document). Tick lease TTL 3600 s. **Leases fail open** — an unreachable lease store runs the tick everywhere rather than stopping all scheduled work fleet-wide. **`runOnInit` (default `true`) deduplicates over a FIXED per-job key with a 300 s TTL**, because replicas do not share a boot instant: replicas booting within 5 min run the startup tick once between them, and a replica restarting inside that window SKIPS its startup tick — set `distributed: false` on jobs whose `runOnInit` work is per-process (warming a process-local cache). No constructor change needed: `CoreModule` fills `core-cron-jobs.registry.ts` via `CoreCronJobsInitializer` and `CoreCronJobs` reads it lazily; explicit `{ connection, redisService }` in `CoreCronJobsOptions` wins. With neither source it warns once and every replica runs every tick |
| Shutdown Delay | `shutdownDelayMs` | Numeric Sentinel — Family B (`0` = off) | `0` (default, no delay, no log). Waits N ms **in the SIGTERM/SIGINT handler, before `close()` is entered**, so a load balancer can finish deregistering while the instance is still fully healthy. NOT a lifecycle hook: `close()` runs `onModuleDestroy` → `beforeApplicationShutdown` → dispose → `onApplicationShutdown`, so a delay in `beforeApplicationShutdown` would wait with every module already torn down while the socket still accepts — worse than no delay. **Requires `installGracefulShutdown(app)` in main.ts, which REPLACES `server.enableShutdownHooks()`** — keeping both makes Nest close the app in parallel with the wait, so the delay silently never happens. At delay `0` the helper IS `enableShutdownHooks()`. **Keep the value well below the orchestrator grace period AND leave room for the drain that follows**: Compose `stop_grace_period` 10s, Kubernetes `terminationGracePeriodSeconds` 30s, and `installProcessDiagnostics()` force-exits after 30s — exceed any and the process is SIGKILLed mid-wait with no hook running. Warns above `10000`, capped at `60000`. Non-numeric / negative values behave like `0` |
| Trust Proxy | `trustProxy` | Explicit Value (pass-through, Express default) | `false` (Express's own default — the forwarded chain is not trusted). Passed verbatim to `app.set('trust proxy', …)` by `CoreTrustProxyInitializer`, a `CoreModule` provider, so a consumer inherits it by upgrading and needs no `main.ts` edit. Accepts `false` / a hop count (`1`, `2`) / `'loopback'` / a subnet list — **not** Express's predicate function: the value must survive `NEST_SERVER_CONFIG` / `NSC__*` (JSON) and the ConfigService deep clone. **This is what makes `request.ip` correct, and every IP-keyed rate limit depends on it**: unset behind Caddy/nginx/an ingress, `req.ip` is the PROXY address for every request, so all clients share ONE bucket and `auth.rateLimit.max` throttles everybody at once — exactly fleet-wide once `redis` is configured. Trusting MORE hops than exist is the opposite failure: a client prepends its own header entry and picks a fresh bucket per request. Applied at module init (inside `app.init()`/`listen()`, i.e. AFTER `main.ts`), so a configured value wins over a hand-written `app.set()`; an UNSET value is never applied, which keeps `app.set('trust proxy', fn)` in `main.ts` available as the escape hatch for the predicate form. **Unset + an IP-keyed limiter enabled (`auth.rateLimit` / `betterAuth.rateLimit`) logs a boot warning naming the shared-bucket consequence**; `trustProxy: false` is the explicit "nothing proxies me" answer that silences it. The AI limiter keys on the user id and is unaffected |
| AI Egress Allowlist (SSRF) | `ai.allowedBaseUrlHosts` | Explicit Value — **unset = permissive**, malformed = INTERPRETED or reported, never silently off | `undefined` → no restriction, so a local provider (Ollama on `localhost:11434`) works out of the box. Set → only those hosts are reachable, matched against `URL.host` (incl. port) and `URL.hostname`. **Accepts an array OR a comma-separated string, and the string form is not a convenience** — it is what the framework's own env mapping produces: `NSC__AI__ALLOWED_BASE_URL_HOSTS` becomes `{ ai: { allowedBaseUrlHosts: '<string>' } }` and lodash `merge` assigns that scalar straight over a configured array. Until 11.39.x a bare `!Array.isArray(...) -> return` read that as "not configured" and skipped the check entirely, so the canonical `NSC__` spelling silently disabled SSRF egress control with no log line at all. Entries are trimmed, lowercased and stripped of a fully-qualifying trailing dot, and the SAME normalisation is applied to the URL, so neither side wins by spelling one DNS name differently; a bare hostname entry matches any port, and an entry naming the scheme's default port (`example.com:443` on https) also matches the portless URL. A value that is neither array nor string carries no hostnames — the allowlist is then inactive and that is LOGGED as an error, because from the outside it looks exactly like "correctly unset". Enforced on **all three** outbound paths (`chat()`, the capability `probe()`, and `probeContextWindow()` — the last was unguarded before 11.39.x and is reachable from an ordinary user prompt via `detectAndPersistCapabilities()`, before the rate limit). Implementation: `openai-compatible.provider.ts` → `assertBaseUrlAllowed()` / `resolveAllowedBaseUrlHosts()` |
| AI Run Time Limit | `ai.maxRunMs` | **Numeric Sentinel — Family A** (`0` = no limit) | `0` (omitted = unbounded, the previous behaviour). Wall-clock ceiling for ONE prompt run, checked before each agent-loop iteration; once exceeded the run stops and answers with whatever it has. **Without it a run's only bound is `maxIterations` MULTIPLIED BY the connection's per-call timeout** — 8 iterations at the 120s default is a request that can legitimately hold a socket, its message buffer and a request context for 16 minutes, and compaction can add a call per iteration on top. Guarded as `maxRunMs > 0`, never `<= 0`: a value arriving as a non-numeric string through `NSC__AI__MAX_RUN_MS` (the reader coerces only `'true'`, `'false'` and numbers) yields `NaN`, and `NaN > 0` is `false`, so a misconfiguration degrades to "no limit" rather than to an instantly-expired deadline that would break every prompt. Set it to something a client would actually wait for. Implementation: `core-ai.service.ts` -> `runDeadlineExceeded()` |
| AI Assistant | `ai` | Presence Implies Enabled | Core: `maxIterations: 5`, `defaultMode: 'auto'` (or `'plan'`), `rateLimit` (presence implies enabled: `max: 20`, `windowSeconds: 60`), `systemPrompt`, `documentation` (injected into the system prompt), `encryptionSecret`. **DB-backed LLM connections** (`aiConnections`, admin CRUD) with AES-256-GCM-encrypted API keys (`AiCryptoService`, secret from `ai.encryptionSecret` / `NSC__AI__ENCRYPTION_SECRET` / `SECRETS_ENCRYPTION_KEY`; `apiKeyEncrypted` is a global `secretFields` entry, never returned — only `hasApiKey`); optional `defaultConnection` one-time seed. **Provider abstraction** (`ILlmProvider`, default `OpenAiCompatibleProvider` for any OpenAI-compatible endpoint via `fetch`; per-connection `supportsNativeTools`/`supportsJsonResponse` capabilities, emulated tool calling when native tools are unavailable). **Tool registry** (`AiToolRegistry`, tools self-register, role-filtered; tools may be `mutating`/`destructive` and define `authorize()` for pre-flight data-level checks). **Plan mode** (`input.mode: 'plan'`): full plan → pre-flight authorize ALL steps → all-or-nothing execution with a translated (de/en) error when any step is not permitted. **Confirmation policy**: `confirmation.mutating: { default, enforced }` + client `input.requireConfirmation` (ignored when enforced); `destructive` always confirms. **Client metadata** (`input.metadata`: URL/nav/console logs, untrusted+capped). **Multi-turn conversations** (`aiConversations`, owner-scoped). **SSE streaming** (`POST /ai/stream`). **Audit** (`audit: false` → persist to `aiInteractions`, admin-readable). **Token budgets** (`budget: { period: 'day'|'month'|'none', user: { maxTokens?, maxPrompts? }, tenant: { maxTokens?, maxPrompts? } }`, requires audit): per-user AND per-tenant limits with config defaults; admins override per user/tenant at runtime (`aiBudgetLimits`, `CoreAiBudgetService`). Resolution: override → default → unlimited (missing/0 = unlimited). Enforced before the run (HTTP 429 + translated). Each response carries a compact `budget` summary (promptTokens, usedTokens, remainingTokens, resetAt); full breakdown via `aiUsage` query / `GET /ai/usage`. **Self-optimizing prompts**: the system prompt is assembled from keyed fragments (`CoreAiPromptBuilderService` ships built-in defaults; works with zero rows). Admin-editable overrides per slot (`aiSlots`, admin CRUD, `/ai/slots`) scoped by `key`/`locale`/`capability`/`tenantId`, with tenant override/reset semantics and placeholder tokens resolved at run time via the placeholder registry. **Governed learning loop** (`promptLearning: { enabled: true, autoApply: false }`): tool errors record `suggested` hints (`aiPromptHints`, admin CRUD, `/ai/prompt-hints`) that only reach the prompt once admin-approved (or auto-approved when `autoApply`); hints only ADD guidance, never relax permissions. **Context window** (`contextWindow`, default 8192; auto-detected per connection via `ILlmProvider.detectContextWindow()` — Ollama `/api/show` probe / known-model table / Claude alias — and persisted): per-user/session history is trimmed (oldest non-system turns dropped, last truncated) and tool-results capped to `maxToolResultChars` (default 12000) so a session never overflows the model. A connection's window can be seeded via `ai.defaultConnection.contextWindow` (validated: a non-positive/non-integer value is dropped with a warning). **Capability drift check** (`capabilityDriftCheck`, default `false`): opt-in boot self-check that probes each enabled connection with an EXPLICIT `supportsNativeTools`/`supportsJsonResponse` (built with those flags cleared so the endpoint is actually re-probed) and logs a warning on mismatch — the stored value is never changed. OFF by default because it makes outbound calls to the LLM endpoints on every boot; also skipped in the ci/e2e runners. **Deferred tool schemas** (`deferToolSchemas`, default `false`): the system-prompt tool catalog then lists only tool NAMES + descriptions instead of full JSON schemas, and the model fetches a schema on demand via the built-in `search_tools` meta-tool — with a large registry the schemas alone can dominate a small context window. `deferToolSummaryChars` (default `0` = untruncated) additionally caps each description in that DEFERRED catalog: whole sentences up to the cap (always at least the first), word-boundary cut when the first sentence already exceeds it, and a `…` marker appended ON TOP of the cap. The default of `0` keeps the saving opt-in, so enabling `deferToolSchemas` alone never changes what a description says; set roughly 200–400 alongside it to actually reclaim the context. Both apply to EMULATED providers only — a connection with `supportsNativeTools: true` receives every full description + schema via `buildToolSchemas()` regardless, so truncation and the banner are skipped there rather than asserting a cut the tool payload contradicts. The omitted tail is where preconditions and role restrictions usually live — the catalog banner tells the model to fetch the full text via `search_tools` first, but this is model GUIDANCE only: authorization is enforced server-side by the registry's role filter (`forUser()`), the execution-time re-check, and the `mutating`/`destructive` flags read by the confirmation gate — never by what the catalog shows. (`AiTool.authorize()` runs in PLAN MODE only; in auto mode and over MCP, data-level checks must live inside `execute()`.) **MCP server** (`mcp: false` → `/ai/mcp` Streamable HTTP, Bearer auth, lazy `@modelcontextprotocol/sdk`; `mcp: { oauth: true, oauthSecret }` adds OAuth 2.1 — HMAC tokens + PKCE S256 + dynamic registration via `mountAiMcpOAuth(app)` in main.ts). Overrides via `CoreModule.forRoot(env, { ai: { budgetService, connectionResolver, connectionService, controller, conversationService, interactionService, mcpClientService, modeService, placeholderRegistry, preferenceService, promptBuilder, promptHintService, promptService, resolver, service, slotService, toolGrantService, toolPolicyService } })` |

## Module Override Pattern (via `ICoreModuleOverrides`)

For replacing default controllers, resolvers, or services of auto-registered core modules.

### Why a separate `overrides` parameter?

NestJS registers controllers at module scan time — there is no mechanism to replace them after registration.
When `CoreModule.forRoot()` auto-registers a module (e.g., ErrorCodeModule), the only way to use a custom controller
is to pass it **before** registration happens. A separate `overrides` parameter on `CoreModule.forRoot()` keeps
class references (code) cleanly separated from environment configuration (strings/numbers).

### Usage

```typescript
// IAM-only mode
CoreModule.forRoot(envConfig, {
  errorCode: { controller: ErrorCodeController, service: ErrorCodeService },
  betterAuth: { resolver: BetterAuthResolver },
})

// Legacy mode
CoreModule.forRoot(CoreAuthService, AuthModule.forRoot(envConfig.jwt), envConfig, {
  errorCode: { controller: ErrorCodeController, service: ErrorCodeService },
})
```

### Available Override Fields

| Module | Fields | Description |
|--------|--------|-------------|
| `ai` | `budgetService`, `connectionResolver`, `connectionService`, `controller`, `conversationService`, `interactionService`, `mcpClientService`, `modeService`, `placeholderRegistry`, `preferenceService`, `promptBuilder`, `promptHintService`, `promptService`, `resolver`, `service`, `slotService`, `toolGrantService`, `toolPolicyService` | Custom AI orchestrator, connection-resolution chain, connection/preference/budget/conversation/interaction/MCP-client services, slot + user-prompt + learning-hint stores, mode service, placeholder registry, tool-grant + tool-policy services, endpoints |
| `errorCode` | `controller`, `service` | Custom error code endpoint and/or service |
| `betterAuth` | `controller`, `resolver` | Custom IAM REST controller and/or GraphQL resolver |
| `hub` | `controller`, `actionsController`, `service`, `htmlService`, `actionsService` | Custom Hub page/actions controllers and aggregator/HTML/actions services (each must extend its `Core*` base) |

### Rules

1. Overrides take precedence over `betterAuth.controller`/`resolver` in config (backward compatible)
2. Only auto-registered modules are affected — `autoRegister: false` modules are imported separately
3. The `ICoreModuleOverrides` interface enforces type safety per module

### Alternative: `autoRegister: false`

For complex setups requiring additional providers or a custom module structure, disable auto-registration
and import the module separately:

```typescript
// config.env.ts
errorCode: { autoRegister: false }
betterAuth: { autoRegister: false }

// server.module.ts
@Module({
  imports: [
    CoreModule.forRoot(envConfig),
    ErrorCodeModule.forRoot({ controller: MyController, service: MyService }),
    BetterAuthModule.forRoot({ controller: MyController, resolver: MyResolver }),
  ],
})
```

## Checklist for New Configurable Features

When adding a new configurable feature:

### For "Presence Implies Enabled" Pattern:

- [ ] Define interface with `enabled?: boolean` as optional property
- [ ] Set `enabled: false` in DEFAULT_CONFIG
- [ ] Implement "presence implies enabled" logic in configure method
- [ ] Document all default values in interface JSDoc
- [ ] Add tests for: undefined config, empty object, partial config, explicit disable

### For "Boolean Shorthand" Pattern:

- [ ] Define separate interface for config options (e.g., `IBetterAuthJwtConfig`)
- [ ] Use union type: `property?: boolean | IPropertyConfig`
- [ ] Implement `isPluginEnabled()` helper for boolean/object handling
- [ ] Implement `getPluginConfig()` helper to normalize to object
- [ ] Add tests for: `true`, `false`, `{}`, `{ option: value }`, `{ enabled: false }`, `undefined`

### For "Module Override" Pattern:

- [ ] Add override fields to `ICoreModuleOverrides` interface
- [ ] Pass overrides through in `CoreModule.forRoot()` to the module's `forRoot()`
- [ ] Ensure the module's `forRoot()` accepts controller/resolver/service parameters
- [ ] Update this document with the new override fields
- [ ] Update module's INTEGRATION-CHECKLIST.md

### For Both Patterns:

- [ ] Update this document with the new feature
- [ ] Export new interfaces in `src/index.ts` (if needed)
