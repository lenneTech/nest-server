import { Injectable } from '@nestjs/common';

import { AiToolContext } from '../../../../core/modules/ai/interfaces/ai-tool.interface';
import { AiTool } from '../../../../core/modules/ai/tools/ai-tool.base';
import { AiToolRegistry } from '../../../../core/modules/ai/tools/ai-tool.registry';
import { RoleEnum } from '../../../../core/common/enums/role.enum';
import { UserService } from '../../user/user.service';

/**
 * Example destructive AI tool: delete a user (admin only).
 *
 * Marked `destructive: true`, so the orchestrator returns a `requiresConfirmation`
 * response listing this action instead of executing it — the prompt must be
 * re-sent with `confirm: true` to actually delete.
 */
@Injectable()
export class DeleteUserAiTool extends AiTool {
  readonly description = 'Delete a user identified by id. Destructive — requires confirmation. Admin only.';
  readonly destructive = true;
  readonly name = 'delete_user';
  readonly parameters = {
    properties: {
      id: { description: 'The user id', type: 'string' },
    },
    required: ['id'],
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
    const deleted = await this.userService.delete(String(args.id), {
      ...context.serviceOptions,
      roles: [RoleEnum.ADMIN],
    });
    return { data: { id: deleted?.id }, message: 'User deleted', success: true };
  }
}
