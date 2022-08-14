import { Field, ObjectType } from '@nestjs/graphql';
import { User } from '../user.model';

@ObjectType({ description: 'Result of find and count' })
export class FindAndCountUserResult {
  @Field(() => [User], { description: 'Found users' })
  items: User[];

  @Field({ description: 'Total count (skip/offset and limit/take are ignored in the count)' })
  totalCount: number;
}
