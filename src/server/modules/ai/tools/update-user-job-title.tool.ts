import { Injectable } from '@nestjs/common';

import { AiToolContext } from '../../../../core/modules/ai/interfaces/ai-tool.interface';
import { AiTool } from '../../../../core/modules/ai/tools/ai-tool.base';
import { AiToolRegistry } from '../../../../core/modules/ai/tools/ai-tool.registry';
import { RoleEnum } from '../../../../core/common/enums/role.enum';
import { UserInput } from '../../user/inputs/user.input';
import { UserService } from '../../user/user.service';

/**
 * Example AI tool: update a user's job title (admin only — data manipulation).
 *
 * Demonstrates a WRITE tool. The job title field is `@Restricted(ADMIN)` on the
 * input, so this tool is admin-gated both at the registry level (visibility) and
 * at the service level (`UserService.update` enforces the field restriction).
 *
 * **For consumer projects that copy this file:** the framework's test fixture
 * `UserInput` carries a `jobTitle` field; most starter user models do NOT.
 * If your `UserInput` doesn't have `jobTitle`, EITHER add the field
 * (`@UnifiedField({ description: 'Job title', isOptional: true })
 * jobTitle?: string;`) OR rename this tool to use one of your own fields
 * (firstName, lastName, …). The dynamic assignment below is deliberate so
 * the file copies cleanly regardless of which fields exist on your input —
 * but if the field is absent at runtime, the underlying `userService.update`
 * will reject it via `MapAndValidatePipe`.
 */
@Injectable()
export class UpdateUserJobTitleAiTool extends AiTool {
  readonly description = 'Update the job title of a user identified by id. Admin only.';
  readonly name = 'update_user_job_title';
  readonly mutating = true;
  readonly parameters = {
    properties: {
      id: { description: 'The user id', type: 'string' },
      jobTitle: { description: 'The new job title', type: 'string' },
    },
    required: ['id', 'jobTitle'],
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
    const input = new UserInput();
    // Dynamic assignment so the file copies cleanly into starter projects whose
    // UserInput may not (yet) carry a `jobTitle` field. The framework test
    // fixture has it; consumer projects may need to add it or rename the tool.
    (input as unknown as Record<string, unknown>).jobTitle = String(args.jobTitle);
    const user = await this.userService.update(String(args.id), input, {
      ...context.serviceOptions,
      inputType: UserInput,
      roles: [RoleEnum.ADMIN],
    });
    return { data: user, message: 'Job title updated', success: true };
  }
}
