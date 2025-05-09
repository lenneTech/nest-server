import { ObjectType } from '@nestjs/graphql';

import { Restricted } from '../../../../core/common/decorators/restricted.decorator';
import { UnifiedField } from '../../../../core/common/decorators/unified-field.decorator';
import { RoleEnum } from '../../../../core/common/enums/role.enum';
import { User } from '../user.model';

@ObjectType({ description: 'Result of find and count' })
@Restricted(RoleEnum.ADMIN)
export class FindAndCountUsersResult {
  @UnifiedField({
    array: true,
    description: 'Found users',
    isOptional: true,
    type: () => User,
  })
  items: User[];

  @UnifiedField({
    description: 'Total count (skip/offset and limit/take are ignored in the count)',
    isOptional: false,
  })
  totalCount: number;
}
