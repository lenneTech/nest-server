/**
 * `GET /ai/status` (12.3.1+): the public answer a frontend asks before anybody signs in, to decide whether it shows
 * the assistant at all. "AI off" is the route's absence (404), so the handler itself only reports what the module
 * offers. The assembled behaviour (200 without a session, 404 without the module) is proven in
 * `tests/ai-status.e2e-spec.ts`; this suite pins the parts that decide it, without a database.
 */
import { RequestMethod } from '@nestjs/common';
import { METHOD_METADATA, PATH_METADATA } from '@nestjs/common/constants.js';
import { describe, expect, it } from 'vitest';

import { RoleEnum } from '../../src/core/common/enums/role.enum';
import { AI_MCP_ENABLED } from '../../src/core/modules/ai/core-ai.constants';
import { CoreAiController } from '../../src/core/modules/ai/core-ai.controller';
import { CoreAiModule } from '../../src/core/modules/ai/core-ai.module';

/** The value `CoreAiModule.forRoot()` provides for the MCP flag. */
function providedMcpFlag(mcpEnabled?: boolean): unknown {
  const providers = (CoreAiModule.forRoot(mcpEnabled === undefined ? {} : { mcpEnabled }).providers ?? []) as any[];
  const entry = providers.find((provider) => provider?.provide === AI_MCP_ENABLED);
  expect(entry, 'CoreAiModule.forRoot() must provide AI_MCP_ENABLED').toBeDefined();
  return entry.useValue;
}

/** The handler on a controller whose injected MCP flag is `mcpEnabled`, without constructing its services. */
function statusWith(mcpEnabled: unknown) {
  const controller = Object.create(CoreAiController.prototype) as CoreAiController;
  Object.defineProperty(controller, 'mcpEnabled', { value: mcpEnabled });
  return controller.status();
}

describe('GET /ai/status', () => {
  it('is a GET route at ai/status', () => {
    const handler = CoreAiController.prototype.status;
    expect(Reflect.getMetadata(PATH_METADATA, CoreAiController)).toBe('ai');
    expect(Reflect.getMetadata(PATH_METADATA, handler)).toBe('status');
    expect(Reflect.getMetadata(METHOD_METADATA, handler)).toBe(RequestMethod.GET);
  });

  it('is open to everyone, also without a session, although the controller is admin-only', () => {
    // The guards merge handler and class roles, and S_EVERYONE among them opens the route. The class role stays
    // ADMIN: the handler-level role is the only thing that makes this route public.
    expect(Reflect.getMetadata('roles', CoreAiController)).toEqual([RoleEnum.ADMIN]);
    expect(Reflect.getMetadata('roles', CoreAiController.prototype.status)).toEqual([RoleEnum.S_EVERYONE]);
  });

  it('answers mcp: true exactly when the module registered the MCP endpoint', async () => {
    await expect(statusWith(true)).resolves.toEqual({ mcp: true });
    await expect(statusWith(false)).resolves.toEqual({ mcp: false });
  });

  it('answers mcp: false when no flag was injected (a project module without it)', async () => {
    await expect(statusWith(undefined)).resolves.toEqual({ mcp: false });
  });

  it('names nothing but the MCP flag', async () => {
    expect(Object.keys(await statusWith(true))).toEqual(['mcp']);
  });

  it('CoreAiModule.forRoot() provides the flag it registers the MCP controller by', () => {
    expect(providedMcpFlag(true)).toBe(true);
    expect(providedMcpFlag(false)).toBe(false);
    expect(providedMcpFlag()).toBe(false);
  });
});
