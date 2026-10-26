import { ObjectType } from '@nestjs/graphql';

import { Restricted } from '../../common/decorators/restricted.decorator.js';
import { UnifiedField } from '../../common/decorators/unified-field.decorator.js';
import { RoleEnum } from '../../common/enums/role.enum.js';
import { CoreModel } from '../../common/models/core-model.model.js';
import { JSON } from '../../common/scalars/json.scalar.js';

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
  @UnifiedField({
    description: 'The overall status of the Health Check',
    isOptional: false,
    roles: RoleEnum.S_EVERYONE,
  })
  status: 'error' | 'ok' | 'shutting_down' = undefined;

  /**
   * The info object contains information of each health indicator which is of status “up”
   */
  @UnifiedField({
    description: 'The info object contains information of each health indicator which is of status “up”',
    gqlType: JSON,
    isOptional: true,
    roles: RoleEnum.S_EVERYONE,
    type: () => Object,
  })
  info: JSON = undefined;

  /**
   * The error object contains information of each health indicator which is of status “down”
   */
  @UnifiedField({
    description: 'The error object contains information of each health indicator which is of status “down”',
    gqlType: JSON,
    isOptional: true,
    roles: RoleEnum.S_EVERYONE,
    type: () => Object,
  })
  error: JSON = undefined;

  /**
   * The details object contains information of every health indicator
   */
  @UnifiedField({
    description: 'The details object contains information of every health indicator',
    gqlType: JSON,
    isOptional: true,
    roles: RoleEnum.S_EVERYONE,
    type: () => Object,
  })
  details: JSON = undefined;
}
