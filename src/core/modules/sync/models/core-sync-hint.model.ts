import { Field, ObjectType } from '@nestjs/graphql';

import { Restricted } from '../../../common/decorators/restricted.decorator.js';
import { RoleEnum } from '../../../common/enums/role.enum.js';

/**
 * A change hint of offline sync (protocol §9): the model changed at this time — nothing else, no record, no id, no
 * tenant. A client answers it with a pull. Who receives it was decided before it was sent.
 */
@ObjectType('SyncHint', { description: 'A synchronized model changed: pull it' })
@Restricted(RoleEnum.S_EVERYONE)
export class CoreSyncHintModel {
  @Field(() => Date, { description: 'When the change was sent' })
  at: Date;

  @Field(() => String, { description: 'The changed model, as in GET /sync/{model}' })
  model: string;
}
