import { InputType } from '@nestjs/graphql';
import { IsIn } from 'class-validator';

import { Restricted } from '../../../common/decorators/restricted.decorator.js';
import { UnifiedField } from '../../../common/decorators/unified-field.decorator.js';
import { RoleEnum } from '../../../common/enums/role.enum.js';
import { CoreAiBudgetLimitInput } from './core-ai-budget-limit.input.js';

/**
 * Input to create an AI budget limit. `scope` and `refId` are required.
 */
@InputType({ description: 'Input to create an AI budget limit', isAbstract: true })
@Restricted(RoleEnum.ADMIN)
export class CoreAiBudgetLimitCreateInput extends CoreAiBudgetLimitInput {
  @UnifiedField({
    description: 'Id of the user or tenant this limit applies to',
    roles: RoleEnum.ADMIN,
  })
  override refId: string = undefined;

  @UnifiedField({
    description: "Scope of the limit: 'user' or 'tenant'",
    roles: RoleEnum.ADMIN,
    validator: () => [IsIn(['tenant', 'user'])],
  })
  override scope: string = undefined;
}
