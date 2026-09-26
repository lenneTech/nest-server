/**
 * API tokens — PROOF that every security mechanism a user is subject to applies to tokens too.
 *
 * tests/api-token.e2e-spec.ts covers the feature (acceptance criteria A1-A10). This file attacks the
 * mechanisms themselves through the real stack, one question at a time:
 *
 *   Q1  tenant handling — writes, reads across memberships, @SkipTenantCheck, @CurrentTenant, GraphQL;
 *       Better-Auth — session cookies riding along, Better-Auth's own endpoints
 *   Q2  @Restricted on OUTPUT and INPUT, securityCheck(), CrudService method rights, the role-guard
 *       plugin, S_NO_ONE, S_VERIFIED — exactly as for a user
 *   Q4  a user token never exceeds its user: tenant role, user.roles, global roles, deleted user — read
 *       LIVE on every request
 *   Q5  fine-tuning after creation takes effect on the next request
 *
 * Tokens are created through CoreApiTokenService directly — management is covered by the other spec.
 */
import { Body, Controller, Get, Param, Patch, Post } from '@nestjs/common';
import { Query, Resolver } from '@nestjs/graphql';
import { InjectModel, MongooseModule, Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { Db, MongoClient, ObjectId } from 'mongodb';
import { Model } from 'mongoose';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import {
  ApiTokenKind,
  ApiTokenScopes,
  CoreApiTokenService,
  CoreModel,
  CoreTenantService,
  CurrentTenant,
  CurrentUser,
  DefaultHR,
  getApiTokenContext,
  RequestContext,
  Restricted,
  RoleEnum,
  Roles,
  signApiTokenAssertion,
  SkipTenantCheck,
  TestGraphQLType,
  TestHelper,
} from '../src';
import envConfig from '../src/config.env';
import { ConfigService } from '../src/core/common/services/config.service';
import { UserInput } from '../src/server/modules/user/inputs/user.input';
import { UserModule } from '../src/server/modules/user/user.module';
import { UserService } from '../src/server/modules/user/user.service';
import {
  API_TOKEN_TEST_ENCRYPTION_KEY,
  apiTokenIamConfig,
  ApiTokenTestUser,
  bootApiTokenIamApp,
  resetPasswordViaIam,
  signUpAndSignIn,
} from './helpers/api-token-e2e.helpers';

// =================================================================================================
// Fixtures
// =================================================================================================

@Schema({ timestamps: true })
class ProofNote {
  @Prop({ type: String })
  createdBy: string;

  @Prop({ type: String })
  tenantId: string;

  @Prop({ required: true, type: String })
  text: string;
}
const ProofNoteSchema = SchemaFactory.createForClass(ProofNote);

/** A response model with one field per restriction a user can be subject to. */
class ProofReport extends CoreModel {
  @Restricted(RoleEnum.ADMIN)
  adminOnly: string = undefined;

  @Restricted(RoleEnum.S_USER)
  everyUser: string = undefined;

  /** Removed by securityCheck() for everyone but a platform admin. */
  internal: string = undefined;

  @Restricted(DefaultHR.MANAGER)
  managerOnly: string = undefined;

  @Restricted(DefaultHR.MEMBER)
  memberOnly: string = undefined;

  @Restricted(RoleEnum.S_NO_ONE)
  noOne: string = undefined;

  override securityCheck(user: any, force?: boolean): this {
    if (!force && !user?.hasRole?.([RoleEnum.ADMIN])) {
      this.internal = undefined;
    }
    return this;
  }
}

@Controller('proof')
class ApiTokenProofController {
  constructor(
    @InjectModel('ProofNote') private readonly noteModel: Model<ProofNote>,
    @InjectModel('User') private readonly userModel: Model<any>,
    private readonly userService: UserService,
  ) {}

  @ApiTokenScopes('write')
  @Post('notes')
  @Roles(RoleEnum.S_USER)
  async createNote(@Body() body: any) {
    const note = await this.noteModel.create(body);
    return { createdBy: note.createdBy ?? null, tenantId: note.tenantId ?? null, text: note.text };
  }

  @ApiTokenScopes('read')
  @Get('notes')
  @Roles(RoleEnum.S_USER)
  async notes() {
    const notes = await this.noteModel.find().sort({ text: 1 }).lean().exec();
    return notes.map((note) => note.text);
  }

  /** No @Roles: the path on which a caller without a tenant header is scoped to ALL their memberships. */
  @ApiTokenScopes('read')
  @Get('notes-any')
  async notesAny() {
    const notes = await this.noteModel.find().sort({ text: 1 }).lean().exec();
    return notes.map((note) => note.text);
  }

  @ApiTokenScopes('read')
  @Get('report')
  @Roles(RoleEnum.S_USER)
  report() {
    return ProofReport.map({
      adminOnly: 'x',
      everyUser: 'x',
      internal: 'x',
      managerOnly: 'x',
      memberOnly: 'x',
      noOne: 'x',
    });
  }

  @ApiTokenScopes('write')
  @Patch('users/:id')
  @Roles(RoleEnum.S_USER)
  updateUser(@CurrentUser() currentUser: any, @Param('id') id: string, @Body() input: UserInput) {
    // Byte for byte the rights of the reference UserController.updateUser().
    return this.userService.update(id, input, {
      currentUser,
      inputType: UserInput,
      roles: [RoleEnum.ADMIN, RoleEnum.S_CREATOR, RoleEnum.S_SELF],
    });
  }

  @ApiTokenScopes('write')
  @Post('grant-admin/:id')
  @Roles(RoleEnum.S_USER)
  async grantAdmin(@Param('id') id: string) {
    // A raw Mongoose update — the role-guard plugin is the only thing standing in the way.
    await this.userModel.updateOne({ _id: id }, { $set: { roles: [RoleEnum.ADMIN] } }).exec();
    return { done: true };
  }

  @ApiTokenScopes('read')
  @Get('skip-tenant')
  @Roles(RoleEnum.S_USER)
  @SkipTenantCheck()
  skipTenant() {
    return { tenantId: RequestContext.getTenantId() ?? null };
  }

  @ApiTokenScopes('read')
  @Get('current-tenant')
  @Roles(RoleEnum.S_USER)
  currentTenant(@CurrentTenant() tenantId: string) {
    return { tenantId: tenantId ?? null };
  }

  @ApiTokenScopes('read')
  @Get('verified')
  @Roles(RoleEnum.S_VERIFIED)
  verified() {
    return { ok: true };
  }

  @ApiTokenScopes('read')
  @Get('no-one')
  @Roles(RoleEnum.S_NO_ONE)
  noOne() {
    return { ok: true };
  }

  @ApiTokenScopes('read')
  @Get('editor')
  @Roles('editor')
  editor() {
    return { ok: true };
  }

  @ApiTokenScopes('read')
  @Get('auditor')
  @Roles('auditor')
  auditor() {
    return { ok: true };
  }

  @ApiTokenScopes('read')
  @Get('manager')
  @Roles(DefaultHR.MANAGER)
  manager() {
    return { ok: true };
  }

  @Get('unreleased')
  @Roles(RoleEnum.S_USER)
  unreleased() {
    return { ok: true };
  }
}

@Resolver()
class ApiTokenProofResolver {
  @ApiTokenScopes('read')
  @Query(() => String)
  @Roles(RoleEnum.S_USER)
  apiTokenProofContext(@CurrentUser() user: any): string {
    return JSON.stringify({
      kind: getApiTokenContext(user)?.kind ?? null,
      tenantId: RequestContext.getTenantId() ?? null,
    });
  }

  @Query(() => String)
  @Roles(RoleEnum.S_USER)
  apiTokenProofUnreleased(): string {
    return 'reached';
  }
}

// =================================================================================================
// The stack
// =================================================================================================

describe('API tokens — security proof (IAM-only stack with multi-tenancy)', () => {
  let app: any;
  let helper: TestHelper;
  let mongo: MongoClient;
  let db: Db;
  let previousConfig: any;
  let tokens: CoreApiTokenService;
  let tenants: CoreTenantService;

  const suffix = `${Date.now()}`;
  const tenantA = `proof-a-${suffix}`;
  const tenantB = `proof-b-${suffix}`;

  let ownerA: ApiTokenTestUser;
  let memberAB: ApiTokenTestUser;
  let platformAdmin: ApiTokenTestUser;
  let auditor: ApiTokenTestUser;

  const asPerson = (user: ApiTokenTestUser) => ({ id: user.id, roles: [] });
  const header = (tenantId: string) => ({ 'x-tenant-id': tenantId });

  async function tenantToken(scopes = ['read', 'write'], tenantId = tenantA) {
    return tokens.createTenantToken(tenantId, { name: 'proof', scopes }, asPerson(ownerA));
  }

  async function userToken(user: ApiTokenTestUser, input: Record<string, unknown> = {}) {
    return tokens.createUserToken({ name: 'proof', ...input }, asPerson(user));
  }

  beforeAll(async () => {
    previousConfig = ConfigService.configFastButReadOnly;
    const config = apiTokenIamConfig('api-tokens-proof', {
      apiTokens: { encryptionKey: API_TOKEN_TEST_ENCRYPTION_KEY, rateLimit: false, scopes: ['read', 'write'] },
      betterAuth: {
        ...(envConfig as any).betterAuth,
        emailAndPassword: { ...(envConfig as any).betterAuth?.emailAndPassword, revokeSessionsOnPasswordReset: true },
        enabled: true,
      },
      multiTenancy: { cacheTtlMs: 0, globalOnlyRoles: ['auditor'] },
    });
    app = await bootApiTokenIamApp(config, {
      controllers: [ApiTokenProofController],
      imports: [MongooseModule.forFeature([{ name: 'ProofNote', schema: ProofNoteSchema }]), UserModule],
      providers: [ApiTokenProofResolver],
    });
    helper = new TestHelper(app);
    mongo = await MongoClient.connect(config.mongoose.uri);
    db = mongo.db();
    tokens = app.get(CoreApiTokenService);
    tenants = app.get(CoreTenantService);

    ownerA = await signUpAndSignIn(helper, db, 'proof-owner-a');
    memberAB = await signUpAndSignIn(helper, db, 'proof-member-ab');
    platformAdmin = await signUpAndSignIn(helper, db, 'proof-admin', [RoleEnum.ADMIN]);
    auditor = await signUpAndSignIn(helper, db, 'proof-auditor', ['auditor']);

    await tenants.addMember(tenantA, ownerA.id, 'owner');
    await tenants.addMember(tenantA, memberAB.id, 'member');
    await tenants.addMember(tenantB, memberAB.id, 'member');

    await db.collection('proofnotes').insertMany([
      { tenantId: tenantA, text: 'a-1' },
      { tenantId: tenantB, text: 'b-1' },
    ]);
  });

  afterAll(async () => {
    await app?.close();
    await mongo?.close();
    if (previousConfig) {
      ConfigService.setConfig(previousConfig, { reInit: true, warn: false });
    }
  });

  // -----------------------------------------------------------------------------------------------
  // Q1 — tenant handling
  // -----------------------------------------------------------------------------------------------

  describe('Q1: tenant handling', () => {
    it('a write lands in the token’s tenant, authored by the token (tenant + audit plugin)', async () => {
      const created = await tenantToken();
      const note = await helper.rest('/proof/notes', {
        method: 'POST',
        payload: { text: 'written-by-token' },
        statusCode: 201,
        token: created.token,
      });
      expect(note).toEqual({ createdBy: created.apiToken.id, tenantId: tenantA, text: 'written-by-token' });
    });

    it('a write naming another tenant is refused and stores nothing', async () => {
      const created = await tenantToken();
      await helper.rest('/proof/notes', {
        method: 'POST',
        payload: { tenantId: tenantB, text: 'smuggled' },
        statusCode: 403,
        token: created.token,
      });
      expect(await db.collection('proofnotes').countDocuments({ text: 'smuggled' })).toBe(0);
    });

    it('an unrestricted user token reads exactly what its user’s session reads — every membership, or one', async () => {
      const created = await userToken(memberAB);
      // Without a header: scoped to ALL of the user's memberships — identical for session and token.
      const bySession = await helper.rest('/proof/notes-any', { token: memberAB.token });
      expect(bySession).toEqual(expect.arrayContaining(['a-1', 'b-1']));
      expect(await helper.rest('/proof/notes-any', { token: created.token })).toEqual(bySession);
      // On an S_USER route the framework resolves no memberships without a header — for both alike.
      await helper.rest('/proof/notes', { statusCode: 403, token: memberAB.token });
      await helper.rest('/proof/notes', { statusCode: 403, token: created.token });
      // With a header: exactly that tenant.
      expect(await helper.rest('/proof/notes', { headers: header(tenantB), token: created.token })).toEqual(['b-1']);
      // A tenant the user does not belong to stays closed.
      const ownerToken = await userToken(ownerA);
      await helper.rest('/proof/notes', { headers: header(tenantB), statusCode: 403, token: ownerToken.token });
      expect(await helper.rest('/proof/notes-any', { token: ownerToken.token })).toEqual(
        expect.not.arrayContaining(['b-1']),
      );
    });

    it('@SkipTenantCheck() does not unbind a tenant token or a restricted user token', async () => {
      expect(await helper.rest('/proof/skip-tenant', { token: (await tenantToken()).token })).toEqual({
        tenantId: tenantA,
      });
      expect(
        await helper.rest('/proof/skip-tenant', { token: (await userToken(memberAB, { tenantId: tenantB })).token }),
      ).toEqual({ tenantId: tenantB });
      // An unrestricted user token behaves exactly like its user's session there.
      expect(await helper.rest('/proof/skip-tenant', { token: (await userToken(memberAB)).token })).toEqual({
        tenantId: null,
      });
      expect(await helper.rest('/proof/skip-tenant', { token: memberAB.token })).toEqual({ tenantId: null });
    });

    it('@CurrentTenant() yields the token’s tenant', async () => {
      expect(await helper.rest('/proof/current-tenant', { token: (await tenantToken()).token })).toEqual({
        tenantId: tenantA,
      });
    });

    it('GraphQL enforces the same policy as REST', async () => {
      const created = await tenantToken();
      const context = await helper.graphQl(
        { name: 'apiTokenProofContext', type: TestGraphQLType.QUERY },
        { token: created.token },
      );
      expect(JSON.parse(context)).toEqual({ kind: ApiTokenKind.TENANT, tenantId: tenantA });

      const unreleased = await helper.graphQl(
        { name: 'apiTokenProofUnreleased', type: TestGraphQLType.QUERY },
        { token: created.token },
      );
      expect(JSON.stringify(unreleased)).not.toContain('reached');
      expect(JSON.stringify(unreleased)).toMatch(/Forbidden|ACCESS_DENIED|LTNS_0101/);

      const foreign = await request(app.getHttpServer())
        .post('/graphql')
        .set('Authorization', `Bearer ${created.token}`)
        .set('x-tenant-id', tenantB)
        .send({ query: '{ apiTokenProofContext }' });
      expect(JSON.stringify(foreign.body)).not.toContain(tenantB);
      expect(foreign.body.data?.apiTokenProofContext ?? null).toBeNull();
      // …while the session of a user keeps reaching the unreleased query.
      expect(
        await helper.graphQl(
          { name: 'apiTokenProofUnreleased', type: TestGraphQLType.QUERY },
          { token: memberAB.token },
        ),
      ).toBe('reached');
    });
  });

  // -----------------------------------------------------------------------------------------------
  // Q1 — Better-Auth
  // -----------------------------------------------------------------------------------------------

  describe('Q1: Better-Auth', () => {
    async function sessionTokenOf(user: ApiTokenTestUser): Promise<string> {
      const doc = await db.collection('users').findOne({ _id: new ObjectId(user.id) });
      const session = await db.collection('session').findOne({
        $or: [{ userId: doc!._id }, { userId: doc!._id.toString() }, ...(doc!.iamId ? [{ userId: doc!.iamId }] : [])],
      });
      expect(session?.token, 'a Better-Auth session must exist or this proves nothing').toBeTruthy();
      return session!.token;
    }

    it('a session cookie riding along never turns a token request into a session request', async () => {
      const cookie = await sessionTokenOf(memberAB);
      await helper.rest('/proof/unreleased', { cookies: cookie, statusCode: 200 });
      const created = await tenantToken();
      await helper.rest('/proof/unreleased', { cookies: cookie, statusCode: 403, token: created.token });
      // …and an invalid token does not fall back to the cookie either.
      await helper.rest('/proof/unreleased', {
        cookies: cookie,
        statusCode: 401,
        token: `ltt_${'0'.repeat(24)}_${'0'.repeat(64)}`,
      });
    });

    it('a token is worthless at Better-Auth’s own endpoints — no session, no password change', async () => {
      const created = await userToken(memberAB);
      // Nest-handled IAM route: refused by the guards like every unreleased route.
      const session = await helper.rest('/iam/session', { statusCode: 403, token: created.token });
      expect(JSON.stringify(session)).not.toContain(memberAB.email);
      // Better-Auth-native route: Better-Auth sees no session and refuses on its own.
      await helper.rest('/iam/change-password', {
        method: 'POST',
        payload: { currentPassword: memberAB.password, newPassword: 'Hijacked-Password-123!' },
        statusCode: 401,
        token: created.token,
      });
      // The old password still works — nothing changed.
      await helper.rest('/iam/sign-in/email', {
        method: 'POST',
        payload: { email: memberAB.email, password: memberAB.password },
        statusCode: 200,
      });
    });
  });

  // -----------------------------------------------------------------------------------------------
  // Q2/Q3 — every mechanism a user is subject to
  // -----------------------------------------------------------------------------------------------

  describe('Q2/Q3: security mechanisms', () => {
    it('@Restricted on output + securityCheck(): a tenant token sees exactly what the lowest member sees', async () => {
      const report = await helper.rest('/proof/report', { token: (await tenantToken()).token });
      expect(
        Object.keys(report)
          .filter((key) => report[key] === 'x')
          .sort(),
      ).toEqual(['everyUser', 'memberOnly']);
    });

    it('@Restricted on output: a user token sees what its user sees — minus global roles', async () => {
      const ownerToken = await userToken(ownerA);
      const asOwner = await helper.rest('/proof/report', { headers: header(tenantA), token: ownerToken.token });
      expect(
        Object.keys(asOwner)
          .filter((key) => asOwner[key] === 'x')
          .sort(),
      ).toEqual(['everyUser', 'managerOnly', 'memberOnly']);

      const adminSession = await helper.rest('/proof/report', { token: platformAdmin.token });
      expect(adminSession.adminOnly).toBe('x');
      expect(adminSession.internal).toBe('x');
      const adminToken = await helper.rest('/proof/report', { token: (await userToken(platformAdmin)).token });
      expect(adminToken.adminOnly).toBeUndefined();
      expect(adminToken.internal).toBeUndefined();
      expect(adminToken.noOne).toBeUndefined();
    });

    it('@Restricted on input + CrudService method rights: a user token has exactly its user’s rights', async () => {
      const memberToken = await userToken(memberAB);
      // Own record, allowed field — S_SELF.
      const updated = await helper.rest(`/proof/users/${memberAB.id}`, {
        method: 'PATCH',
        payload: { firstName: 'Changed' },
        token: memberToken.token,
      });
      expect(updated.firstName).toBe('Changed');
      // Own record, ADMIN-only input field.
      await helper.rest(`/proof/users/${memberAB.id}`, {
        method: 'PATCH',
        payload: { roles: [RoleEnum.ADMIN] },
        statusCode: 403,
        token: memberToken.token,
      });
      // Someone else's record.
      await helper.rest(`/proof/users/${ownerA.id}`, {
        method: 'PATCH',
        payload: { firstName: 'Hijacked' },
        statusCode: 403,
        token: memberToken.token,
      });
      // A tenant token is nobody's self.
      await helper.rest(`/proof/users/${memberAB.id}`, {
        method: 'PATCH',
        payload: { firstName: 'Tenant' },
        statusCode: 403,
        token: (await tenantToken()).token,
      });
      // The admin's SESSION may; the admin's TOKEN may not.
      await helper.rest(`/proof/users/${ownerA.id}`, {
        method: 'PATCH',
        payload: { firstName: 'ByAdmin' },
        token: platformAdmin.token,
      });
      await helper.rest(`/proof/users/${ownerA.id}`, {
        method: 'PATCH',
        payload: { firstName: 'ByAdminToken' },
        statusCode: 403,
        token: (await userToken(platformAdmin)).token,
      });
      const owner = await db.collection('users').findOne({ _id: new ObjectId(ownerA.id) });
      expect(owner!.firstName).toBe('ByAdmin');
      expect((await db.collection('users').findOne({ _id: new ObjectId(memberAB.id) }))!.roles ?? []).not.toContain(
        RoleEnum.ADMIN,
      );
    });

    it('the role-guard plugin stops a token from granting roles through a raw Mongoose update', async () => {
      const victim = await signUpAndSignIn(helper, db, 'proof-victim');
      for (const credential of [(await tenantToken()).token, (await userToken(platformAdmin)).token]) {
        await helper.rest(`/proof/grant-admin/${victim.id}`, { method: 'POST', statusCode: 201, token: credential });
        const doc = await db.collection('users').findOne({ _id: new ObjectId(victim.id) });
        expect(doc!.roles ?? []).not.toContain(RoleEnum.ADMIN);
      }
      // Control: the same route with the admin's session does grant — so the plugin, not the route, refused.
      await helper.rest(`/proof/grant-admin/${victim.id}`, {
        method: 'POST',
        statusCode: 201,
        token: platformAdmin.token,
      });
      expect((await db.collection('users').findOne({ _id: new ObjectId(victim.id) }))!.roles).toContain(RoleEnum.ADMIN);
    });

    it('S_NO_ONE stays locked for every token', async () => {
      await helper.rest('/proof/no-one', { statusCode: 403, token: (await tenantToken()).token });
      await helper.rest('/proof/no-one', { statusCode: 403, token: (await userToken(ownerA)).token });
    });

    it('S_VERIFIED: a user token carries its user’s verification state', async () => {
      await helper.rest('/proof/verified', { statusCode: 200, token: (await userToken(ownerA)).token });
      const unverifiedId = (
        await db.collection('users').insertOne({ email: `unverified-${suffix}@test.com`, roles: [], verified: false })
      ).insertedId.toString();
      const unverified = await tokens.createUserToken({ name: 'u' }, { id: unverifiedId, roles: [] });
      await helper.rest('/proof/verified', { statusCode: 403, token: unverified.token });
    });
  });

  // -----------------------------------------------------------------------------------------------
  // Q4 — a user token never exceeds its user
  // -----------------------------------------------------------------------------------------------

  describe('Q4: a user token is capped by its user — read live', () => {
    it('never reaches a tenant role above its user’s', async () => {
      await helper.rest('/proof/manager', {
        headers: header(tenantA),
        statusCode: 403,
        token: (await userToken(memberAB)).token,
      });
    });

    it('follows a membership downgrade on the very next request', async () => {
      const created = await userToken(ownerA);
      await helper.rest('/proof/manager', { headers: header(tenantA), statusCode: 200, token: created.token });
      await tenants.updateMemberRole(tenantA, ownerA.id, 'member').catch(async () => {
        // The last owner cannot be demoted — add a second owner first.
        await tenants.addMember(tenantA, platformAdmin.id, 'owner');
        await tenants.updateMemberRole(tenantA, ownerA.id, 'member');
      });
      try {
        await helper.rest('/proof/manager', { headers: header(tenantA), statusCode: 403, token: created.token });
      } finally {
        await tenants.updateMemberRole(tenantA, ownerA.id, 'owner');
      }
    });

    it('follows a change of user.roles on the very next request', async () => {
      const editor = await signUpAndSignIn(helper, db, 'proof-editor', ['editor']);
      const created = await userToken(editor);
      await helper.rest('/proof/editor', { statusCode: 200, token: created.token });
      await db.collection('users').updateOne({ _id: new ObjectId(editor.id) }, { $set: { roles: [] } });
      await helper.rest('/proof/editor', { statusCode: 403, token: created.token });
    });

    it('never carries a global role — neither ADMIN nor a project’s globalOnlyRoles', async () => {
      await helper.rest('/proof/auditor', { statusCode: 200, token: auditor.token });
      await helper.rest('/proof/auditor', { statusCode: 403, token: (await userToken(auditor)).token });
    });

    it('dies with its user', async () => {
      const leaver = await signUpAndSignIn(helper, db, 'proof-deleted');
      const created = await userToken(leaver);
      await helper.rest('/proof/editor', { statusCode: 403, token: created.token });
      await db.collection('users').deleteOne({ _id: new ObjectId(leaver.id) });
      await helper.rest('/proof/editor', { statusCode: 401, token: created.token });
    });
  });

  // -----------------------------------------------------------------------------------------------
  // A password reset that ends the sessions ends the tokens
  // -----------------------------------------------------------------------------------------------

  describe('password reset (revokeSessionsOnPasswordReset: true)', () => {
    it('an IAM reset revokes every user token of that user — and nobody else’s', async () => {
      const resetUser = await signUpAndSignIn(helper, db, 'proof-reset');
      const own = await userToken(resetUser);
      const assertion = signApiTokenAssertion({
        expiresInSeconds: 300,
        publicId: own.token.split('_')[1],
        signingKey: own.signingKey,
      });
      const someoneElses = await userToken(ownerA);
      const tenantOwned = await tenantToken();
      for (const credential of [own.token, assertion, someoneElses.token, tenantOwned.token]) {
        await helper.rest('/proof/current-tenant', { statusCode: 200, token: credential });
      }

      await resetPasswordViaIam(helper, db, resetUser.email, 'Reset-Password-123!');

      await helper.rest('/proof/current-tenant', { statusCode: 401, token: own.token });
      await helper.rest('/proof/current-tenant', { statusCode: 401, token: assertion });
      await helper.rest('/proof/current-tenant', { statusCode: 200, token: someoneElses.token });
      await helper.rest('/proof/current-tenant', { statusCode: 200, token: tenantOwned.token });
      // The reset itself went through.
      await helper.rest('/iam/sign-in/email', {
        method: 'POST',
        payload: { email: resetUser.email, password: 'Reset-Password-123!' },
        statusCode: 200,
      });
    });
  });

  // -----------------------------------------------------------------------------------------------
  // Q5 — fine-tuning takes effect on the next request
  // -----------------------------------------------------------------------------------------------

  describe('Q5: fine-tuning after creation', () => {
    it('narrowing the scopes', async () => {
      const created = await userToken(memberAB);
      await helper.rest('/proof/notes', {
        method: 'POST',
        payload: { text: 'q5' },
        statusCode: 201,
        headers: header(tenantA),
        token: created.token,
      });
      await tokens.updateUserToken(created.apiToken.id, { scopes: ['read'] }, asPerson(memberAB));
      await helper.rest('/proof/notes', {
        method: 'POST',
        payload: { text: 'q5b' },
        statusCode: 403,
        headers: header(tenantA),
        token: created.token,
      });
    });

    it('restricting to one tenant', async () => {
      const created = await userToken(memberAB);
      await helper.rest('/proof/notes', { headers: header(tenantB), statusCode: 200, token: created.token });
      await tokens.updateUserToken(created.apiToken.id, { tenantId: tenantA }, asPerson(memberAB));
      await helper.rest('/proof/notes', { headers: header(tenantB), statusCode: 403, token: created.token });
      expect(await helper.rest('/proof/notes', { token: created.token })).toEqual(expect.not.arrayContaining(['b-1']));
    });

    it('capping the tenant role', async () => {
      const created = await userToken(ownerA);
      await helper.rest('/proof/manager', { headers: header(tenantA), statusCode: 200, token: created.token });
      await tokens.updateUserToken(created.apiToken.id, { maxTenantRole: 'member' }, asPerson(ownerA));
      await helper.rest('/proof/manager', { headers: header(tenantA), statusCode: 403, token: created.token });
    });

    it('setting an expiry — never one in the past, and the token dies when it is reached', async () => {
      const created = await userToken(ownerA);
      await expect(
        tokens.updateUserToken(created.apiToken.id, { expiresAt: new Date(Date.now() - 1000) }, asPerson(ownerA)),
      ).rejects.toThrow(/future/);
      await tokens.updateUserToken(created.apiToken.id, { expiresAt: new Date(Date.now() + 1500) }, asPerson(ownerA));
      await helper.rest('/proof/current-tenant', { statusCode: 200, token: created.token });
      await new Promise((resolve) => setTimeout(resolve, 1700));
      await helper.rest('/proof/current-tenant', { statusCode: 401, token: created.token });
    });

    it('a tenant token’s scopes are narrowed the same way — and only by a tenant admin', async () => {
      const created = await tenantToken(['read', 'write']);
      await expect(
        tokens.updateTenantToken(tenantA, created.apiToken.id, { scopes: ['read'] }, asPerson(memberAB)),
      ).rejects.toThrow();
      await tokens.updateTenantToken(tenantA, created.apiToken.id, { scopes: ['read'] }, asPerson(ownerA));
      await helper.rest('/proof/notes', {
        method: 'POST',
        payload: { text: 'q5c' },
        statusCode: 403,
        token: created.token,
      });
    });
  });
});
