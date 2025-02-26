import { Field, ObjectType } from '@nestjs/graphql';
import { ApiProperty } from '@nestjs/swagger';

import { Restricted } from '../../common/decorators/restricted.decorator';
import { RoleEnum } from '../../common/enums/role.enum';
import { CoreModel } from '../../common/models/core-model.model';
import { CoreUserModel } from '../user/core-user.model';

/**
 * CoreAuth model for the response after the sign in
 */
@Restricted(RoleEnum.S_EVERYONE)
@ObjectType({ description: 'CoreAuth', isAbstract: true })
export class CoreAuthModel extends CoreModel {
  // ===================================================================================================================
  // Properties
  // ===================================================================================================================

  /**
   * JSON Web Token(JWT)
   */
  @ApiProperty({
    description: 'JSON Web Token(JWT) used for auth',
    example: 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9...',
  })
  @Field({ description: 'JSON Web Token(JWT)', nullable: true })
  @Restricted(RoleEnum.S_EVERYONE)
  token?: string = undefined;

  /**
   * Refresh token
   */
  @ApiProperty({
    description: 'Refresh JSON Web Token(JWT) used for auth',
    example: 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9...',
  })
  @Field({ description: 'Refresh token', nullable: true })
  @Restricted(RoleEnum.S_EVERYONE)
  refreshToken?: string = undefined;

  /**
   * Current user
   */
  @ApiProperty({
    description: 'User who signed in',
    required: true,
    type: () => CoreUserModel,
  })
  @Field({ description: 'Current user' })
  @Restricted(RoleEnum.S_EVERYONE)
  user: CoreUserModel = undefined;

  // ===================================================================================================================
  // Methods
  // ===================================================================================================================

  /**
   * Initialize instance with default values instead of undefined
   */
  override init() {
    super.init();
    // Nothing more to initialize yet
    return this;
  }

  /**
   * Map input
   */
  override map(input) {
    super.map(input);
    // There is nothing to map yet. Non-primitive variables should always be mapped.
    // If something comes up, you can use `mapClasses` / `mapClassesAsync` from ModelHelper.
    return this;
  }
}
