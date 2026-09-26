# API Tokens Integration Checklist

## Reference Implementation

- Module: `node_modules/@lenne.tech/nest-server/src/core/modules/api-token/` (README.md explains the model)
- Management controller as a project writes it: `tests/api-token.e2e-spec.ts` → `ApiTokenAdminController`
  (in the GitHub repository; not shipped in the npm package)

## Required Steps

### 1. Enable the feature

**Edit:** `src/config.env.ts`

```typescript
apiTokens: {
  scopes: ['upload', 'read', 'export'],
  encryptionKey: process.env.API_TOKEN_ENCRYPTION_KEY, // or SECRETS_ENCRYPTION_KEY
},
```

**WHY the key:** the signing key of every token (for signed assertions) is stored encrypted with it.
The boot fails in production/staging without one. Rotating it invalidates all signing keys.

**WHY the scopes:** a token can only carry scopes from this list, and a route can only be opened for
them. With an empty list no token can be created (a boot warning says so).

### 2. Open the routes a token may call

```typescript
@ApiTokenScopes('upload')
@Roles(RoleEnum.S_USER)
@Post('documents')
```

**WHY explicitly:** tokens are denied on every route without `@ApiTokenScopes()`, public ones
included. Open only what a machine needs; never the routes that change credentials, email, roles or
memberships.

### 3. Add management endpoints

The core ships the service, the project owns the routes (same split as tenant members):

```typescript
@Controller('api-tokens')
@Roles(RoleEnum.S_USER)
export class ApiTokenController {
  constructor(private readonly apiTokens: CoreApiTokenService) {}

  @Post('tenant') // X-Tenant-Id header selects the tenant
  createTenantToken(@CurrentTenant() tenantId: string, @Body() input: any, @CurrentUser() user: any) {
    return this.apiTokens.createTenantToken(tenantId, input, user);
  }

  @Post('mine')
  createUserToken(@Body() input: any, @CurrentUser() user: any) {
    return this.apiTokens.createUserToken(input, user);
  }
  // find…/update…/revoke…/delete… analogously
}
```

**WHY no rights logic here:** the service checks who may act (owner, `manageRole`, platform admin)
and refuses token-authenticated callers. Forward `@CurrentUser()` unchanged.

**WHY `@HttpCode(200)` on revoke routes:** Nest answers a `POST` with 201 by default.

### 4. Clean up with your own entities

```typescript
await this.apiTokenService.deleteAllForTenant(tenantId); // when deleting a tenant
await this.apiTokenService.deleteAllForUser(userId); // when deleting a user
await this.apiTokenService.revokeAllForUser(userId); // after an account compromise
```

**WHY:** the core has no tenant model to hook into, so nothing calls these for you.

- **For TENANT tokens `deleteAllForTenant()` is what ends access.** A tenant token belongs to the
  tenant, not to a person: removing members does not touch it (that is the point — it survives staff
  changes), and the core cannot see a tenant being deleted. Until you call it (or `revokeTenantToken()`),
  a deleted or off-boarded tenant's tokens keep authenticating with the lowest tenant role.
- **For USER tokens** access already ends when the user or the membership disappears; the call only
  removes the rows.

### 5. Optional: bind tokens to project data

Extend the model and register it:

```typescript
@Schema({ timestamps: true })
export class ApiToken extends CoreApiTokenModel {
  @UnifiedField({ isOptional: true, mongoose: { type: String } })
  exportConfigId: string = undefined;
}

CoreModule.forRoot(envConfig, { apiToken: { model: ApiToken } });
```

Extra fields of a create/update input are stored as given (protected fields excepted). Read them from
`getApiTokenContext(user).tokenId` + your own lookup.

## Verification Checklist

- [ ] Build succeeds (`pnpm run build`), tests pass (`pnpm test`)
- [ ] A created token's plaintext appears in the create response only — never in a list
- [ ] `GET` on a route WITHOUT `@ApiTokenScopes()` with a token → 403 (also for a public route)
- [ ] A revoked token → 401 on every route
- [ ] A tenant token with a foreign `X-Tenant-Id` → 403
- [ ] A user token of an admin cannot call an ADMIN route
- [ ] Production config sets `apiTokens.encryptionKey` (or `SECRETS_ENCRYPTION_KEY`)

## Common Mistakes

| Mistake                                                   | Symptom                          | Fix                                                                   |
| --------------------------------------------------------- | -------------------------------- | --------------------------------------------------------------------- |
| Route not opened                                          | Token gets 403 everywhere        | `@ApiTokenScopes('<scope>')` on method or class                       |
| Scope missing from `apiTokens.scopes`                     | 400 "Unknown scope(s)" on create | Add it to the vocabulary                                              |
| `manageRole` not a tenant role / hierarchy with one level | Boot error                       | Declare a tenant role; keep a role below it, or `tenantTokens: false` |
| No encryption key in production                           | Boot error                       | Set `apiTokens.encryptionKey`                                         |
| Shipping the token to a browser for an embedded page      | Long-lived credential exposed    | Mint a signed assertion server-side (README → "Signed assertions")    |
| Expecting a token on a GraphQL subscription               | 401 / anonymous                  | Tokens are HTTP-only                                                  |