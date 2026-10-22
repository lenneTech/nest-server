/**
 * MCP OAuth under multi-tenancy, on the assembled stack: an OAuth access token reaches the same
 * tenant scope as a Better-Auth JWT.
 *
 * The guards run before the MCP controller, and an MCP OAuth access token is accepted by nothing but
 * that controller. So for such a request `CoreTenantGuard` saw no user: it never checked the tenant
 * header against a membership, and the request carried no tenant context. A generic MCP client
 * registered, passed the consent page, got its tokens, listed its tools — and every tenant-scoped tool
 * then answered "Tenant context required", even with a tenant header naming a tenant the user is an
 * active member of. Found in a consumer project; a session cookie and a Better-Auth JWT worked, only
 * the OAuth token failed.
 *
 * The token is signed through `CoreAiMcpOAuthService` here rather than obtained through the consent
 * flow, which `ai-mcp-oauth.e2e-spec.ts` walks: what is under test is what the RESOURCE does with a
 * valid token, and that does not depend on how the token was issued.
 */
import { Injectable, Module } from '@nestjs/common';
import { NestExpressApplication } from '@nestjs/platform-express';
import { InjectModel, MongooseModule, Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { Db, MongoClient } from 'mongodb';
import { Model } from 'mongoose';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { CoreBetterAuthModule, CoreTenantService, hasTenantRole, RequestContext, RoleEnum, TestHelper } from '../src';
import envConfig from '../src/config.env';
import { ConfigService } from '../src/core/common/services/config.service';
import { CoreAiMcpOAuthService } from '../src/core/modules/ai/services/core-ai-mcp-oauth.service';
import { AiTool } from '../src/core/modules/ai/tools/ai-tool.base';
import { AiToolRegistry } from '../src/core/modules/ai/tools/ai-tool.registry';
import {
  apiTokenIamConfig,
  ApiTokenTestUser,
  bootApiTokenIamApp,
  signUpAndSignIn,
} from './helpers/api-token-e2e.helpers';

@Schema({ timestamps: true })
class McpTenantNote {
  @Prop({ type: String })
  tenantId: string;

  @Prop({ required: true, type: String })
  text: string;
}
const McpTenantNoteSchema = SchemaFactory.createForClass(McpTenantNote);

/**
 * A tenant-scoped read, plus what the request context looked like while it ran — the scope the
 * Mongoose plugins and `assertTenantRole()` decide by.
 */
@Injectable()
class ListMcpTenantNotesTool extends AiTool {
  readonly description = 'List the notes of the current tenant.';
  readonly name = 'list_tenant_notes';
  readonly parameters = { properties: {}, type: 'object' };
  readonly roles = [RoleEnum.S_USER];

  constructor(
    registry: AiToolRegistry,
    @InjectModel('McpTenantNote') private readonly noteModel: Model<McpTenantNote>,
  ) {
    super(registry);
  }

  async execute() {
    const notes = await this.noteModel.find().sort({ text: 1 }).lean().exec();
    const context = RequestContext.get();
    return {
      currentUserId: context?.currentUser?.id ?? null,
      isMember: hasTenantRole('member'),
      notes: notes.map((note) => note.text),
      tenantId: context?.tenantId ?? null,
      tenantRole: context?.tenantRole ?? null,
    };
  }
}

@Module({
  imports: [MongooseModule.forFeature([{ name: 'McpTenantNote', schema: McpTenantNoteSchema }])],
  providers: [ListMcpTenantNotesTool],
})
class McpTenantNotesModule {}

describe('MCP OAuth — tenant context for an OAuth access token (e2e)', () => {
  let app: NestExpressApplication;
  let db: Db;
  let helper: TestHelper;
  let mongo: MongoClient;
  let oauth: CoreAiMcpOAuthService;
  let previousConfig: any;

  const suffix = `${Date.now()}`;
  const tenantA = `mcp-tenant-a-${suffix}`;
  const tenantB = `mcp-tenant-b-${suffix}`;

  let member: ApiTokenTestUser;
  let outsider: ApiTokenTestUser;

  const asTenant = (tenantId: string) => ({ 'x-tenant-id': tenantId });
  const oauthToken = (user: ApiTokenTestUser) => oauth.signAccessToken(user.id, 'e2e-mcp-client');

  /** One `tools/call` of the notes tool in a fresh MCP session. */
  async function listNotes(token: string, headers: Record<string, string> = {}) {
    const session = await helper.mcpSession({ headers, token });
    try {
      return await session.callTool('list_tenant_notes');
    } finally {
      await session.close();
    }
  }

  beforeAll(async () => {
    previousConfig = ConfigService.configFastButReadOnly;
    const config = apiTokenIamConfig('mcp-oauth-tenant', {
      ai: {
        ...(envConfig as any).ai,
        mcp: { oauth: true, oauthSecret: 'e2e-mcp-oauth-tenant-signing-secret-32-plus-chars' },
      },
      multiTenancy: { cacheTtlMs: 0 },
    });
    app = await bootApiTokenIamApp(config, { imports: [McpTenantNotesModule] });
    helper = new TestHelper(app);
    mongo = await MongoClient.connect(config.mongoose.uri);
    db = mongo.db();
    oauth = app.get(CoreAiMcpOAuthService);

    member = await signUpAndSignIn(helper, db, 'mcp-member');
    outsider = await signUpAndSignIn(helper, db, 'mcp-outsider');
    await app.get(CoreTenantService).addMember(tenantA, member.id, 'member');

    await db.collection('mcptenantnotes').insertMany([
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

  /**
   * @regression   11.43.2 and earlier — an MCP OAuth access token is resolved inside the MCP controller,
   *   after the guards, so `CoreTenantGuard` never turned the tenant header into a context: every
   *   tenant-scoped tool answered "Tenant context required" to an active member of that tenant.
   * @seen-failing Drop the `scopeLateResolvedUser()` call from `resolveScopedUser()` in
   *   src/core/modules/ai/core-ai-mcp.controller.ts — registered as mutation
   *   `mcp-oauth-user-tenant-unscoped` in tests/regression-mutations.json.
   */
  it('gives an active member the tenant the header names, as for a Better-Auth JWT', async () => {
    const viaOAuth = await listNotes(oauthToken(member), asTenant(tenantA));

    expect(viaOAuth.isError, viaOAuth.content?.[0]?.text).toBeFalsy();
    expect(viaOAuth.json).toMatchObject({ notes: ['a-1', 'a-2'], tenantId: tenantA, tenantRole: 'member' });

    // The credential does not change the answer.
    const viaJwt = await listNotes(member.token, asTenant(tenantA));
    expect(viaJwt.isError, viaJwt.content?.[0]?.text).toBeFalsy();
    expect(viaOAuth.json).toEqual(viaJwt.json);
  });

  /**
   * @regression   11.43.2 and earlier — for a user resolved by the MCP controller, `RequestContext`
   *   carried no current user, which the Mongoose plugins read as SYSTEM work (no audit fields,
   *   `mongooseRoleGuardPlugin` not applied) and `assertTenantRole()` as an anonymous caller.
   * @seen-failing Drop `(req as any).user = user;` from `scopeLateResolvedUser()` in
   *   src/core/modules/ai/core-ai-mcp.controller.ts — registered as mutation
   *   `mcp-oauth-user-not-on-request` in tests/regression-mutations.json.
   */
  it('runs the tool with the OAuth user as the current user of the request', async () => {
    const result = await listNotes(oauthToken(member), asTenant(tenantA));

    expect(result.isError, result.content?.[0]?.text).toBeFalsy();
    expect(result.json).toMatchObject({ currentUserId: member.id, isMember: true });
  });

  /**
   * @regression   11.43.2 fix, refusal half — the tenant must come from a membership, never from the
   *   header alone; a freely chosen tenant id is harmless only because of that.
   * @seen-failing Make `resolveMembershipContext()` in src/core/modules/tenant/core-tenant.guard.ts
   *   return the header's tenant without a membership — registered as mutation
   *   `mcp-oauth-tenant-from-header` in tests/regression-mutations.json.
   */
  describe('keeps every other tenant closed', () => {
    it('refuses a tenant the user is not a member of', async () => {
      const result = await listNotes(oauthToken(member), asTenant(tenantB));

      expect(result.isError).toBe(true);
      expect(result.content?.[0]?.text).toContain('Tenant context required');
    });

    it('refuses an outsider naming a tenant with data', async () => {
      const result = await listNotes(oauthToken(outsider), asTenant(tenantA));

      expect(result.isError).toBe(true);
      expect(result.content?.[0]?.text).toContain('Tenant context required');
    });
  });

  it('establishes no tenant without a header — for either credential', async () => {
    // What the guard gives an @Roles(S_EVERYONE) route without a header: nothing. The MCP endpoint
    // stays exactly as narrow for an OAuth token as for a JWT.
    for (const token of [oauthToken(member), member.token]) {
      const result = await listNotes(token);
      expect(result.isError).toBe(true);
      expect(result.content?.[0]?.text).toContain('Tenant context required');
    }
  });
});
