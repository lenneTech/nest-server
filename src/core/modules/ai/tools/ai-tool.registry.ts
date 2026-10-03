import { Injectable, Logger } from '@nestjs/common';

import { RoleEnum } from '../../../common/enums/role.enum';
import { ConfigService } from '../../../common/services/config.service';
import { RequestContext } from '../../../common/services/request-context.service';
import {
  checkRoleAccess,
  isMultiTenancyActive,
  resolveGlobalAndTenantRoles,
  tenantSatisfiableRoles,
} from '../../tenant/core-tenant.helpers';
import { IAiTool } from '../interfaces/ai-tool.interface';

/**
 * Minimal shape of the current user needed for tool-visibility checks.
 */
export interface AiToolUser {
  [key: string]: any;
  emailVerified?: boolean;
  id?: string;
  roles?: string[];
  verified?: boolean;
  verifiedAt?: Date | string;
}

/**
 * Central registry of all AI tools — the single source of truth that feeds both
 * the internal agent loop ({@link CoreAiService}) and any external MCP server.
 *
 * The registry is a global singleton service: tools self-register (typically
 * from `onModuleInit`), so projects can add or override tools from ANY module
 * without running into NestJS DI-scope limitations. Registering a tool whose
 * name already exists overrides the previous one (last write wins) — this is the
 * supported override mechanism for projects customizing core tools.
 */
@Injectable()
export class AiToolRegistry {
  private readonly logger = new Logger(AiToolRegistry.name);
  private readonly tools = new Map<string, IAiTool>();

  /**
   * Register (or override) a tool by its name.
   */
  register(tool: IAiTool): void {
    if (this.tools.has(tool.name)) {
      this.logger.warn(`AI tool "${tool.name}" is being overridden.`);
    }
    this.tools.set(tool.name, tool);
    this.logger.debug(`Registered AI tool: ${tool.name}`);
  }

  /**
   * Remove a tool from the registry.
   */
  unregister(name: string): void {
    this.tools.delete(name);
  }

  /**
   * Get a tool by name.
   */
  get(name: string): IAiTool | undefined {
    return this.tools.get(name);
  }

  /**
   * All registered tools (unfiltered).
   */
  all(): IAiTool[] {
    return [...this.tools.values()];
  }

  /**
   * Tools the given user is allowed to see and use.
   *
   * This is a first-line visibility filter (defense in depth) — the authoritative
   * authorization happens when a tool's `execute()` routes through a CrudService
   * with the user's serviceOptions.
   */
  forUser(user: AiToolUser | null | undefined): IAiTool[] {
    return this.all().filter((tool) => this.userCanAccess(tool, user));
  }

  /**
   * Whether a user satisfies a tool's role requirements.
   *
   * The answer is what an AI client — the MCP server or the chat's agent loop — may do on the user's
   * behalf, so it must not exceed what the user may do through the API. Under multi-tenancy each role
   * is therefore resolved like `CoreTenantGuard` resolves a `@Roles()`: a global role against
   * `user.roles`, a tenant role against the membership role of the current request's tenant (by
   * hierarchy), and the ADMIN bypass only where `multiTenancy.adminBypass` grants it. Without
   * multi-tenancy, roles are compared with `user.roles` as they always were.
   */
  userCanAccess(tool: IAiTool, user: AiToolUser | null | undefined): boolean {
    const roles = tool.roles ?? [];

    // Locked tools are never accessible.
    if (roles.includes(RoleEnum.S_NO_ONE)) {
      return false;
    }

    // Public tools are always accessible.
    if (roles.includes(RoleEnum.S_EVERYONE)) {
      return true;
    }

    // Everything below requires an authenticated user.
    if (!user?.id) {
      return false;
    }

    const multiTenancy = isMultiTenancyActive();

    // Admin bypass — unless multi-tenancy withholds it (adminBypass: false).
    const adminBypass = !multiTenancy || ConfigService.configFastButReadOnly?.multiTenancy?.adminBypass !== false;
    if (adminBypass && user.roles?.includes(RoleEnum.ADMIN)) {
      return true;
    }

    // Any authenticated user.
    if (roles.includes(RoleEnum.S_USER)) {
      return true;
    }

    // Verified users.
    if (roles.includes(RoleEnum.S_VERIFIED) && (user.verified || user.verifiedAt || user.emailVerified)) {
      return true;
    }

    // Real roles: user must hold at least one of the required roles.
    const systemRoles: string[] = [
      RoleEnum.S_CREATOR,
      RoleEnum.S_EVERYONE,
      RoleEnum.S_NO_ONE,
      RoleEnum.S_SELF,
      RoleEnum.S_USER,
      RoleEnum.S_VERIFIED,
    ];
    const requiredRealRoles = roles.filter((r) => !systemRoles.includes(r));
    if (!multiTenancy) {
      return requiredRealRoles.some((r) => user.roles?.includes(r));
    }

    // Multi-tenancy: each role answered by the source entitled to answer it.
    const { global } = resolveGlobalAndTenantRoles(requiredRealRoles);
    if (global.some((r) => user.roles?.includes(r))) {
      return true;
    }
    // In a tenant, only the membership role counts; outside one, user.roles — as in the guard.
    // The length guard matters: checkRoleAccess() answers TRUE for an empty required list.
    const tenantRoles = tenantSatisfiableRoles(requiredRealRoles);
    return tenantRoles.length > 0 && checkRoleAccess(tenantRoles, user.roles, RequestContext.get()?.tenantRole);
  }
}
