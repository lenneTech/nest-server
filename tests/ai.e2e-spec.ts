import { Test, TestingModule } from '@nestjs/testing';
import { MongoClient, ObjectId } from 'mongodb';
import request from 'supertest';

import {
  AiToolRegistry,
  CoreAiBudgetService,
  CoreAiConnectionPreferenceService,
  CoreAiConnectionResolverService,
  CoreAiConnectionService,
  CoreAiConversationService,
  CoreAiInteractionService,
  CoreAiService,
  HttpExceptionLogFilter,
  ILlmProvider,
  LlmMessage,
  LlmProviderFactory,
  LlmResponse,
  RoleEnum,
} from '../src';
import envConfig from '../src/config.env';
import { ServerModule } from '../src/server/server.module';

/**
 * Scripted provider that returns canned responses per call — used to drive the
 * agent loop deterministically through the real DI graph (no external LLM call).
 */
class ScriptedE2eProvider implements ILlmProvider {
  readonly capabilities = { jsonResponse: false, nativeTools: false, systemPrompt: true };
  readonly name = 'fake-e2e';
  private call = 0;
  constructor(private readonly scripts: string[]) {}
  async chat(): Promise<LlmResponse> {
    const text = this.scripts[Math.min(this.call, this.scripts.length - 1)];
    this.call++;
    return { text, usage: { completionTokens: 1, promptTokens: 1, totalTokens: 2 } };
  }
}

describe('AI module (e2e)', () => {
  let app;
  let connection;
  let db;

  let budgetService: CoreAiBudgetService;
  let connectionService: CoreAiConnectionService;
  let connectionResolver: CoreAiConnectionResolverService;
  let preferenceService: CoreAiConnectionPreferenceService;
  let conversationService: CoreAiConversationService;
  let interactionService: CoreAiInteractionService;
  let aiService: CoreAiService;
  let registry: AiToolRegistry;
  let providerFactory: LlmProviderFactory;

  const admin = { id: new ObjectId().toString(), roles: [RoleEnum.ADMIN] };
  const adminOptions = { currentUser: admin };

  beforeAll(async () => {
    const moduleFixture: TestingModule = await Test.createTestingModule({
      imports: [ServerModule],
    }).compile();
    app = moduleFixture.createNestApplication();
    app.useGlobalFilters(new HttpExceptionLogFilter());
    app.setBaseViewsDir(envConfig.templates.path);
    app.setViewEngine(envConfig.templates.engine);
    await app.init();

    budgetService = app.get(CoreAiBudgetService);
    connectionService = app.get(CoreAiConnectionService);
    connectionResolver = app.get(CoreAiConnectionResolverService);
    preferenceService = app.get(CoreAiConnectionPreferenceService);
    conversationService = app.get(CoreAiConversationService);
    interactionService = app.get(CoreAiInteractionService);
    aiService = app.get(CoreAiService);
    registry = app.get(AiToolRegistry);
    providerFactory = app.get(LlmProviderFactory);

    connection = await MongoClient.connect(envConfig.mongoose.uri);
    db = connection.db();
  });

  afterAll(async () => {
    if (db) {
      await db.collection('aiConnections').deleteMany({});
      await db.collection('aiConnectionPreferences').deleteMany({});
      await db.collection('aiInteractions').deleteMany({});
      await db.collection('aiConversations').deleteMany({});
      await db.collection('aiBudgetLimits').deleteMany({});
    }
    if (connection) {
      await connection.close();
    }
    if (app) {
      await app.close();
    }
  });

  // ===================================================================================================================
  // Integration
  // ===================================================================================================================

  it('registers the example tools from the project module', () => {
    const names = registry.all().map((t) => t.name);
    expect(names).toEqual(expect.arrayContaining(['find_users', 'get_user', 'update_user_job_title']));
  });

  it('only offers admin tools to admins, not to regular users', () => {
    const adminToolNames = registry.forUser(admin).map((t) => t.name);
    const userToolNames = registry.forUser({ id: 'u', roles: [] }).map((t) => t.name);
    expect(adminToolNames).toContain('find_users');
    expect(userToolNames).not.toContain('find_users');
    expect(userToolNames).toContain('get_user');
  });

  // ===================================================================================================================
  // Connection CRUD + secret handling
  // ===================================================================================================================

  it('encrypts the API key on create and never returns the plaintext', async () => {
    const created = await connectionService.create(
      {
        apiKey: 'sk-secret-123',
        baseUrl: 'http://fake/v1',
        model: 'fake-model',
        name: 'CRUD Connection',
        providerType: 'fake-e2e',
      } as any,
      adminOptions,
    );
    expect(created.id).toBeDefined();

    // The raw DB document stores an encrypted triplet, not the plaintext.
    const raw = await db.collection('aiConnections').findOne({ _id: new ObjectId(created.id) });
    expect(raw.apiKeyEncrypted).toBeDefined();
    expect(raw.apiKeyEncrypted).not.toContain('sk-secret-123');
    expect(raw.apiKeyEncrypted.split('.')).toHaveLength(3);

    // resolve() decrypts the key for internal use.
    const resolved = await connectionService.resolve(created.id);
    expect(resolved.apiKey).toBe('sk-secret-123');

    // securityCheck() derives hasApiKey and strips the secret from any output.
    const fetched = await connectionService.get(created.id, adminOptions);
    const safe: any = fetched.securityCheck(admin);
    expect(safe.hasApiKey).toBe(true);
    expect(safe.apiKeyEncrypted).toBeUndefined();

    await connectionService.delete(created.id, adminOptions);
  });

  it('clears the API key when an empty string is passed on update', async () => {
    const created = await connectionService.create(
      { apiKey: 'sk-to-clear', baseUrl: 'http://fake/v1', model: 'm', name: 'Clearable', providerType: 'fake-e2e' } as any,
      adminOptions,
    );
    await connectionService.update(created.id, { apiKey: '' } as any, adminOptions);
    const resolved = await connectionService.resolve(created.id);
    expect(resolved.apiKey).toBe('');
    await connectionService.delete(created.id, adminOptions);
  });

  it('keeps a single default connection', async () => {
    const first = await connectionService.create(
      { baseUrl: 'http://fake/v1', isDefault: true, model: 'm', name: 'First Default', providerType: 'fake-e2e' } as any,
      adminOptions,
    );
    const second = await connectionService.create(
      { baseUrl: 'http://fake/v1', isDefault: true, model: 'm', name: 'Second Default', providerType: 'fake-e2e' } as any,
      adminOptions,
    );

    const firstAfter = await connectionService.get(first.id, adminOptions);
    const secondAfter = await connectionService.get(second.id, adminOptions);
    expect(firstAfter.isDefault).toBe(false);
    expect(secondAfter.isDefault).toBe(true);

    await connectionService.delete(first.id, adminOptions);
    await connectionService.delete(second.id, adminOptions);
  });

  // ===================================================================================================================
  // Prompt orchestration (full DI graph, fake provider)
  // ===================================================================================================================

  it('runs a prompt end-to-end: resolves the connection, executes a tool, returns a structured answer', async () => {
    // Deterministic, isolated tool (does not touch the shared User collection, which
    // is mutated by other test files when the full suite runs in parallel).
    registry.register({
      description: 'Returns a fixed payload for e2e verification',
      execute: async () => ({ data: { pong: true }, success: true }),
      name: 'e2e_ping',
      parameters: { properties: {}, type: 'object' },
      roles: [RoleEnum.S_USER],
    });
    providerFactory.registerBuilder('fake-e2e', () => new ScriptedE2eProvider([
      JSON.stringify({ tool_calls: [{ arguments: {}, name: 'e2e_ping' }] }),
      JSON.stringify({ data: { ok: true }, final: 'I checked the data.' }),
    ]));

    const conn = await connectionService.create(
      { baseUrl: 'http://fake/v1', isDefault: true, model: 'fake-model', name: 'Prompt Default', providerType: 'fake-e2e' } as any,
      adminOptions,
    );

    const response = await aiService.prompt({ connectionId: conn.id, prompt: 'check the data' } as any, adminOptions);

    expect(response.text).toBe('I checked the data.');
    expect(response.connectionId).toBe(conn.id);
    expect(response.actions?.[0]).toMatchObject({ name: 'e2e_ping', success: true });
    expect(response.iterations).toBe(2);

    registry.unregister('e2e_ping');
    await connectionService.delete(conn.id, adminOptions);
  });

  it('keeps multi-turn context and persists messages on a conversation', async () => {
    // Capture the messages the provider receives on each call.
    const seenPerCall: LlmMessage[][] = [];
    providerFactory.registerBuilder('fake-e2e', () => ({
      capabilities: { jsonResponse: false, nativeTools: false, systemPrompt: true },
      name: 'fake-e2e',
      async chat(messages: LlmMessage[]): Promise<LlmResponse> {
        seenPerCall.push(messages);
        return { text: JSON.stringify({ final: 'ok' }), usage: { completionTokens: 1, promptTokens: 1, totalTokens: 2 } };
      },
    }));

    const conn = await connectionService.create(
      { baseUrl: 'http://fake/v1', isDefault: true, model: 'm', name: 'Conv Conn', providerType: 'fake-e2e' } as any,
      adminOptions,
    );
    const conversation = await conversationService.create({ title: 'Test chat' } as any, adminOptions);

    await aiService.prompt({ conversationId: conversation.id, prompt: 'first question' } as any, adminOptions);
    await aiService.prompt({ conversationId: conversation.id, prompt: 'second question' } as any, adminOptions);

    // Second call must have seen the first turn (user + assistant) in its context.
    const secondCallContents = seenPerCall[1].map((m) => m.content).join(' | ');
    expect(secondCallContents).toContain('first question');

    // Both turns persisted: 2 user + 2 assistant = 4 messages.
    const reloaded = await conversationService.get(conversation.id, {
      currentUser: admin,
      roles: [RoleEnum.ADMIN, RoleEnum.S_CREATOR],
    });
    expect(reloaded.messages).toHaveLength(4);
    expect(reloaded.messages?.map((m) => m.role)).toEqual(['user', 'assistant', 'user', 'assistant']);

    await connectionService.delete(conn.id, adminOptions);
    await conversationService.delete(conversation.id, { currentUser: admin, roles: [RoleEnum.ADMIN, RoleEnum.S_CREATOR] });
  });

  it('exposes an MCP endpoint that rejects unauthenticated requests with 401', async () => {
    const res = await request(app.getHttpServer())
      .post('/ai/mcp')
      .set('Accept', 'application/json, text/event-stream')
      .set('Content-Type', 'application/json')
      .send({ id: 1, jsonrpc: '2.0', method: 'initialize', params: {} });
    expect(res.status).toBe(401);
    expect(res.headers['www-authenticate']).toContain('Bearer');
  });

  it('enforces a per-user token limit and reports usage in the response + aiUsage', async () => {
    providerFactory.registerBuilder('fake-e2e', () => new ScriptedE2eProvider([JSON.stringify({ final: 'ok' })]));
    const conn = await connectionService.create(
      { baseUrl: 'http://fake/v1', isDefault: true, model: 'm', name: 'Budget Conn', providerType: 'fake-e2e' } as any,
      adminOptions,
    );

    // Isolated user so prior tests' usage does not count against this limit.
    const budgetUser = { id: new ObjectId().toString(), roles: [RoleEnum.ADMIN] };
    const budgetOptions = { currentUser: budgetUser };
    await budgetService.create(
      { maxTokens: 2, refId: budgetUser.id, scope: 'user' } as any,
      adminOptions,
    );

    // First run is allowed and reports the budget summary (each fake run = 2 tokens).
    const first = await aiService.prompt({ prompt: 'hi' } as any, budgetOptions);
    expect(first.budget?.promptTokens).toBe(2);
    expect(first.budget?.usedTokens).toBe(2);
    expect(first.budget?.remainingTokens).toBe(0);
    expect(first.budget?.resetAt).toBeDefined();

    // aiUsage reflects the same usage.
    const usage = await budgetService.getUsageInfo(budgetUser.id, undefined);
    expect(usage.user).toMatchObject({ maxTokens: 2, remainingTokens: 0, scope: 'user', usedTokens: 2 });

    // Second run is blocked (limit reached).
    await expect(aiService.prompt({ prompt: 'again' } as any, budgetOptions)).rejects.toMatchObject({ status: 429 });

    await connectionService.delete(conn.id, adminOptions);
  });

  it('persists an audit interaction record when ai.audit is enabled', async () => {
    providerFactory.registerBuilder('fake-e2e', () => new ScriptedE2eProvider([JSON.stringify({ final: 'audited answer' })]));
    const conn = await connectionService.create(
      { baseUrl: 'http://fake/v1', isDefault: true, model: 'm', name: 'Audit Conn', providerType: 'fake-e2e' } as any,
      adminOptions,
    );

    await aiService.prompt({ prompt: 'audit me please' } as any, adminOptions);

    const records = await interactionService.find({ filterQuery: { prompt: 'audit me please' } }, adminOptions);
    expect(records.length).toBeGreaterThanOrEqual(1);
    expect(records[0]).toMatchObject({ responseText: 'audited answer', userId: admin.id });

    await connectionService.delete(conn.id, adminOptions);
  });

  // ===================================================================================================================
  // Connection resolution chain + per-tenant availability + preferences
  // ===================================================================================================================

  it('resolves the global default and lists it as available + selected', async () => {
    await db.collection('aiConnections').deleteMany({});
    await db.collection('aiConnectionPreferences').deleteMany({});
    const c1 = await connectionService.create(
      { baseUrl: 'http://fake/v1', model: 'm', name: 'Plain', providerType: 'fake-e2e' } as any,
      adminOptions,
    );
    const c2 = await connectionService.create(
      { baseUrl: 'http://fake/v1', isDefault: true, model: 'm', name: 'Default', providerType: 'fake-e2e' } as any,
      adminOptions,
    );

    expect(await connectionResolver.resolveConnectionId({})).toBe(c2.id);

    const available = await connectionResolver.listAvailable({ userId: admin.id });
    expect(available.map((a) => a.id).sort()).toEqual([c1.id, c2.id].sort());
    expect(available.find((a) => a.id === c2.id)?.selected).toBe(true);
    expect(available.every((a) => !a.locked)).toBe(true);
    // No secrets leak into the available list (only display fields).
    expect((available[0] as any).apiKey).toBeUndefined();
    expect((available[0] as any).baseUrl).toBeUndefined();

    await connectionService.delete(c1.id, adminOptions);
    await connectionService.delete(c2.id, adminOptions);
  });

  it('restricts connections per tenant and validates the user self-service selection', async () => {
    await db.collection('aiConnections').deleteMany({});
    await db.collection('aiConnectionPreferences').deleteMany({});
    const cGlobal = await connectionService.create(
      { baseUrl: 'http://fake/v1', isDefault: true, model: 'm', name: 'Global', providerType: 'fake-e2e' } as any,
      adminOptions,
    );
    const cTenant = await connectionService.create(
      { baseUrl: 'http://fake/v1', model: 'm', name: 'Tenant-only', providerType: 'fake-e2e', tenantIds: ['t1'] } as any,
      adminOptions,
    );

    // Without the tenant, the tenant-scoped connection is filtered out.
    const noTenant = await connectionResolver.listAvailable({});
    expect(noTenant.map((a) => a.id)).toEqual([cGlobal.id]);
    // Within tenant t1, both are available.
    const inTenant = await connectionResolver.listAvailable({ tenantId: 't1' });
    expect(inTenant.map((a) => a.id).sort()).toEqual([cGlobal.id, cTenant.id].sort());

    // A user may not select a connection that is not available to their tenant.
    await expect(connectionResolver.setUserConnection(admin.id, cTenant.id, undefined)).rejects.toThrow(/not available/);
    // Within t1 the selection is valid and then resolves.
    await connectionResolver.setUserConnection(admin.id, cTenant.id, 't1');
    expect(await connectionResolver.resolveConnectionId({ tenantId: 't1', userId: admin.id })).toBe(cTenant.id);

    await connectionService.delete(cGlobal.id, adminOptions);
    await connectionService.delete(cTenant.id, adminOptions);
  });

  it('admin tenant-enforced preference overrides client selection and locks the choice', async () => {
    await db.collection('aiConnections').deleteMany({});
    await db.collection('aiConnectionPreferences').deleteMany({});
    const c1 = await connectionService.create(
      { baseUrl: 'http://fake/v1', model: 'm', name: 'A', providerType: 'fake-e2e' } as any,
      adminOptions,
    );
    const c2 = await connectionService.create(
      { baseUrl: 'http://fake/v1', model: 'm', name: 'B', providerType: 'fake-e2e' } as any,
      adminOptions,
    );

    await preferenceService.upsertPreference('tenant', 't1', c2.id, true);

    // Even though the client requests c1, the tenant-enforced c2 wins.
    expect(await connectionResolver.resolveConnectionId({ requested: c1.id, tenantId: 't1', userId: admin.id })).toBe(
      c2.id,
    );
    const available = await connectionResolver.listAvailable({ tenantId: 't1', userId: admin.id });
    expect(available.find((a) => a.id === c2.id)?.selected).toBe(true);
    expect(available.every((a) => a.locked)).toBe(true);

    await connectionService.delete(c1.id, adminOptions);
    await connectionService.delete(c2.id, adminOptions);
  });

  it('returns a disabled (denied) response when no usable connection exists', async () => {
    await db.collection('aiConnections').deleteMany({});
    const response = await aiService.prompt({ prompt: 'hi' } as any, adminOptions);
    expect(response.denied).toBe(true);
    expect(response.text).toMatch(/No AI service is currently available/);
    expect(response.connectionId).toBeUndefined();
  });

  it('protects the available-connections endpoint (401 without auth)', async () => {
    const res = await request(app.getHttpServer()).get('/ai/connections/available');
    expect(res.status).toBe(401);
  });
});
