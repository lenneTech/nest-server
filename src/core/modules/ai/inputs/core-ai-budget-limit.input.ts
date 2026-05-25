import { InputType } from '@nestjs/graphql';

import { Restricted } from '../../../common/decorators/restricted.decorator';
import { UnifiedField } from '../../../common/decorators/unified-field.decorator';
import { RoleEnum } from '../../../common/enums/role.enum';

/**
 * Input to update an AI budget limit (all fields optional).
 */
@InputType({ description: 'Input to update an AI budget limit', isAbstract: true })
@Restricted(RoleEnum.ADMIN)
export class CoreAiBudgetLimitInput {
  @UnifiedField({
    description: 'Maximum number of prompts per reset period (0/undefined = unlimited)',
    isOptional: true,
    roles: RoleEnum.ADMIN,
    type: () => Number,
  })
  maxPrompts?: number = undefined;

  @UnifiedField({
    description: 'Maximum number of tokens per reset period (0/undefined = unlimited)',
    isOptional: true,
    roles: RoleEnum.ADMIN,
    type: () => Number,
  })
  maxTokens?: number = undefined;

  @UnifiedField({
    description: "Reset period: 'day', 'month' or 'none'",
    isOptional: true,
    roles: RoleEnum.ADMIN,
  })
  period?: string = undefined;

  @UnifiedField({
    description: 'Id of the user or tenant this limit applies to',
    isOptional: true,
    roles: RoleEnum.ADMIN,
  })
  refId?: string = undefined;

  @UnifiedField({
    description: "Scope of the limit: 'user' or 'tenant'",
    isOptional: true,
    roles: RoleEnum.ADMIN,
  })
  scope?: string = undefined;
}
