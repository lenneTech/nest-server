import { Field, ObjectType } from '@nestjs/graphql';

import { Restricted } from '../../common/decorators/restricted.decorator';
import { RoleEnum } from '../../common/enums/role.enum';
import { BetterAuthSessionInfoModel, BetterAuthUserModel } from './better-auth-models';

/**
 * Better-Auth Authentication Response Model
 *
 * This model is returned by Better-Auth sign-in/sign-up mutations
 * and provides a structure compatible with the existing auth system
 * while supporting Better-Auth specific features like 2FA.
 */
@ObjectType({ description: 'Better-Auth Authentication Response' })
@Restricted(RoleEnum.S_EVERYONE)
export class BetterAuthAuthModel {
  /**
   * Whether the authentication was successful
   */
  @Field(() => Boolean, { description: 'Whether authentication was successful' })
  success: boolean;

  /**
   * Whether 2FA verification is required
   * When true, the client should prompt for 2FA code and call betterAuthVerify2FA
   */
  @Field(() => Boolean, {
    description: 'Whether 2FA verification is required to complete sign-in',
    nullable: true,
  })
  requiresTwoFactor?: boolean;

  /**
   * JWT token (only present if JWT plugin is enabled)
   * Use this for Bearer token authentication
   */
  @Field(() => String, {
    description: 'JWT token for Bearer authentication (if JWT plugin enabled)',
    nullable: true,
  })
  token?: string;

  /**
   * Authenticated user
   */
  @Field(() => BetterAuthUserModel, {
    description: 'Authenticated user',
    nullable: true,
  })
  user?: BetterAuthUserModel;

  /**
   * Session information
   */
  @Field(() => BetterAuthSessionInfoModel, {
    description: 'Session information',
    nullable: true,
  })
  session?: BetterAuthSessionInfoModel;

  /**
   * Error message if authentication failed
   */
  @Field(() => String, {
    description: 'Error message if authentication failed',
    nullable: true,
  })
  error?: string;
}
