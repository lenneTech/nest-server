import { Injectable } from '@nestjs/common';

import { AiToolContext } from '../../../../core/modules/ai/interfaces/ai-tool.interface';
import { AiTool } from '../../../../core/modules/ai/tools/ai-tool.base';
import { AiToolRegistry } from '../../../../core/modules/ai/tools/ai-tool.registry';
import { RoleEnum } from '../../../../core/common/enums/role.enum';
import { UserService } from '../../user/user.service';

/**
 * Example AI tool: get a single user by id (any authenticated user).
 *
 * Authorization is enforced by passing `roles: [ADMIN, S_CREATOR, S_SELF]` to the
 * service — regular users only get their own record, admins get any.
 */
@Injectable()
export class GetUserAiTool extends AiTool {
  readonly description =
    'Get a single user by id. Regular users can only access their own data; admins can access any user.';
  readonly name = 'get_user';
  readonly parameters = {
    properties: {
      id: { description: 'The user id', type: 'string' },
    },
    required: ['id'],
    type: 'object',
  };
  readonly roles = [RoleEnum.S_USER];

  constructor(
    registry: AiToolRegistry,
    private readonly userService: UserService,
  ) {
    super(registry);
  }

  async execute(args: Record<string, any>, context: AiToolContext) {
    const user = await this.userService.get(String(args.id), {
      ...context.serviceOptions,
      roles: [RoleEnum.ADMIN, RoleEnum.S_CREATOR, RoleEnum.S_SELF],
    });
    return { data: user, success: true };
  }
}
