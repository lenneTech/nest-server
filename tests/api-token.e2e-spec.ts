/**
 * API tokens end to end — through the REAL stack: CoreApiTokenMiddleware, CoreBetterAuthMiddleware,
 * the role guard of each auth mode and CoreTenantGuard, against MongoDB.
 *
 * Four stacks, because the policy has to hold in each of them:
 *  1. IAM-only (BetterAuthRolesGuard) WITH multi-tenancy — both token kinds, acceptance criteria A1-A10
 *  2. IAM-only WITHOUT multi-tenancy — user tokens work, tenant tokens do not exist
 *  3. Feature off — nothing changes (A9; the rest of the suite is the other half of A9)
 *
 * The legacy RolesGuard stack lives in api-token-legacy.e2e-spec.ts: booting a one-argument (IAM-only)
 * CoreModule and then a three-argument (legacy) one in the SAME process fails on static module state
 * that has nothing to do with tokens, so it gets a process of its own.
 *
 * The management endpoints live in this file, the way a project writes them: a thin controller that
 * forwards @CurrentTenant() / @CurrentUser() to CoreApiTokenService, which carries the rights checks.
 */
import { createHash } from 'node:crypto';

import {
  Body,
  Controller,
  Delete,
  ForbiddenException,
  Get,
  HttpCode,
  HttpStatus,
  Module,
  Param,
  Patch,
  Post,
} from '@nestjs/common';
import { InjectModel, MongooseModule, Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { Db, MongoClient, ObjectId } from 'mongodb';
import { Model } from 'mongoose';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import {
  ApiTokenKind,
  ApiTokenScopes,
  CoreApiTokenService,
  CoreBetterAuthModule,
  CoreModule,
  CoreTenantService,
  CurrentTenant,
  CurrentUser,
  DefaultHR,
  getApiTokenContext,
  HttpExceptionLogFilter,
  RequestContext,
  RoleEnum,
  Roles,
  signApiTokenAssertion,
  TestHelper,
} from '../src';
import { ConfigService } from '../src/core/common/services/config.service';
import {
  API_TOKEN_TEST_ENCRYPTION_KEY,
  apiTokenIamConfig,
  ApiTokenTestUser,
  bootApiTokenIamApp,
  resetPasswordViaIam,
  signUpAndSignIn,
} from './helpers/api-token-e2e.helpers';

// =================================================================================================
// Fixtures shared by all stacks
// =================================================================================================

@Schema({ timestamps: true })
class ApiTokenNote {
  @Prop({ type: String })
  tenantId: string;

  @Prop({ required: true, type: String })
  text: string;
}
const ApiTokenNoteSchema = SchemaFactory.createForClass(ApiTokenNote);

/** Routes a token may or may not call. */
@Controller('api-token-probe')
class ApiTokenProbeController {
  constructor(@InjectModel('ApiTokenNote') private readonly noteModel: Model<ApiTokenNote>) {}

  @ApiTokenScopes('read')
  @Get('whoami')
  @Roles(RoleEnum.S_USER)
  whoami(@CurrentUser() user: any) {
    const context = getApiTokenContext(user);
    return {
      claims: context?.assertion?.claims ?? null,
      kind: context?.kind ?? null,
      roles: user?.roles ?? null,
      scopes: context?.scopes ?? null,
      subject: context?.assertion?.subject ?? null,
      tenantId: RequestContext.getTenantId() ?? null,
      tenantRole: RequestContext.get()?.tenantRole ?? null,
      userId: user?.id ?? null,
    };
  }

  @ApiTokenScopes('read')
  @Get('notes')
  @Roles(RoleEnum.S_USER)
  async notes() {
    const notes = await this.noteModel.find().sort({ text: 1 }).lean().exec();
    return { notes: notes.map((note) => note.text) };
  }

  @ApiTokenScopes('export')
  @Post('export')
  @Roles(RoleEnum.S_USER)
  exportIt() {
    return { exported: true };
  }

  @Get('unreleased')
  @Roles(RoleEnum.S_USER)
  unreleased() {
    return { ok: true };
  }

  @Get('public')
  @Roles(RoleEnum.S_EVERYONE)
  publicRoute(@CurrentUser() user: any) {
    return { ok: true, userId: user?.id ?? null };
  }

  @ApiTokenScopes('read')
  @Get('member')
  @Roles(DefaultHR.MEMBER)
  member() {
    return { ok: true };
  }

  @ApiTokenScopes('read')
  @Get('manager')
  @Roles(DefaultHR.MANAGER)
  manager() {
    return { ok: true };
  }

  @ApiTokenScopes('read')
  @Get('owner')
  @Roles(DefaultHR.OWNER)
  owner() {
    return { ok: true };
  }

  @ApiTokenScopes('read')
  @Get('platform-admin')
  @Roles(RoleEnum.ADMIN)
  platformAdmin() {
    return { ok: true };
  }
}

/** Management endpoints, written the way a project would: forward, let the service decide. */
@Controller('api-tokens')
@Roles(RoleEnum.S_USER)
class ApiTokenAdminController {
  constructor(private readonly apiTokens: CoreApiTokenService) {}

  @Post('tenant')
  createTenant(@CurrentTenant() tenantId: string, @Body() body: any, @CurrentUser() user: any) {
    return this.apiTokens.createTenantToken(tenantId, body, user);
  }

  @Get('tenant')
  listTenant(@CurrentTenant() tenantId: string, @CurrentUser() user: any) {
    return this.apiTokens.findTenantTokens(tenantId, user);
  }

  @Patch('tenant/:id')
  updateTenant(
    @CurrentTenant() tenantId: string,
    @Param('id') id: string,
    @Body() body: any,
    @CurrentUser() user: any,
  ) {
    return this.apiTokens.updateTenantToken(tenantId, id, body, user);
  }

  @HttpCode(HttpStatus.OK)
  @Post('tenant/:id/revoke')
  revokeTenant(@CurrentTenant() tenantId: string, @Param('id') id: string, @CurrentUser() user: any) {
    return this.apiTokens.revokeTenantToken(tenantId, id, user);
  }

  @Delete('tenant/:id')
  deleteTenant(@CurrentTenant() tenantId: string, @Param('id') id: string, @CurrentUser() user: any) {
    return this.apiTokens.deleteTenantToken(tenantId, id, user);
  }

  @Post('mine')
  createMine(@Body() body: any, @CurrentUser() user: any) {
    return this.apiTokens.createUserToken(body, user);
  }

  @Get('mine')
  listMine(@CurrentUser() user: any) {
    return this.apiTokens.findUserTokens(user);
  }

  @Patch('mine/:id')
  updateMine(@Param('id') id: string, @Body() body: any, @CurrentUser() user: any) {
    return this.apiTokens.updateUserToken(id, body, user);
  }

  @HttpCode(HttpStatus.OK)
  @Post('mine/:id/revoke')
  revokeMine(@Param('id') id: string, @CurrentUser() user: any) {
    return this.apiTokens.revokeUserToken(id, user);
  }
}

const RATE_LIMIT_MAX = 40;
const SCOPES = ['read', 'export', 'upload'];
const ENCRYPTION_KEY = API_TOKEN_TEST_ENCRYPTION_KEY;

// =================================================================================================
// 1. IAM-only WITH multi-tenancy
// =================================================================================================

describe('API tokens — IAM-only stack with multi-tenancy', () => {
  let app: any;
  let helper: TestHelper;
  let mongo: MongoClient;
  let db: Db;
  let previousConfig: any;

  const suffix = `${Date.now()}`;
  const tenantA = `tenant-a-${suffix}`;
  const tenantB = `tenant-b-${suffix}`;

  let ownerA: ApiTokenTestUser;
  let memberA: ApiTokenTestUser;
  let ownerB: ApiTokenTestUser;
  let platformAdmin: ApiTokenTestUser;

  const asTenant = (tenantId: string) => ({ 'x-tenant-id': tenantId });

  /** Create a tenant token for tenant A through the management endpoint, as ownerA. */
  async function createTenantToken(scopes: string[] = ['read'], extra: Record<string, unknown> = {}) {
    return helper.rest('/api-tokens/tenant', {
      headers: asTenant(tenantA),
      method: 'POST',
      payload: { name: `token-${scopes.join('-')}`, scopes, ...extra },
      statusCode: 201,
      token: ownerA.token,
    });
  }

  beforeAll(async () => {
    previousConfig = ConfigService.configFastButReadOnly;
    const config = apiTokenIamConfig('api-tokens-mt', {
      apiTokens: {
        encryptionKey: ENCRYPTION_KEY,
        rateLimit: { max: RATE_LIMIT_MAX, windowSeconds: 60 },
        scopes: SCOPES,
      },
      multiTenancy: { cacheTtlMs: 0 },
    });
    app = await bootApiTokenIamApp(config, {
      controllers: [ApiTokenProbeController, ApiTokenAdminController],
      imports: [MongooseModule.forFeature([{ name: 'ApiTokenNote', schema: ApiTokenNoteSchema }])],
    });
    helper = new TestHelper(app);
    mongo = await MongoClient.connect(config.mongoose.uri);
    db = mongo.db();

    ownerA = await signUpAndSignIn(helper, db, 'owner-a');
    memberA = await signUpAndSignIn(helper, db, 'member-a');
    ownerB = await signUpAndSignIn(helper, db, 'owner-b');
    platformAdmin = await signUpAndSignIn(helper, db, 'platform-admin', [RoleEnum.ADMIN]);

    const tenants = app.get(CoreTenantService);
    await tenants.addMember(tenantA, ownerA.id, 'owner');
    await tenants.addMember(tenantA, memberA.id, 'member');
    await tenants.addMember(tenantB, ownerB.id, 'owner');
    await tenants.addMember(tenantB, memberA.id, 'member');

    await db.collection('apitokennotes').insertMany([
      { tenantId: tenantA, text: 'a-1' },
      { tenantId: tenantA, text: 'a-2' },
      { tenantId: tenantB, text: 'b-1' },
    ]);
  });

  afterAll(async () => {
    await app?.close();
    await mongo?.close();
    CoreBetterAuthModule.reset();
    if (previousConfig) {
      ConfigService.setConfig(previousConfig, { reInit: true, warn: false });
    }
  });

  // -----------------------------------------------------------------------------------------------
  // Tenant tokens — management (A1, A2)
  // -----------------------------------------------------------------------------------------------

  describe('tenant tokens: management', () => {
    it('A1: a tenant admin creates a token and sees the plaintext exactly once', async () => {
      const created = await createTenantToken(['read']);
      expect(created.token).toMatch(/^ltt_[0-9a-f]{24}_[0-9a-f]{64}$/);
      expect(created.signingKey).toMatch(/^[0-9a-f]{64}$/);
      expect(created.apiToken).toMatchObject({
        kind: ApiTokenKind.TENANT,
        name: 'token-read',
        scopes: ['read'],
        tenant: tenantA,
      });
      expect(created.apiToken).not.toHaveProperty('secretHash');
      expect(created.apiToken).not.toHaveProperty('signingKeyEncrypted');

      const list = await helper.rest('/api-tokens/tenant', { headers: asTenant(tenantA), token: ownerA.token });
      const listed = list.find((token: any) => token.id === created.apiToken.id);
      expect(listed).toMatchObject({ kind: ApiTokenKind.TENANT, name: 'token-read' });
      const serialized = JSON.stringify(list);
      const secret = created.token.split('_')[2];
      expect(serialized).not.toContain(secret);
      expect(serialized).not.toContain(created.signingKey);
      expect(serialized).not.toContain('secretHash');

      // Stored: only the hash of the secret, and an encrypted signing key — never the plaintext.
      const stored = await db.collection('apitokens').findOne({ _id: new ObjectId(created.apiToken.id) });
      expect(stored!.secretHash).toBe(createHash('sha256').update(secret).digest('hex'));
      expect(stored!.signingKeyEncrypted).toBeTruthy();
      expect(JSON.stringify(stored)).not.toContain(secret);
      expect(JSON.stringify(stored)).not.toContain(created.signingKey);
    });

    it('A1: refuses unknown or missing scopes with 400', async () => {
      for (const scopes of [['delete-everything'], [], undefined]) {
        await helper.rest('/api-tokens/tenant', {
          headers: asTenant(tenantA),
          method: 'POST',
          payload: { name: 'bad', scopes },
          statusCode: 400,
          token: ownerA.token,
        });
      }
    });

    it('A2: a plain member of the tenant can neither create, list nor revoke', async () => {
      const created = await createTenantToken(['read']);
      await helper.rest('/api-tokens/tenant', {
        headers: asTenant(tenantA),
        method: 'POST',
        payload: { name: 'nope', scopes: ['read'] },
        statusCode: 403,
        token: memberA.token,
      });
      await helper.rest('/api-tokens/tenant', { headers: asTenant(tenantA), statusCode: 403, token: memberA.token });
      await helper.rest(`/api-tokens/tenant/${created.apiToken.id}/revoke`, {
        headers: asTenant(tenantA),
        method: 'POST',
        statusCode: 403,
        token: memberA.token,
      });
    });

    it('A2: an admin of ANOTHER tenant cannot reach this tenant’s tokens', async () => {
      const created = await createTenantToken(['read']);
      // Naming tenant A: not a member → the tenant guard refuses.
      await helper.rest('/api-tokens/tenant', { headers: asTenant(tenantA), statusCode: 403, token: ownerB.token });
      await helper.rest(`/api-tokens/tenant/${created.apiToken.id}/revoke`, {
        headers: asTenant(tenantA),
        method: 'POST',
        statusCode: 403,
        token: ownerB.token,
      });
      // Naming their OWN tenant with A's token id: the token is simply not found there.
      await helper.rest(`/api-tokens/tenant/${created.apiToken.id}/revoke`, {
        headers: asTenant(tenantB),
        method: 'POST',
        statusCode: 404,
        token: ownerB.token,
      });
      // And A's token still works.
      await helper.rest('/api-token-probe/whoami', { statusCode: 200, token: created.token });
    });

    it('a platform admin may manage any tenant’s tokens (adminBypass)', async () => {
      const list = await helper.rest('/api-tokens/tenant', { headers: asTenant(tenantA), token: platformAdmin.token });
      expect(Array.isArray(list)).toBe(true);
    });

    it('updates name and scopes, still refusing an unknown scope', async () => {
      const created = await createTenantToken(['read']);
      const updated = await helper.rest(`/api-tokens/tenant/${created.apiToken.id}`, {
        headers: asTenant(tenantA),
        method: 'PATCH',
        payload: { name: 'renamed', scopes: ['read', 'export'] },
        token: ownerA.token,
      });
      expect(updated).toMatchObject({ name: 'renamed', scopes: ['read', 'export'] });
      await helper.rest('/api-token-probe/export', { method: 'POST', statusCode: 201, token: created.token });
      await helper.rest(`/api-tokens/tenant/${created.apiToken.id}`, {
        headers: asTenant(tenantA),
        method: 'PATCH',
        payload: { scopes: ['root'] },
        statusCode: 400,
        token: ownerA.token,
      });
    });

    it('a token never reaches a management route that did not release tokens', async () => {
      const created = await createTenantToken(['read']);
      await helper.rest('/api-tokens/tenant', { headers: asTenant(tenantA), statusCode: 403, token: created.token });
      await helper.rest('/api-tokens/mine', {
        method: 'POST',
        payload: { name: 'x' },
        statusCode: 403,
        token: created.token,
      });
    });

    /**
     * The route above never lets a token reach the service, so it cannot show that the SERVICE refuses
     * tokens. This does: a real, narrowed USER token — the credential a project could route to a
     * management method it released with @ApiTokenScopes() — calls the service as its request user.
     *
     * @regression   11.41.4 (pre-release) — the service-level refusal had no test that reached it: the
     *   only case used a tenant token on an unreleased route, which the guard refuses first. Without the
     *   refusal a scope-limited, tenant-restricted, role-capped token mints an unrestricted token of its
     *   user and manages the tenant's tokens with the UNCAPPED membership role.
     * @seen-failing Drop the `getApiTokenContext(currentUser)` refusal from `assertPerson()` in
     *   src/core/modules/api-token/core-api-token.service.ts — registered as mutation
     *   `api-token-service-accepts-token-callers` in tests/regression-mutations.json.
     */
    it('the management service refuses a token caller itself — a narrowed user token cannot widen itself', async () => {
      const service = app.get(CoreApiTokenService);
      const narrow = await helper.rest('/api-tokens/mine', {
        method: 'POST',
        payload: { maxTenantRole: 'member', name: 'narrow', scopes: ['read'], tenantId: tenantA },
        statusCode: 201,
        token: ownerA.token,
      });
      const tokenCaller = await service.authenticate({ kind: 'token', value: narrow.token });
      expect(getApiTokenContext(tokenCaller)).toMatchObject({ kind: ApiTokenKind.USER, userId: ownerA.id });

      await expect(service.createUserToken({ name: 'wider' }, tokenCaller)).rejects.toBeInstanceOf(ForbiddenException);
      await expect(service.updateUserToken(narrow.apiToken.id, { scopes: SCOPES }, tokenCaller)).rejects.toBeInstanceOf(
        ForbiddenException,
      );
      await expect(service.findUserTokens(tokenCaller)).rejects.toBeInstanceOf(ForbiddenException);
      await expect(
        service.createTenantToken(tenantA, { name: 'minted', scopes: ['read'] }, tokenCaller),
      ).rejects.toBeInstanceOf(ForbiddenException);
      await expect(service.findTenantTokens(tenantA, tokenCaller)).rejects.toBeInstanceOf(ForbiddenException);

      const stored = await db.collection('apitokens').findOne({ _id: new ObjectId(narrow.apiToken.id) });
      expect(stored).toMatchObject({ maxTenantRole: 'member', scopes: ['read'], tenant: tenantA });

      // Paired control: the same person WITHOUT the token context may do every one of these.
      const person = { id: ownerA.id, roles: [] };
      await expect(service.findTenantTokens(tenantA, person)).resolves.toBeInstanceOf(Array);
      await expect(service.findUserTokens(person)).resolves.toBeInstanceOf(Array);
    });

    /**
     * @regression   11.41.4 (pre-release) — the only thing between a management input and the stored
     *   `tenant` / `kind` / `user` / `revokedAt` of a token is the service's field projection: the
     *   reference controller forwards `@Body() body: any`, and none of those fields is immutable. Nothing
     *   sent one of them, so dropping one from the protected set left the suite green — while a tenant
     *   admin could move a token into a tenant they do not belong to, or bring a revoked one back.
     * @seen-failing Remove `'tenant'` from PROTECTED_FIELDS, or judge a key by its full spelling instead
     *   of its root segment, in src/core/modules/api-token/core-api-token.service.ts — registered as
     *   mutations `api-token-update-rebinds-tenant` and `api-token-dotted-key-bypasses-projection` in
     *   tests/regression-mutations.json.
     */
    it('protected fields cannot be set through a management input — not on create, not on update', async () => {
      const smuggled = {
        kind: ApiTokenKind.USER,
        publicId: 'f'.repeat(24),
        revokedAt: null,
        'scopes.0': 'root',
        secretHash: '0'.repeat(64),
        tenant: tenantB,
        'tenant.x': tenantB,
        user: memberA.id,
      };
      const created = await createTenantToken(['read'], smuggled);
      expect(created.apiToken).toMatchObject({ kind: ApiTokenKind.TENANT, scopes: ['read'], tenant: tenantA });
      expect(created.apiToken.user ?? null).toBeNull();

      await helper.rest(`/api-tokens/tenant/${created.apiToken.id}`, {
        headers: asTenant(tenantA),
        method: 'PATCH',
        payload: smuggled,
        token: ownerA.token,
      });
      const stored = await db.collection('apitokens').findOne({ _id: new ObjectId(created.apiToken.id) });
      expect(stored).toMatchObject({ kind: ApiTokenKind.TENANT, scopes: ['read'], tenant: tenantA });
      expect(stored?.user ?? null).toBeNull();
      expect(stored?.publicId).not.toBe('f'.repeat(24));
      expect(stored?.secretHash).not.toBe('0'.repeat(64));
      const whoami = await helper.rest('/api-token-probe/whoami', { token: created.token });
      expect(whoami).toMatchObject({ tenantId: tenantA });

      // A revoked token stays revoked, whatever the input says.
      await helper.rest(`/api-tokens/tenant/${created.apiToken.id}/revoke`, {
        headers: asTenant(tenantA),
        method: 'POST',
        token: ownerA.token,
      });
      await helper.rest(`/api-tokens/tenant/${created.apiToken.id}`, {
        headers: asTenant(tenantA),
        method: 'PATCH',
        payload: { revokedAt: null },
        token: ownerA.token,
      });
      await helper.rest('/api-token-probe/whoami', { statusCode: 401, token: created.token });

      // A user token cannot be handed to somebody else, nor turned into a tenant token.
      const own = await helper.rest('/api-tokens/mine', {
        method: 'POST',
        payload: { name: 'mine', user: ownerA.id },
        statusCode: 201,
        token: memberA.token,
      });
      expect(own.apiToken).toMatchObject({ kind: ApiTokenKind.USER, user: memberA.id });
      await helper.rest(`/api-tokens/mine/${own.apiToken.id}`, {
        method: 'PATCH',
        payload: { kind: ApiTokenKind.TENANT, tenant: tenantB, user: ownerA.id },
        token: memberA.token,
      });
      const storedUserToken = await db.collection('apitokens').findOne({ _id: new ObjectId(own.apiToken.id) });
      expect(storedUserToken).toMatchObject({ kind: ApiTokenKind.USER, user: memberA.id });
      expect(storedUserToken?.tenant ?? null).toBeNull();
    });
  });

  // -----------------------------------------------------------------------------------------------
  // Tenant tokens — access (A3-A6)
  // -----------------------------------------------------------------------------------------------

  describe('tenant tokens: access', () => {
    let readToken: string;

    beforeAll(async () => {
      readToken = (await createTenantToken(['read'])).token;
    });

    it('A3: a released route answers in the token’s tenant, with the lowest role and only that tenant’s data', async () => {
      const whoami = await helper.rest('/api-token-probe/whoami', { token: readToken });
      expect(whoami).toMatchObject({
        kind: ApiTokenKind.TENANT,
        roles: [],
        scopes: ['read'],
        tenantId: tenantA,
        tenantRole: 'member',
      });
      const notes = await helper.rest('/api-token-probe/notes', { token: readToken });
      expect(notes.notes).toEqual(['a-1', 'a-2']);
    });

    it('A3: accepts the token in x-api-key as well (the Better-Auth API-key convention)', async () => {
      const whoami = await helper.rest('/api-token-probe/whoami', { headers: { 'x-api-key': readToken } });
      expect(whoami.tenantId).toBe(tenantA);
    });

    it('A4: every route that does not release tokens refuses them — public ones included', async () => {
      await helper.rest('/api-token-probe/unreleased', { statusCode: 403, token: readToken });
      await helper.rest('/api-token-probe/public', { statusCode: 403, token: readToken });
    });

    it('A4: a released route that needs more than the lowest tenant role, or a global role, refuses them', async () => {
      await helper.rest('/api-token-probe/member', { statusCode: 200, token: readToken });
      await helper.rest('/api-token-probe/manager', { statusCode: 403, token: readToken });
      await helper.rest('/api-token-probe/owner', { statusCode: 403, token: readToken });
      await helper.rest('/api-token-probe/platform-admin', { statusCode: 403, token: readToken });
    });

    it('A4: a token cannot be pointed at another tenant', async () => {
      await helper.rest('/api-token-probe/notes', { headers: asTenant(tenantB), statusCode: 403, token: readToken });
      const own = await helper.rest('/api-token-probe/notes', { headers: asTenant(tenantA), token: readToken });
      expect(own.notes).toEqual(['a-1', 'a-2']);
    });

    it('A5: a scope the token does not hold is refused', async () => {
      await helper.rest('/api-token-probe/export', { method: 'POST', statusCode: 403, token: readToken });
      const exportToken = (await createTenantToken(['export'])).token;
      await helper.rest('/api-token-probe/export', { method: 'POST', statusCode: 201, token: exportToken });
    });

    it('A6: revoked, expired, tampered, unknown or conflicting credentials answer 401 — on every route', async () => {
      const revoked = await createTenantToken(['read']);
      await helper.rest(`/api-tokens/tenant/${revoked.apiToken.id}/revoke`, {
        headers: asTenant(tenantA),
        method: 'POST',
        token: ownerA.token,
      });

      const expired = await createTenantToken(['read']);
      await db
        .collection('apitokens')
        .updateOne({ _id: new ObjectId(expired.apiToken.id) }, { $set: { expiresAt: new Date(Date.now() - 1000) } });

      const secret = readToken.split('_')[2];
      const tampered = readToken.replace(secret, `${secret.slice(0, -1)}${secret.endsWith('0') ? '1' : '0'}`);
      const unknown = `ltt_${'0'.repeat(24)}_${'0'.repeat(64)}`;

      for (const credential of [revoked.token, expired.token, tampered, unknown]) {
        await helper.rest('/api-token-probe/whoami', { statusCode: 401, token: credential });
        await helper.rest('/api-token-probe/public', { statusCode: 401, token: credential });
      }

      const other = (await createTenantToken(['read'])).token;
      await helper.rest('/api-token-probe/whoami', {
        headers: { 'x-api-key': other },
        statusCode: 401,
        token: readToken,
      });
    });

    it('records the last use', async () => {
      const created = await createTenantToken(['read']);
      await helper.rest('/api-token-probe/whoami', { token: created.token });
      await new Promise((resolve) => setTimeout(resolve, 200));
      const stored = await db.collection('apitokens').findOne({ _id: new ObjectId(created.apiToken.id) });
      expect(stored!.lastUsedAt).toBeInstanceOf(Date);
    });
  });

  // -----------------------------------------------------------------------------------------------
  // Signed assertions (A7)
  // -----------------------------------------------------------------------------------------------

  describe('signed assertions', () => {
    let created: any;
    let publicId: string;

    beforeAll(async () => {
      created = await createTenantToken(['read']);
      publicId = created.token.split('_')[1];
    });

    it('A7: a valid assertion acts with the token’s scopes and carries its subject', async () => {
      const assertion = signApiTokenAssertion({
        claims: { company: '001' },
        expiresInSeconds: 300,
        publicId,
        signingKey: created.signingKey,
        subject: 'b7user',
      });
      const whoami = await helper.rest('/api-token-probe/whoami', { token: assertion });
      expect(whoami).toMatchObject({
        claims: { company: '001' },
        kind: ApiTokenKind.TENANT,
        scopes: ['read'],
        subject: 'b7user',
        tenantId: tenantA,
      });
      // …and it is still bound by the same route policy as the token.
      await helper.rest('/api-token-probe/unreleased', { statusCode: 403, token: assertion });
    });

    it('A7: an expired, overlong, wrongly signed or unknown assertion answers 401', async () => {
      const expired = signApiTokenAssertion({
        expiresAt: Date.now() - 120_000,
        publicId,
        signingKey: created.signingKey,
      });
      const overlong = signApiTokenAssertion({ expiresInSeconds: 3600, publicId, signingKey: created.signingKey });
      const forged = signApiTokenAssertion({ expiresInSeconds: 60, publicId, signingKey: 'ab'.repeat(32) });
      const unknown = signApiTokenAssertion({
        expiresInSeconds: 60,
        publicId: '0'.repeat(24),
        signingKey: created.signingKey,
      });
      for (const assertion of [expired, overlong, forged, unknown]) {
        await helper.rest('/api-token-probe/whoami', { statusCode: 401, token: assertion });
      }
    });

    it('A7: revoking the token invalidates its assertions at once', async () => {
      const token = await createTenantToken(['read']);
      const assertion = signApiTokenAssertion({
        expiresInSeconds: 300,
        publicId: token.token.split('_')[1],
        signingKey: token.signingKey,
      });
      await helper.rest('/api-token-probe/whoami', { statusCode: 200, token: assertion });
      await helper.rest(`/api-tokens/tenant/${token.apiToken.id}/revoke`, {
        headers: asTenant(tenantA),
        method: 'POST',
        token: ownerA.token,
      });
      await helper.rest('/api-token-probe/whoami', { statusCode: 401, token: assertion });
    });
  });

  // -----------------------------------------------------------------------------------------------
  // Rate limit (A8)
  // -----------------------------------------------------------------------------------------------

  it('A8: a token over its limit gets 429 with Retry-After, other tokens are unaffected', async () => {
    const busy = (await createTenantToken(['read'])).token;
    const calm = (await createTenantToken(['read'])).token;
    for (let i = 0; i < RATE_LIMIT_MAX; i++) {
      await helper.rest('/api-token-probe/whoami', { statusCode: 200, token: busy });
    }
    const limited = await helper.rest('/api-token-probe/whoami', {
      returnResponse: true,
      statusCode: 429,
      token: busy,
    });
    expect(Number(limited.headers['retry-after'])).toBeGreaterThan(0);
    await helper.rest('/api-token-probe/whoami', { statusCode: 200, token: calm });
  });

  // -----------------------------------------------------------------------------------------------
  // User tokens
  // -----------------------------------------------------------------------------------------------

  describe('user tokens', () => {
    async function createUserToken(user: { token: string }, payload: Record<string, unknown> = {}) {
      return helper.rest('/api-tokens/mine', {
        method: 'POST',
        payload: { name: 'personal', ...payload },
        statusCode: 201,
        token: user.token,
      });
    }

    it('act as their user — same id, same memberships — with the whole vocabulary by default', async () => {
      const created = await createUserToken(memberA);
      expect(created.apiToken).toMatchObject({ kind: ApiTokenKind.USER, scopes: SCOPES, user: memberA.id });

      const whoami = await helper.rest('/api-token-probe/whoami', { headers: asTenant(tenantA), token: created.token });
      expect(whoami).toMatchObject({
        kind: ApiTokenKind.USER,
        tenantId: tenantA,
        tenantRole: 'member',
        userId: memberA.id,
      });
      const notesA = await helper.rest('/api-token-probe/notes', { headers: asTenant(tenantA), token: created.token });
      expect(notesA.notes).toEqual(['a-1', 'a-2']);
      const notesB = await helper.rest('/api-token-probe/notes', { headers: asTenant(tenantB), token: created.token });
      expect(notesB.notes).toEqual(['b-1']);
    });

    it('never reach a tenant their user is not a member of', async () => {
      const created = await createUserToken(ownerB);
      await helper.rest('/api-token-probe/notes', {
        headers: asTenant(tenantA),
        statusCode: 403,
        token: created.token,
      });
    });

    it('are denied by default and limited to their scopes', async () => {
      const readOnly = await createUserToken(memberA, { scopes: ['read'] });
      await helper.rest('/api-token-probe/unreleased', { statusCode: 403, token: readOnly.token });
      await helper.rest('/api-token-probe/public', { statusCode: 403, token: readOnly.token });
      await helper.rest('/api-token-probe/export', {
        headers: asTenant(tenantA),
        method: 'POST',
        statusCode: 403,
        token: readOnly.token,
      });
      // …while the session of the same user keeps its full rights on those routes.
      await helper.rest('/api-token-probe/unreleased', { statusCode: 200, token: memberA.token });
    });

    it('can be restricted to one tenant — bound to it without a header, refused in any other', async () => {
      const restricted = await createUserToken(memberA, { tenantId: tenantA });
      const bound = await helper.rest('/api-token-probe/notes', { token: restricted.token });
      expect(bound.notes).toEqual(['a-1', 'a-2']);
      await helper.rest('/api-token-probe/notes', {
        headers: asTenant(tenantB),
        statusCode: 403,
        token: restricted.token,
      });
      // Only to a tenant the user belongs to.
      await helper.rest('/api-tokens/mine', {
        method: 'POST',
        payload: { name: 'foreign', tenantId: `tenant-x-${suffix}` },
        statusCode: 403,
        token: memberA.token,
      });
    });

    it('can be capped to a lower tenant role', async () => {
      const full = await createUserToken(ownerA);
      await helper.rest('/api-token-probe/manager', { headers: asTenant(tenantA), statusCode: 200, token: full.token });

      const capped = await createUserToken(ownerA, { maxTenantRole: 'member' });
      await helper.rest('/api-token-probe/manager', {
        headers: asTenant(tenantA),
        statusCode: 403,
        token: capped.token,
      });
      const whoami = await helper.rest('/api-token-probe/whoami', { headers: asTenant(tenantA), token: capped.token });
      expect(whoami.tenantRole).toBe('member');

      await helper.rest('/api-tokens/mine', {
        method: 'POST',
        payload: { maxTenantRole: 'admin', name: 'x' },
        statusCode: 400,
        token: ownerA.token,
      });
    });

    it('never carry global roles — a platform admin’s token is not a platform admin', async () => {
      const created = await createUserToken(platformAdmin);
      await helper.rest('/api-token-probe/platform-admin', { statusCode: 200, token: platformAdmin.token });
      await helper.rest('/api-token-probe/platform-admin', { statusCode: 403, token: created.token });
      const whoami = await helper.rest('/api-token-probe/whoami', { token: created.token });
      expect(whoami.roles).toEqual([]);
      // …and no admin bypass across tenants either.
      await helper.rest('/api-token-probe/notes', {
        headers: asTenant(tenantA),
        statusCode: 403,
        token: created.token,
      });
    });

    it('lose access with their user’s membership', async () => {
      const tenants = app.get(CoreTenantService);
      const leaver = await signUpAndSignIn(helper, db, 'leaver');
      await tenants.addMember(tenantA, leaver.id, 'member');
      const created = await createUserToken(leaver);
      await helper.rest('/api-token-probe/notes', {
        headers: asTenant(tenantA),
        statusCode: 200,
        token: created.token,
      });
      await tenants.removeMember(tenantA, leaver.id);
      await helper.rest('/api-token-probe/notes', {
        headers: asTenant(tenantA),
        statusCode: 403,
        token: created.token,
      });
    });

    it('are managed by their owner only', async () => {
      const created = await createUserToken(memberA);
      const mine = await helper.rest('/api-tokens/mine', { token: memberA.token });
      expect(mine.map((token: any) => token.id)).toContain(created.apiToken.id);
      const theirs = await helper.rest('/api-tokens/mine', { token: ownerB.token });
      expect(theirs.map((token: any) => token.id)).not.toContain(created.apiToken.id);

      await helper.rest(`/api-tokens/mine/${created.apiToken.id}/revoke`, {
        method: 'POST',
        statusCode: 404,
        token: ownerB.token,
      });
      await helper.rest(`/api-tokens/mine/${created.apiToken.id}/revoke`, { method: 'POST', token: memberA.token });
      await helper.rest('/api-token-probe/whoami', { statusCode: 401, token: created.token });
    });

    it('survive an IAM password reset while revokeSessionsOnPasswordReset is off (the default)', async () => {
      const resetUser = await signUpAndSignIn(helper, db, 'reset-default');
      const created = await createUserToken(resetUser);
      await resetPasswordViaIam(helper, db, resetUser.email, 'Reset-Password-123!');
      await helper.rest('/api-token-probe/whoami', { statusCode: 200, token: created.token });
    });

    it('sign assertions like tenant tokens', async () => {
      const created = await createUserToken(memberA, { tenantId: tenantA });
      const assertion = signApiTokenAssertion({
        expiresInSeconds: 120,
        publicId: created.token.split('_')[1],
        signingKey: created.signingKey,
        subject: 'desktop-scanner',
      });
      const whoami = await helper.rest('/api-token-probe/whoami', { token: assertion });
      expect(whoami).toMatchObject({
        kind: ApiTokenKind.USER,
        subject: 'desktop-scanner',
        tenantId: tenantA,
        userId: memberA.id,
      });
    });
  });

  // -----------------------------------------------------------------------------------------------
  // Tenant deletion (A10)
  // -----------------------------------------------------------------------------------------------

  it('A10: deleting a tenant’s tokens leaves sessions and memberships untouched', async () => {
    const tenantToken = await createTenantToken(['read']);
    const restrictedUserToken = await helper.rest('/api-tokens/mine', {
      method: 'POST',
      payload: { name: 'bound', tenantId: tenantA },
      statusCode: 201,
      token: memberA.token,
    });
    const unrestrictedUserToken = await helper.rest('/api-tokens/mine', {
      method: 'POST',
      payload: { name: 'free' },
      statusCode: 201,
      token: memberA.token,
    });

    const deleted = await app.get(CoreApiTokenService).deleteAllForTenant(tenantA);
    expect(deleted).toBeGreaterThanOrEqual(2);

    await helper.rest('/api-token-probe/whoami', { statusCode: 401, token: tenantToken.token });
    await helper.rest('/api-token-probe/whoami', { statusCode: 401, token: restrictedUserToken.token });
    // A user token that was NOT bound to the tenant survives — it belongs to the user, not the tenant.
    await helper.rest('/api-token-probe/whoami', { statusCode: 200, token: unrestrictedUserToken.token });

    const remaining = await helper.rest('/api-tokens/tenant', { headers: asTenant(tenantA), token: ownerA.token });
    expect(remaining).toEqual([]);
    expect(await app.get(CoreTenantService).getActiveMembership(tenantA, memberA.id)).toBeTruthy();
    await helper.rest('/api-token-probe/unreleased', { statusCode: 200, token: memberA.token });
  });
});

// =================================================================================================
// 2. IAM-only WITHOUT multi-tenancy
// =================================================================================================

describe('API tokens — IAM-only stack without multi-tenancy', () => {
  let app: any;
  let helper: TestHelper;
  let mongo: MongoClient;
  let db: Db;
  let previousConfig: any;
  let user: ApiTokenTestUser;
  let admin: ApiTokenTestUser;

  beforeAll(async () => {
    previousConfig = ConfigService.configFastButReadOnly;
    const config = apiTokenIamConfig('api-tokens-plain', {
      apiTokens: { encryptionKey: ENCRYPTION_KEY, scopes: SCOPES },
      multiTenancy: undefined,
    });
    app = await bootApiTokenIamApp(config, {
      controllers: [ApiTokenProbeController, ApiTokenAdminController],
      imports: [MongooseModule.forFeature([{ name: 'ApiTokenNote', schema: ApiTokenNoteSchema }])],
    });
    helper = new TestHelper(app);
    mongo = await MongoClient.connect(config.mongoose.uri);
    db = mongo.db();
    user = await signUpAndSignIn(helper, db, 'plain-user');
    admin = await signUpAndSignIn(helper, db, 'plain-admin', [RoleEnum.ADMIN]);
  });

  afterAll(async () => {
    await app?.close();
    await mongo?.close();
    CoreBetterAuthModule.reset();
    if (previousConfig) {
      ConfigService.setConfig(previousConfig, { reInit: true, warn: false });
    }
  });

  it('user tokens act as their user, without any tenant', async () => {
    const created = await helper.rest('/api-tokens/mine', {
      method: 'POST',
      payload: { name: 'cli', scopes: ['read'] },
      statusCode: 201,
      token: user.token,
    });
    const whoami = await helper.rest('/api-token-probe/whoami', { token: created.token });
    expect(whoami).toMatchObject({ kind: ApiTokenKind.USER, tenantId: null, userId: user.id });
    await helper.rest('/api-token-probe/unreleased', { statusCode: 403, token: created.token });
  });

  it('refuses the tenant-only options and tenant tokens', async () => {
    await helper.rest('/api-tokens/mine', {
      method: 'POST',
      payload: { name: 'x', tenantId: 'anything' },
      statusCode: 400,
      token: user.token,
    });
    await helper.rest('/api-tokens/mine', {
      method: 'POST',
      payload: { maxTenantRole: 'member', name: 'x' },
      statusCode: 400,
      token: user.token,
    });
    await expect(
      app
        .get(CoreApiTokenService)
        .createTenantToken('t', { name: 'x', scopes: ['read'] }, { id: admin.id, roles: [RoleEnum.ADMIN] }),
    ).rejects.toThrow(/Tenant tokens are not enabled/);
  });

  it('strips global roles here too', async () => {
    const created = await helper.rest('/api-tokens/mine', {
      method: 'POST',
      payload: { name: 'admin-cli' },
      statusCode: 201,
      token: admin.token,
    });
    await helper.rest('/api-token-probe/platform-admin', { statusCode: 200, token: admin.token });
    await helper.rest('/api-token-probe/platform-admin', { statusCode: 403, token: created.token });
  });
});

// =================================================================================================
// 3. Feature off (A9)
// =================================================================================================

describe('API tokens — feature off', () => {
  let app: any;
  let helper: TestHelper;
  let previousConfig: any;

  beforeAll(async () => {
    previousConfig = ConfigService.configFastButReadOnly;
    app = await bootApiTokenIamApp(
      apiTokenIamConfig('api-tokens-off', { apiTokens: undefined, multiTenancy: { cacheTtlMs: 0 } }),
      {
        controllers: [ApiTokenProbeController],
        imports: [MongooseModule.forFeature([{ name: 'ApiTokenNote', schema: ApiTokenNoteSchema }])],
      },
    );
    helper = new TestHelper(app);
  });

  afterAll(async () => {
    await app?.close();
    CoreBetterAuthModule.reset();
    if (previousConfig) {
      ConfigService.setConfig(previousConfig, { reInit: true, warn: false });
    }
  });

  it('A9: registers nothing and treats a token-shaped bearer like any unknown one', async () => {
    expect(() => app.get(CoreApiTokenService)).toThrow();
    const lookalike = `ltt_${'1'.repeat(24)}_${'2'.repeat(64)}`;
    const publicRoute = await helper.rest('/api-token-probe/public', { token: lookalike });
    expect(publicRoute).toEqual({ ok: true, userId: null });
    await helper.rest('/api-token-probe/unreleased', { statusCode: 401, token: lookalike });
  });
});
