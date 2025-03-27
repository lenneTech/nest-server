import { Field, ObjectType } from '@nestjs/graphql';

import { Restricted } from '../../common/decorators/restricted.decorator';
import { RoleEnum } from '../../common/enums/role.enum';
import { CoreModel } from '../../common/models/core-model.model';
import { JSON } from '../../common/scalars/json.scalar';

/**
 * User model
 */
@ObjectType({ description: 'Health check result' })
@Restricted(RoleEnum.S_EVERYONE)
export abstract class CoreHealthCheckResult extends CoreModel {
  // ===================================================================================================================
  // Properties
  // ===================================================================================================================

  /**
   * The overall status of the Health Check
   */
  @Field({ description: 'The overall status of the Health Check', nullable: false })
  @Restricted(RoleEnum.S_EVERYONE)
  status: 'error' | 'ok' | 'shutting_down' = undefined;

  /**
   * The info object contains information of each health indicator which is of status “up”
   */
  @Field(type => JSON, {
    description: 'The info object contains information of each health indicator which is of status “up”',
    nullable: true,
  })
  @Restricted(RoleEnum.S_EVERYONE)
  info: JSON = undefined;

  /**
   * The error object contains information of each health indicator which is of status “down”
   */
  @Field(type => JSON, {
    description: 'The error object contains information of each health indicator which is of status “down”',
    nullable: true,
  })
  @Restricted(RoleEnum.S_EVERYONE)
  error: JSON = undefined;

  /**
   * The details object contains information of every health indicator
   */
  @Field(type => JSON, {
    description: 'The details object contains information of every health indicator',
    nullable: false,
  })
  @Restricted(RoleEnum.S_EVERYONE)
  details: JSON = undefined;
}
