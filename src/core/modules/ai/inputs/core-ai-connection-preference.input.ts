import { InputType } from '@nestjs/graphql';

import { Restricted } from '../../../common/decorators/restricted.decorator';
import { UnifiedField } from '../../../common/decorators/unified-field.decorator';
import { RoleEnum } from '../../../common/enums/role.enum';

/**
 * Input to create/update an AI connection preference (tenant/user default or
 * tenant-enforced). Admin-managed; user self-service goes through a dedicated
 * mutation that only sets the caller's own user preference.
 */
@InputType({ description: 'Input for an AI connection preference', isAbstract: true })
@Restricted(RoleEnum.ADMIN)
export class CoreAiConnectionPreferenceInput {
  @UnifiedField({
    description: 'The selected connection id',
    roles: RoleEnum.ADMIN,
  })
  connectionId: string = undefined;

  @UnifiedField({
    description: 'Whether the tenant connection is enforced (tenant scope only)',
    isOptional: true,
    roles: RoleEnum.ADMIN,
    type: () => Boolean,
  })
  enforced?: boolean = undefined;

  @UnifiedField({
    description: 'The tenant id or user id this preference belongs to',
    roles: RoleEnum.ADMIN,
  })
  refId: string = undefined;

  @UnifiedField({
    description: "Scope of the preference: 'tenant' or 'user'",
    roles: RoleEnum.ADMIN,
  })
  scope: string = undefined;
}
