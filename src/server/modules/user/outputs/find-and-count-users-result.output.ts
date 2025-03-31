import { Field, ObjectType } from '@nestjs/graphql';

import { Restricted } from '../../../../core/common/decorators/restricted.decorator';
import { RoleEnum } from '../../../../core/common/enums/role.enum';
import { User } from '../user.model';

@ObjectType({ description: 'Result of find and count' })
@Restricted(RoleEnum.ADMIN)
export class FindAndCountUsersResult {
  @Field(() => [User], { description: 'Found users' })
  @Restricted(RoleEnum.S_EVERYONE)
  items: User[];

  @Field({ description: 'Total count (skip/offset and limit/take are ignored in the count)' })
  @Restricted(RoleEnum.S_EVERYONE)
  totalCount: number;
}
