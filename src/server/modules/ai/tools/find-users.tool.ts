import { Injectable } from '@nestjs/common';

import { AiToolContext } from '../../../../core/modules/ai/interfaces/ai-tool.interface';
import { AiTool } from '../../../../core/modules/ai/tools/ai-tool.base';
import { AiToolRegistry } from '../../../../core/modules/ai/tools/ai-tool.registry';
import { RoleEnum } from '../../../../core/common/enums/role.enum';
import { UserService } from '../../user/user.service';

/**
 * Example AI tool: search users (admin only).
 *
 * Demonstrates the secure pattern: the tool routes through `UserService.find`
 * with the caller's `serviceOptions`, so `@Restricted` field filtering and
 * `securityCheck()` still apply — the LLM never receives data the user may not see.
 */
@Injectable()
export class FindUsersAiTool extends AiTool {
  readonly description =
    'Search users by email or username and return the matches. Use for questions like ' +
    '"how many users are there", "find the user with email X" or "list recent users". Admin only.';
  readonly name = 'find_users';
  readonly parameters = {
    properties: {
      limit: { description: 'Maximum number of results (default 20, max 100)', type: 'number' },
      search: { description: 'Search term matched against email and username', type: 'string' },
    },
    type: 'object',
  };
  readonly roles = [RoleEnum.ADMIN];

  constructor(
    registry: AiToolRegistry,
    private readonly userService: UserService,
  ) {
    super(registry);
  }

  async execute(args: Record<string, any>, context: AiToolContext) {
    const search = typeof args.search === 'string' ? args.search.trim() : '';
    const limit = Math.min(Math.max(Number(args.limit) || 20, 1), 100);
    const escaped = search.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const filterQuery = search
      ? { $or: [{ email: { $options: 'i', $regex: escaped } }, { username: { $options: 'i', $regex: escaped } }] }
      : {};

    const users = await this.userService.find({ filterQuery, queryOptions: { limit } }, context.serviceOptions);
    return { data: users, message: `Found ${users.length} user(s)`, success: true };
  }
}
