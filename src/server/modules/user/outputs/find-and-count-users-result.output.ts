import { ObjectType } from '@nestjs/graphql';

import { Restricted } from '../../../../core/common/decorators/restricted.decorator.js';
import { UnifiedField } from '../../../../core/common/decorators/unified-field.decorator.js';
import { RoleEnum } from '../../../../core/common/enums/role.enum.js';
import { PaginationInfo } from '../../../../core/common/models/pagination-info.model.js';
import { User } from '../user.model.js';

@ObjectType({ description: 'Result of find and count' })
@Restricted(RoleEnum.ADMIN)
export class FindAndCountUsersResult {
  @UnifiedField({
    description: 'Found users',
    isArray: true,
    isOptional: true,
    type: () => User,
  })
  items: User[];

  @UnifiedField({
    description: 'Total count (skip/offset and limit/take are ignored in the count)',
    isOptional: false,
  })
  totalCount: number;

  @UnifiedField({
    description: 'Pagination information',
    isOptional: true,
    type: () => PaginationInfo,
  })
  pagination?: PaginationInfo;
}
