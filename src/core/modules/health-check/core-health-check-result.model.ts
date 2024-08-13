import { Field, ObjectType } from '@nestjs/graphql';

import { Restricted } from '../../common/decorators/restricted.decorator';
import { RoleEnum } from '../../common/enums/role.enum';
import { CoreModel } from '../../common/models/core-model.model';
import { JSON } from '../../common/scalars/json.scalar';

/**
 * User model
 */
@Restricted(RoleEnum.S_EVERYONE)
@ObjectType({ description: 'Health check result' })
export abstract class CoreHealthCheckResult extends CoreModel {
  // ===================================================================================================================
  // Properties
  // ===================================================================================================================

  /**
   * The overall status of the Health Check
   */
  @Restricted(RoleEnum.S_EVERYONE)
  @Field({ description: 'The overall status of the Health Check', nullable: false })
  status: 'error' | 'ok' | 'shutting_down' = undefined;

  /**
   * The info object contains information of each health indicator which is of status “up”
   */
  @Restricted(RoleEnum.S_EVERYONE)
  @Field(type => JSON, {
    description: 'The info object contains information of each health indicator which is of status “up”',
    nullable: true,
  })
  info: JSON = undefined;

  /**
   * The error object contains information of each health indicator which is of status “down”
   */
  @Restricted(RoleEnum.S_EVERYONE)
  @Field(type => JSON, {
    description: 'The error object contains information of each health indicator which is of status “down”',
    nullable: true,
  })
  error: JSON = undefined;

  /**
   * The details object contains information of every health indicator
   */
  @Restricted(RoleEnum.S_EVERYONE)
  @Field(type => JSON, {
    description: 'The details object contains information of every health indicator',
    nullable: false,
  })
  details: JSON = undefined;
}
