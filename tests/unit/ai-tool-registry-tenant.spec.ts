import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';

import { RoleEnum } from '../../src/core/common/enums/role.enum';
import { ConfigService } from '../../src/core/common/services/config.service';
import { IRequestContext, RequestContext } from '../../src/core/common/services/request-context.service';
import { IAiTool } from '../../src/core/modules/ai/interfaces/ai-tool.interface';
import { AiToolRegistry, AiToolUser } from '../../src/core/modules/ai/tools/ai-tool.registry';

/**
 * Unit Tests: which AI tools a user may use, under multi-tenancy.
 *
 * The registry feeds both the MCP server (`/ai/mcp`) and the AI chat's agent loop, so its answer is
 * what an AI client may do on the user's behalf. It must never exceed what the user may do through
 * the API — and under multi-tenancy the API decides a tenant role by the user's MEMBERSHIP role in
 * the request's tenant, while the registry compared every role with the global `user.roles` and gave
 * every ADMIN a bypass, even where `multiTenancy.adminBypass: false` withholds one.
 *
 * Without multi-tenancy nothing changes.
 *
 * @regression   11.42.0 — under multi-tenancy the AI tool registry answered tenant roles from the
 *   global user.roles instead of the membership, and granted ADMIN a bypass that
 *   adminBypass: false withholds everywhere else.
 * @seen-failing Make `userCanAccess()` skip the multi-tenancy branch in
 *   src/core/modules/ai/tools/ai-tool.registry.ts — registered as mutation
 *   `ai-tool-roles-ignore-tenant` in tests/regression-mutations.json.
 */
describe('AiToolRegistry under multi-tenancy', () => {
  let previousConfig: unknown;

  const tool = (name: string, roles: string[]): IAiTool =>
    ({ description: name, execute: async () => ({}), name, parameters: {}, roles }) as unknown as IAiTool;

  const registry = new AiToolRegistry();
  registry.register(tool('member-tool', ['member']));
  registry.register(tool('owner-tool', ['owner']));
  registry.register(tool('admin-tool', [RoleEnum.ADMIN]));
  registry.register(tool('user-tool', [RoleEnum.S_USER]));

  const visible = (user: AiToolUser, context: Partial<IRequestContext>) =>
    RequestContext.run({ currentUser: user as IRequestContext['currentUser'], fromRequest: true, ...context }, () =>
      registry
        .forUser(user)
        .map((t) => t.name)
        .sort(),
    );

  const configure = (multiTenancy: Record<string, unknown> | undefined) =>
    ConfigService.setConfig({ ...(previousConfig as object), multiTenancy } as any, { reInit: true });

  beforeAll(() => {
    previousConfig = ConfigService.configFastButReadOnly;
  });

  afterEach(() => configure(undefined));

  afterAll(() => {
    ConfigService.setConfig((previousConfig ?? {}) as any, { reInit: true });
  });

  it('answers a tenant role from the membership role of the current request, by hierarchy', () => {
    configure({});
    const user = { id: 'u1', roles: [] };

    expect(visible(user, { tenantId: 't1', tenantRole: 'member' })).toEqual(['member-tool', 'user-tool']);
    expect(visible(user, { tenantId: 't1', tenantRole: 'owner' })).toEqual(['member-tool', 'owner-tool', 'user-tool']);
  });

  it('does not let a global role named like a tenant role stand in for the membership', () => {
    configure({});
    // A global 'owner' in user.roles must not make the user an owner of the tenant they act in.
    const user = { id: 'u1', roles: ['owner'] };

    expect(visible(user, { tenantId: 't1', tenantRole: 'member' })).not.toContain('owner-tool');
  });

  it('never lets a membership role answer for a global role', () => {
    configure({});
    expect(visible({ id: 'u1', roles: [] }, { tenantId: 't1', tenantRole: RoleEnum.ADMIN })).not.toContain(
      'admin-tool',
    );
  });

  it('withholds the ADMIN bypass where adminBypass: false withholds it', () => {
    configure({ adminBypass: false });
    const admin = { id: 'a1', roles: [RoleEnum.ADMIN] };

    // Global ADMIN still answers for ADMIN tools; tenant tools need a membership role like anyone's.
    expect(visible(admin, { tenantId: 't1', tenantRole: 'member' })).toEqual([
      'admin-tool',
      'member-tool',
      'user-tool',
    ]);
  });

  it('keeps the ADMIN bypass with adminBypass on (the default)', () => {
    configure({});
    expect(visible({ id: 'a1', roles: [RoleEnum.ADMIN] }, {})).toEqual([
      'admin-tool',
      'member-tool',
      'owner-tool',
      'user-tool',
    ]);
  });

  it('paired control: without multi-tenancy, roles are compared with user.roles as before', () => {
    configure(undefined);
    expect(visible({ id: 'u1', roles: ['owner'] }, {})).toEqual(['owner-tool', 'user-tool']);
    expect(visible({ id: 'a1', roles: [RoleEnum.ADMIN] }, {})).toEqual([
      'admin-tool',
      'member-tool',
      'owner-tool',
      'user-tool',
    ]);
  });
});
