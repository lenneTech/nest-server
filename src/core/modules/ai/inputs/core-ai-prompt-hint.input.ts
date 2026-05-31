import { InputType } from '@nestjs/graphql';
import { IsIn } from 'class-validator';

import { Restricted } from '../../../common/decorators/restricted.decorator';
import { UnifiedField } from '../../../common/decorators/unified-field.decorator';
import { RoleEnum } from '../../../common/enums/role.enum';

/**
 * Input to update a learned AI prompt hint (admins typically approve/reject or edit).
 */
@InputType({ description: 'Input to update a learned AI prompt hint', isAbstract: true })
@Restricted(RoleEnum.ADMIN)
export class CoreAiPromptHintInput {
  @UnifiedField({
    description: 'Guidance text added to the prompt when approved',
    isOptional: true,
    roles: RoleEnum.ADMIN,
  })
  content?: string = undefined;

  @UnifiedField({
    description: 'Whether the hint is active',
    isOptional: true,
    roles: RoleEnum.ADMIN,
    type: () => Boolean,
  })
  enabled?: boolean = undefined;

  @UnifiedField({
    description: 'Scope the hint applies to (e.g. a tool name); empty = global',
    isOptional: true,
    roles: RoleEnum.ADMIN,
  })
  scope?: string = undefined;

  @UnifiedField({
    description: "Governance status: 'suggested', 'approved' or 'rejected'",
    isOptional: true,
    roles: RoleEnum.ADMIN,
    validator: () => [IsIn(['approved', 'rejected', 'suggested'])],
  })
  status?: string = undefined;
}
