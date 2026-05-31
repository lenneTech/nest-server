import { Injectable, Logger, OnModuleInit } from '@nestjs/common';

import { RoleEnum } from '../../../common/enums/role.enum';
import { AiToolContext, AiToolResult, IAiTool } from '../interfaces/ai-tool.interface';
import { AiToolRegistry } from './ai-tool.registry';

/**
 * Convenience base class for AI tools.
 *
 * Extending {@link AiTool} gives a tool automatic self-registration in the
 * {@link AiToolRegistry} on module init — so a project only needs to declare the
 * class as a provider in its module. Implement {@link name}, {@link description},
 * {@link parameters}, {@link roles} and {@link execute}.
 *
 * @example
 * ```typescript
 * @Injectable()
 * export class FindUsersAiTool extends AiTool {
 *   readonly name = 'find_users';
 *   readonly description = 'Search users by email or name.';
 *   readonly parameters = { properties: { query: { type: 'string' } }, type: 'object' };
 *   readonly roles = [RoleEnum.ADMIN];
 *   constructor(registry: AiToolRegistry, private readonly userService: UserService) { super(registry); }
 *   async execute(args, context) {
 *     return this.userService.find({ filterQuery: { ... } }, context.serviceOptions);
 *   }
 * }
 * ```
 */
@Injectable()
export abstract class AiTool implements IAiTool, OnModuleInit {
  protected readonly logger = new Logger(this.constructor.name);

  abstract readonly description: string;
  abstract readonly name: string;
  abstract readonly parameters: Record<string, any>;
  abstract readonly roles: (RoleEnum | string)[];

  protected constructor(protected readonly registry: AiToolRegistry) {}

  onModuleInit(): void {
    this.registry.register(this);
  }

  abstract execute(args: Record<string, any>, context: AiToolContext): Promise<AiToolResult | unknown>;
}
