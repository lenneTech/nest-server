import { Injectable, Logger, OnApplicationBootstrap } from '@nestjs/common';
import { ModuleRef } from '@nestjs/core';

import { RoleEnum } from '../../../common/enums/role.enum.js';
import { ConfigService } from '../../../common/services/config.service.js';
import { RequestContext } from '../../../common/services/request-context.service.js';
import { mergeRolesMetadata } from '../../tenant/core-tenant.helpers.js';
import { AI_AGENT_FUNCTION_METADATA } from '../core-ai.constants.js';
import type { IAiAgentFunctionOptions } from '../decorators/ai-agent-function.decorator.js';
import type { AiToolContext, IAiTool } from '../interfaces/ai-tool.interface.js';
import { AiSdkPackageError, loadNestjsAi } from '../providers/ai-sdk.packages.js';
import { AiToolRegistry } from '../tools/ai-tool.registry.js';

/** `ai.agentFunctions` once resolved: which agent functions to offer. */
export interface ResolvedAiAgentFunctionsConfig {
  exclude: string[];
  include?: string[];
}

/**
 * `ai.agentFunctions` (boolean shorthand, presence implies enabled): `undefined` = off.
 */
export function resolveAiAgentFunctionsConfig(value: unknown): ResolvedAiAgentFunctionsConfig | undefined {
  if (value === undefined || value === null || value === false) {
    return undefined;
  }
  if (value === true) {
    return { exclude: [] };
  }
  if (typeof value !== 'object' || (value as { enabled?: unknown }).enabled === false) {
    return undefined;
  }
  const { exclude, include } = value as { exclude?: unknown; include?: unknown };
  const names = (list: unknown) =>
    Array.isArray(list) ? list.filter((name): name is string => typeof name === 'string') : undefined;
  return { exclude: names(exclude) ?? [], ...(names(include) && { include: names(include) }) };
}

/** What the bridge reads of a `@nestjs/ai` `AiToolEntry` (structural — the package's own type stays its own). */
interface AgentFunctionEntry {
  description?: string;
  host: Function;
  inputSchema: { jsonSchema: PromiseLike<Record<string, any>> | Record<string, any> };
  name: string;
  scopes?: string[];
  where: string;
}

interface AiToolsLike {
  call(name: string, input: unknown, caller?: { request?: unknown }): Promise<unknown>;
  readonly tools: ReadonlyMap<string, AgentFunctionEntry>;
}

/**
 * Offers the application's `@nestjs/ai` agent functions (`@AgentFunction()` methods) as tools of the AI assistant and
 * its MCP server (12.10.0, nestjs-ai plan §3). Opt-in through `ai.agentFunctions`; inert otherwise — `@nestjs/ai` is
 * not even loaded.
 *
 * ORDER OF GATES. Every gate of the framework runs first, in `CoreAiService` / `CoreAiMcpService`: the role filter
 * (`roles`), tool policies and grants, `authorize()`, confirmation (`mutating` / `destructive`), plan mode, budgets.
 * Only then `execute()` hands the call to `@nestjs/ai`'s own pipeline — its input validation, `scopes` and the
 * application's enhancers (our guards included, with the context type `'ai'`) — with the HTTP request of the run as the
 * caller, so the method's `@Roles()` is decided on the user exactly as over HTTP. A run without a request (none today)
 * would be anonymous to those guards.
 *
 * FAIL CLOSED. An agent function that needs `scopes` is not offered (the framework has no scopes for a chat user, and
 * offering it would only produce refusals); one whose name is already a registered tool stops the boot.
 */
@Injectable()
export class CoreAiAgentFunctionBridge implements OnApplicationBootstrap {
  protected readonly logger = new Logger(CoreAiAgentFunctionBridge.name);

  constructor(
    protected readonly registry: AiToolRegistry,
    protected readonly moduleRef: ModuleRef,
  ) {}

  async onApplicationBootstrap(): Promise<void> {
    const ai = ConfigService.configFastButReadOnly?.ai;
    const config = resolveAiAgentFunctionsConfig(ai && typeof ai === 'object' ? ai.agentFunctions : undefined);
    if (!config) {
      return;
    }
    const nestjsAi = await loadNestjsAi('ai.agentFunctions');
    let aiTools: AiToolsLike | undefined;
    try {
      aiTools = this.moduleRef.get(nestjsAi.AiTools, { strict: false });
    } catch {
      aiTools = undefined;
    }
    if (!aiTools) {
      throw new AiSdkPackageError(
        'ai.agentFunctions is set, but the application imports no AiModule.forRoot() of @nestjs/ai, so there are no ' +
          'agent functions to offer.',
      );
    }
    const offered: string[] = [];
    for (const entry of aiTools.tools.values()) {
      if (config.include && !config.include.includes(entry.name)) {
        continue;
      }
      if (config.exclude.includes(entry.name)) {
        continue;
      }
      const tool = await this.toTool(entry, aiTools);
      if (tool) {
        this.registry.register(tool);
        offered.push(tool.name);
      }
    }
    this.logger.log(`Agent functions offered as AI tools: ${offered.length ? offered.join(', ') : 'none'}`);
  }

  /**
   * One agent function as an {@link IAiTool}; `undefined` when it cannot be offered safely. Overridable — an override
   * that widens what is offered owns that decision.
   */
  protected async toTool(entry: AgentFunctionEntry, aiTools: AiToolsLike): Promise<IAiTool | undefined> {
    if (this.registry.get(entry.name)) {
      throw new AiSdkPackageError(
        `The agent function "${entry.name}" (${entry.where}) has the name of a registered AI tool. Give it another ` +
          '{ name }, or leave it out with ai.agentFunctions.exclude.',
      );
    }
    if (entry.scopes?.length) {
      this.logger.warn(
        `Agent function "${entry.name}" (${entry.where}) requires the scopes ${entry.scopes.join(', ')}; the AI ` +
          'assistant calls with none, so it is not offered.',
      );
      return undefined;
    }
    const methodName = entry.where.slice(entry.where.lastIndexOf('.') + 1);
    const method = (entry.host as { prototype?: Record<string, unknown> }).prototype?.[methodName];
    if (typeof method !== 'function') {
      this.logger.error(`Agent function "${entry.name}": ${entry.where} is no method of its provider; not offered.`);
      return undefined;
    }
    const extras: IAiAgentFunctionOptions = Reflect.getMetadata(AI_AGENT_FUNCTION_METADATA, method) ?? {};
    const methodRoles = mergeRolesMetadata([
      Reflect.getMetadata('roles', method) as string[] | undefined,
      Reflect.getMetadata('roles', entry.host) as string[] | undefined,
    ]).filter(Boolean);
    const roles = extras.roles?.length ? [...extras.roles] : methodRoles.length ? methodRoles : [RoleEnum.S_USER];
    const parameters = await entry.inputSchema.jsonSchema;
    const authorize = extras.authorize;
    const instance = authorize ? this.moduleRef.get(entry.host as any, { strict: false }) : undefined;
    const name = entry.name;

    return {
      ...(authorize && {
        authorize: async (args: Record<string, any>, context: AiToolContext) => authorize.call(instance, args, context),
      }),
      description: entry.description ?? `Agent function ${name}`,
      destructive: extras.destructive === true,
      execute: async (args: Record<string, any>) => {
        const request = RequestContext.getRequest();
        try {
          return await aiTools.call(name, args ?? {}, request ? { request } : {});
        } catch (error) {
          // AiToolError: the message is what @nestjs/ai lets a model read (an HttpException's, else a generic one)
          throw new Error((error as Error)?.message || `Agent function "${name}" failed`, { cause: error });
        }
      },
      mutating: extras.mutating === true || extras.destructive === true,
      name,
      parameters: parameters && typeof parameters === 'object' ? parameters : { properties: {}, type: 'object' },
      roles,
    };
  }
}
