/**
 * API tokens through the LEGACY stack: three-argument CoreModule.forRoot(), RolesGuard (Passport),
 * Better-Auth disabled. The point is that Passport — which only knows JWTs — never sees a token: the
 * guard decides tenant tokens itself and hands a user token's user straight to its role checks.
 *
 * Separate from api-token.e2e-spec.ts because a legacy CoreModule cannot be booted in a process that
 * already booted an IAM-only one (static module state unrelated to tokens).
 */
import { Controller, Get, Module } from '@nestjs/common';
import { InjectModel, MongooseModule, Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { ScheduleModule } from '@nestjs/schedule';
import { Test, TestingModule } from '@nestjs/testing';
import { PubSub } from 'graphql-subscriptions';
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
  CurrentUser,
  getApiTokenContext,
  RequestContext,
  RoleEnum,
  Roles,
  TestHelper,
} from '../src';
import envConfig from '../src/config.env';
import { Any } from '../src/core/common/scalars/any.scalar';
import { DateScalar } from '../src/core/common/scalars/date.scalar';
import { JSON as JSONScalar } from '../src/core/common/scalars/json.scalar';
import { ConfigService } from '../src/core/common/services/config.service';
import { CoreAuthService } from '../src/core/modules/auth/services/core-auth.service';
import { AuthController } from '../src/server/modules/auth/auth.controller';
import { AuthModule } from '../src/server/modules/auth/auth.module';
import { UserModule } from '../src/server/modules/user/user.module';
import { UserService } from '../src/server/modules/user/user.service';
import { deriveTestDbUri } from './db-lifecycle.reporter';

@Schema({ timestamps: true })
class ApiTokenNote {
  @Prop({ type: String })
  tenantId: string;

  @Prop({ required: true, type: String })
  text: string;
}
const ApiTokenNoteSchema = SchemaFactory.createForClass(ApiTokenNote);

@Controller('api-token-probe')
class ApiTokenProbeController {
  constructor(@InjectModel('ApiTokenNote') private readonly noteModel: Model<ApiTokenNote>) {}

  @ApiTokenScopes('read')
  @Get('whoami')
  @Roles(RoleEnum.S_USER)
  whoami(@CurrentUser() user: any) {
    return {
      kind: getApiTokenContext(user)?.kind ?? null,
      roles: user?.roles ?? null,
      tenantId: RequestContext.getTenantId() ?? null,
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

  @Get('unreleased')
  @Roles(RoleEnum.S_USER)
  unreleased() {
    return { ok: true };
  }

  @Get('public')
  @Roles(RoleEnum.S_EVERYONE)
  publicRoute() {
    return { ok: true };
  }

  @ApiTokenScopes('read')
  @Get('platform-admin')
  @Roles(RoleEnum.ADMIN)
  platformAdmin() {
    return { ok: true };
  }
}

const SCOPES = ['read', 'export', 'upload'];
const ENCRYPTION_KEY = 'e2e-api-token-encryption-key-of-32-plus-chars';

describe('API tokens — legacy RolesGuard stack without Better-Auth', () => {
  let app: any;
  let helper: TestHelper;
  let mongo: MongoClient;
  let db: Db;
  let previousConfig: any;
  const tenantId = `tenant-legacy-${Date.now()}`;

  beforeAll(async () => {
    previousConfig = ConfigService.configFastButReadOnly;
    CoreBetterAuthModule.reset();
    const config: any = {
      ...envConfig,
      apiTokens: { encryptionKey: ENCRYPTION_KEY, scopes: SCOPES },
      betterAuth: { enabled: false },
      mongoose: { ...envConfig.mongoose, uri: deriveTestDbUri('api-tokens-legacy') },
      multiTenancy: { cacheTtlMs: 0 },
    };
    ConfigService.setConfig(config, { reInit: true, warn: false });

    @Module({
      controllers: [ApiTokenProbeController, AuthController],
      imports: [
        CoreModule.forRoot(CoreAuthService, AuthModule.forRoot(config.jwt), config),
        ScheduleModule.forRoot(),
        AuthModule.forRoot(config.jwt),
        UserModule,
        MongooseModule.forFeature([{ name: 'ApiTokenNote', schema: ApiTokenNoteSchema }]),
      ],
      providers: [Any, DateScalar, JSONScalar, { provide: 'PUB_SUB', useValue: new PubSub() }],
    })
    class ApiTokenLegacyModule {}

    const fixture: TestingModule = await Test.createTestingModule({ imports: [ApiTokenLegacyModule] }).compile();
    app = fixture.createNestApplication();
    await app.init();
    helper = new TestHelper(app);
    mongo = await MongoClient.connect(config.mongoose.uri);
    db = mongo.db();
    await db.collection('apitokennotes').insertMany([
      { tenantId, text: 'legacy-1' },
      { tenantId: `${tenantId}-other`, text: 'other-1' },
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

  it('decides tenant tokens without Passport ever seeing them', async () => {
    const tokens = app.get(CoreApiTokenService);
    const created = await tokens.createTenantToken(
      tenantId,
      { name: 'legacy', scopes: ['read'] },
      { id: new ObjectId().toString(), roles: [RoleEnum.ADMIN] },
    );
    const notes = await helper.rest('/api-token-probe/notes', { token: created.token });
    expect(notes.notes).toEqual(['legacy-1']);
    await helper.rest('/api-token-probe/unreleased', { statusCode: 403, token: created.token });
    await helper.rest('/api-token-probe/public', { statusCode: 403, token: created.token });
    await helper.rest('/api-token-probe/whoami', { statusCode: 401, token: `${created.token.slice(0, -1)}x` });
  });

  it('lets a user token act as its user', async () => {
    const userId = (
      await db.collection('users').insertOne({ email: `legacy-${Date.now()}@test.com`, roles: [RoleEnum.ADMIN] })
    ).insertedId.toString();
    await app.get(CoreTenantService).addMember(tenantId, userId, 'member');
    const created = await app
      .get(CoreApiTokenService)
      .createUserToken({ name: 'legacy-user' }, { id: userId, roles: [] });

    const whoami = await helper.rest('/api-token-probe/whoami', {
      headers: { 'x-tenant-id': tenantId },
      token: created.token,
    });
    expect(whoami).toMatchObject({ kind: ApiTokenKind.USER, roles: [], tenantId, userId });
    await helper.rest('/api-token-probe/platform-admin', { statusCode: 403, token: created.token });
    await helper.rest('/api-token-probe/unreleased', { statusCode: 403, token: created.token });
  });

  it('a legacy password reset revokes the user’s tokens — it ends every legacy session anyway', async () => {
    const email = `legacy-reset-${Date.now()}@test.com`;
    const userId = (await db.collection('users').insertOne({ email, roles: [] })).insertedId.toString();
    const created = await app.get(CoreApiTokenService).createUserToken({ name: 'reset' }, { id: userId, roles: [] });
    await helper.rest('/api-token-probe/whoami', { statusCode: 200, token: created.token });

    const users = app.get(UserService);
    await users.setPasswordResetTokenForEmail(email);
    const resetToken = (await db.collection('users').findOne({ email }))!.passwordResetToken;
    expect(resetToken, 'the legacy reset request must produce a token').toBeTruthy();
    await users.resetPassword(resetToken, 'NewLegacyPassword123!');

    await helper.rest('/api-token-probe/whoami', { statusCode: 401, token: created.token });
  });
});
