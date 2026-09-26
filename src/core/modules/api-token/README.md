# API Tokens

Bearer credentials for machine clients, scripts and embedded pages that cannot carry a session cookie
(an iframe inside a third-party application gets no `SameSite=Lax` cookie). Opt-in via `apiTokens`;
without it nothing changes.

|                     | USER token                                                                         | TENANT token                                            |
| ------------------- | ---------------------------------------------------------------------------------- | ------------------------------------------------------- |
| Belongs to          | one user                                                                           | one tenant — survives staff changes                     |
| Managed by          | its owner                                                                          | members holding `apiTokens.manageRole`, platform admins |
| Acts with           | its user's **current** rights, **without global roles** (ADMIN, `globalOnlyRoles`) | the **lowest** tenant role, never a global role         |
| Tenants             | the user's active memberships — optionally restricted to ONE                       | its own tenant only                                     |
| Optional limits     | scopes, one tenant, `maxTenantRole`, expiry                                        | scopes, expiry                                          |
| Needs multi-tenancy | no                                                                                 | yes                                                     |

Both kinds are **denied on every route** that does not declare `@ApiTokenScopes(...)`, public
routes included. Tokens never manage tokens.

## Configuration

```typescript
// config.env.ts
apiTokens: {
  scopes: ['upload', 'read', 'export'],   // the vocabulary routes and tokens use
  encryptionKey: process.env.API_TOKEN_ENCRYPTION_KEY, // required in production/staging
  // prefix: 'ltt',                       // tokens read ltt_…, assertions ltts_…
  // manageRole: 'owner',                 // default: highest role of multiTenancy.roleHierarchy
  // maxAssertionLifetimeSeconds: 900,
  // rateLimit: { max: 600, windowSeconds: 60 },   // per token; false switches it off
  // userTokens: true,
  // tenantTokens: true,                  // only takes effect with multiTenancy
}
```

`true` / `{}` enable with defaults, `{ enabled: false }` pre-configures. Full reference: `IApiTokens`
in `server-options.interface.ts`. The boot fails on an invalid prefix or scope, on a `manageRole` that
is not a declared tenant role, on a hierarchy in which the lowest role (a tenant token's role) reaches
the manage role, and in production/staging without an encryption key.

## Opening a route

```typescript
@ApiTokenScopes('upload')              // any ONE of the listed scopes; method replaces class
@Roles(RoleEnum.S_USER)
@Post('documents')
async upload(@CurrentUser() caller: any) {
  const token = getApiTokenContext(caller); // undefined for a session / JWT
}
```

What an opened route means per kind:

- **TENANT token** — `S_EVERYONE` / `S_USER` / `S_VERIFIED` count as satisfied (the decorator is the
  explicit permission for a machine); tenant roles resolve against the LOWEST hierarchy role; global
  roles never match; `S_NO_ONE` refuses, and so does a route guarded ONLY by `S_SELF` / `S_CREATOR` —
  those compare a person with a record, and a tenant token is no person. `X-Tenant-Id` is optional — it may only name the token's own
  tenant. `@SkipTenantCheck()` does not unbind it.
- **USER token** — the ordinary checks run as its user. A tenant-restricted token is bound to that
  tenant (a foreign header refuses, `@SkipTenantCheck()` does not unbind it); `maxTenantRole` caps the
  membership role. Losing a membership removes the token's access at once — rights are read per
  request, never copied into the token.

`request.user`:

- TENANT token: `{ id: <token id>, name, scopes, tenantId, roles: [], hasRole: () => false }`
- USER token: the user document (secrets never loaded, global roles removed) with `id` / `hasRole()`

`getApiTokenContext(user)` → `{ kind, tokenId, publicId, name, scopes, tenantId?, userId?, maxTenantRole?, assertion? }`
works for both. It is recognised by a module-private symbol, so a document carrying the same fields is
never mistaken for a token. `createdBy` / `updatedBy` written by a TENANT token hold the token id.

## Using a token

```http
GET /documents
Authorization: Bearer ltt_5f3c0a9e2b41d7c86e0f1a2b_9b1e…      # or:  x-api-key: ltt_…
X-Tenant-Id: <tenant>                                          # optional for tenant tokens
```

Token: `<prefix>_<publicId: 24 hex>_<secret: 64 hex>` (32 random bytes). Shown **once** at creation;
stored only as SHA-256 of the secret and compared in constant time.

| Situation                                                                                                                                         | Status                                            |
| ------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------- |
| Unknown, revoked, expired, tampered token or assertion; owner deleted (user tokens); two different credentials in `Authorization` and `x-api-key` | **401 on every route** (never silently anonymous) |
| Route not opened, scope missing, role too low, foreign tenant                                                                                     | 403                                               |
| Rate limit exceeded (per token, Redis-shared when configured)                                                                                     | 429 + `Retry-After`                               |

## Signed assertions (embedding)

An embedding application must not ship the long-lived token to a browser. It keeps the token's
**signing key** (returned once at creation, 64 hex characters) on its server and mints a short-lived
assertion per page load. The assertion acts with the token's scopes and limits, carries an optional
`sub` / `claims` for the audit trail, and dies with the token (revocation takes effect immediately).

```
payload   = base64url( UTF-8 JSON { "claims"?: {...}, "exp": <unix seconds>, "nonce"?: "...", "sub"?: "...", "tid": "<publicId>" } )
signature = base64url( HMAC-SHA256( key  = UTF-8 bytes of the signing key as issued,
                                    data = ASCII bytes of the payload string ) )
assertion = "<prefix>s_" + payload + "." + signature          # base64url WITHOUT padding
```

`publicId` is the middle part of the token. `exp` may lie at most `maxAssertionLifetimeSeconds`
(default 900) in the future; 30 s of clock skew are tolerated on both edges. The server verifies the
signature over the payload string as received — key order and whitespace do not matter. `nonce` is
recorded, not enforced as single-use: an embedded page makes many requests with one assertion.

Node:

```typescript
import { signApiTokenAssertion } from '@lenne.tech/nest-server';

const assertion = signApiTokenAssertion({ publicId, signingKey, expiresInSeconds: 300, subject: 'b7user' });
```

C#:

```csharp
using System.Security.Cryptography;
using System.Text;
using System.Text.Json;

static string B64Url(byte[] b) => Convert.ToBase64String(b).TrimEnd('=').Replace('+', '-').Replace('/', '_');

var json = JsonSerializer.Serialize(new Dictionary<string, object> {
    ["exp"] = DateTimeOffset.UtcNow.AddMinutes(5).ToUnixTimeSeconds(),
    ["sub"] = "b7user",
    ["tid"] = publicId,
});
var payload = B64Url(Encoding.UTF8.GetBytes(json));
using var hmac = new HMACSHA256(Encoding.UTF8.GetBytes(signingKey));
var assertion = $"ltts_{payload}.{B64Url(hmac.ComputeHash(Encoding.ASCII.GetBytes(payload)))}";
```

PowerShell (5.1 and 7):

```powershell
function ConvertTo-B64Url([byte[]]$b) { [Convert]::ToBase64String($b).TrimEnd('=').Replace('+','-').Replace('/','_') }
$json = @{ exp = [DateTimeOffset]::UtcNow.AddMinutes(5).ToUnixTimeSeconds(); sub = 'b7user'; tid = $publicId } | ConvertTo-Json -Compress
$payload = ConvertTo-B64Url ([Text.Encoding]::UTF8.GetBytes($json))
$hmac = New-Object System.Security.Cryptography.HMACSHA256 (,[Text.Encoding]::UTF8.GetBytes($signingKey))
$assertion = "ltts_$payload." + (ConvertTo-B64Url ($hmac.ComputeHash([Text.Encoding]::ASCII.GetBytes($payload))))
```

The signing key is stored AES-256-GCM encrypted (`apiTokens.encryptionKey`, fallback
`SECRETS_ENCRYPTION_KEY`). Rotating that key invalidates the signing keys — not the tokens — of all
existing tokens.

## Management — `CoreApiTokenService`

Every method takes the acting user and checks the right itself; a project controller only forwards
`@CurrentUser()` / `@CurrentTenant()`. See `INTEGRATION-CHECKLIST.md` for a controller.

| Method                                                                                | Who                                                                              |
| ------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------- |
| `createUserToken(input, currentUser)` → `{ apiToken, token, signingKey }`             | the user (for themselves)                                                        |
| `findUserTokens` / `updateUserToken` / `revokeUserToken` / `deleteUserToken`          | the owner                                                                        |
| `createTenantToken(tenantId, input, currentUser)` → `{ apiToken, token, signingKey }` | `manageRole` in the tenant, platform admin                                       |
| `findTenantTokens` / `updateTenantToken` / `revokeTenantToken` / `deleteTenantToken`  | same                                                                             |
| `deleteAllForTenant(tenantId)`                                                        | system — call when deleting a tenant (also removes user tokens restricted to it) |
| `revokeAllForUser(userId)` / `deleteAllForUser(userId)`                               | system — account compromise / user deletion                                      |

Inputs: `name` (required), `description`, `scopes` (subset of the vocabulary; a user token without
scopes gets the whole vocabulary), `expiresAt` (future, or `null`), for user tokens `tenantId` (an
active membership of the owner) and `maxTenantRole` (a hierarchy role). Any other field is stored as
given — that is how a project binds a token to its own data (after extending the model) — except the
protected ones (`kind`, `tenant`, `user`, `publicId`, hashes, audit fields, `revokedAt`, `lastUsedAt`).
Returned objects never contain the hash or the signing key.

## Better-Auth

Runs alongside Better-Auth without changing it and also works without it (legacy mode):
`CoreBetterAuthMiddleware` leaves prefixed credentials alone, user tokens resolve the same `users`
document Better-Auth does, and `x-api-key` follows the header convention of Better-Auth's API-key
plugin. The official `@better-auth/api-key` plugin is deliberately not used: organisation-owned keys
there are authorised through Better-Auth's organization plugin rather than `CoreTenant`, its request
integration turns a key into a full session of its user on every route, it requires Better-Auth, and
it has no signed assertions.

## Security notes for projects

- **Routes outside the Nest guards do not see `@ApiTokenScopes()`.** Anything mounted with `app.use()`
  (an Express router, a static handler) runs after `CoreApiTokenMiddleware` but before no guard, so
  `req.user` may be a token there. Treat `getApiTokenContext(req.user)` as "not a person" in such code.
  The framework's own case — the MCP OAuth consent step — refuses token requests, because a consent
  would mint an access token with the user's FULL rights.
- **A tenant token is not a user.** `@CurrentUser()` then has no `email`, no `verified`; code that
  mails or notifies "the current user" must check `getApiTokenContext()` first. Field-level
  `@Restricted(S_VERIFIED)` stays hidden from tenant tokens (fail-closed).
- **Open routes deliberately.** Never release routes that change credentials, e-mail, roles,
  memberships or tokens. The management service refuses tokens anyway.
- **Password resets.** A reset that ends the user's sessions ends their user tokens too: the legacy
  reset (`CoreUserService.resetPassword()`) always, the IAM reset while
  `betterAuth.emailAndPassword.revokeSessionsOnPasswordReset` is on. With it off — and on a password
  CHANGE — user tokens survive, like personal access tokens elsewhere; after a suspected compromise
  call `revokeAllForUser(userId)`. Tenant tokens are never touched by a user's reset.
- **Deleting a tenant.** Call `deleteAllForTenant(tenantId)` — nothing does it for you, and until you
  do, the tenant's tokens keep authenticating (the core has no tenant model to notice the deletion).
- **Banned users.** If you add Better-Auth's admin plugin, override `loadTokenUser()` so a banned
  user's tokens are refused as well — the framework does not know that flag.
- **Brute force.** Failed attempts are not limited per IP (guessing 256 bits is not the risk); add an
  IP limit in front of an exposed API if you want one.
- **Secret scanning:** the fixed shape `<prefix>_<24 hex>_<64 hex>` can be registered as a custom
  pattern in your repository's secret scanning.

## Limitations

- HTTP only: GraphQL over WebSocket (subscriptions) does not accept API tokens.
- Better-Auth's native `/iam/*` handlers do not recognise tokens — a token cannot sign in, change a
  password or read a session.
- A 401/429 from the middleware on `/graphql` has the REST error shape, not the GraphQL one.
- `lastUsedAt` is accurate to one minute per replica.