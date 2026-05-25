import { InputType } from '@nestjs/graphql';

import { Restricted } from '../../../common/decorators/restricted.decorator';
import { UnifiedField } from '../../../common/decorators/unified-field.decorator';
import { RoleEnum } from '../../../common/enums/role.enum';
import { CoreAiBudgetLimitInput } from './core-ai-budget-limit.input';

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
  })
  override scope: string = undefined;
}
