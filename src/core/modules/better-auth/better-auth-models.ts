import { Field, ObjectType } from '@nestjs/graphql';

import { Restricted } from '../../common/decorators/restricted.decorator';
import { RoleEnum } from '../../common/enums/role.enum';

/**
 * Better-Auth User Model for GraphQL
 */
@ObjectType({ description: 'Better-Auth User' })
@Restricted(RoleEnum.S_EVERYONE)
export class BetterAuthUserModel {
  @Field(() => String, { description: 'User ID' })
  id: string;

  @Field(() => String, { description: 'IAM provider user ID (e.g., Better-Auth)', nullable: true })
  iamId?: string;

  @Field(() => String, { description: 'Email address' })
  email: string;

  @Field(() => String, { description: 'Display name', nullable: true })
  name?: string;

  @Field(() => Boolean, { description: 'Email verified status', nullable: true })
  emailVerified?: boolean;

  @Field(() => Boolean, { description: 'User verified status', nullable: true })
  verified?: boolean;

  @Field(() => [String], { description: 'User roles', nullable: true })
  roles?: string[];
}

/**
 * Better-Auth Session Model for GraphQL
 */
@ObjectType({ description: 'Better-Auth Session' })
@Restricted(RoleEnum.S_USER)
export class BetterAuthSessionModel {
  @Field(() => String, { description: 'Session ID' })
  id: string;

  @Field(() => Date, { description: 'Session expiration date' })
  expiresAt: Date;

  @Field(() => BetterAuthUserModel, { description: 'Session user' })
  user: BetterAuthUserModel;
}

/**
 * Better-Auth Session Info (simplified for responses)
 */
@ObjectType({ description: 'Better-Auth Session Info' })
@Restricted(RoleEnum.S_EVERYONE)
export class BetterAuthSessionInfoModel {
  @Field(() => String, { description: 'Session ID', nullable: true })
  id?: string;

  @Field(() => String, { description: 'Session token', nullable: true })
  token?: string;

  @Field(() => Date, { description: 'Session expiration date', nullable: true })
  expiresAt?: Date;
}

/**
 * Better-Auth 2FA Setup Model (returned when enabling 2FA)
 */
@ObjectType({ description: 'Better-Auth 2FA setup data' })
@Restricted(RoleEnum.S_USER)
export class BetterAuth2FASetupModel {
  @Field(() => Boolean, { description: 'Whether the operation was successful' })
  success: boolean;

  @Field(() => String, { description: 'TOTP URI for QR code generation', nullable: true })
  totpUri?: string;

  @Field(() => [String], { description: 'Backup codes for account recovery', nullable: true })
  backupCodes?: string[];

  @Field(() => String, { description: 'Error message if failed', nullable: true })
  error?: string;
}

/**
 * Better-Auth Passkey Model
 */
@ObjectType({ description: 'Better-Auth Passkey' })
@Restricted(RoleEnum.S_USER)
export class BetterAuthPasskeyModel {
  @Field(() => String, { description: 'Passkey ID' })
  id: string;

  @Field(() => String, { description: 'Passkey name', nullable: true })
  name?: string;

  @Field(() => String, { description: 'Credential ID' })
  credentialId: string;

  @Field(() => Date, { description: 'Creation date' })
  createdAt: Date;
}

/**
 * Better-Auth Passkey Registration Challenge
 */
@ObjectType({ description: 'Better-Auth Passkey registration challenge' })
@Restricted(RoleEnum.S_USER)
export class BetterAuthPasskeyChallengeModel {
  @Field(() => Boolean, { description: 'Whether the operation was successful' })
  success: boolean;

  @Field(() => String, { description: 'Challenge data (JSON)', nullable: true })
  challenge?: string;

  @Field(() => String, { description: 'Error message if failed', nullable: true })
  error?: string;
}

/**
 * Better-Auth features status
 */
@ObjectType({ description: 'Better-Auth features status' })
@Restricted(RoleEnum.S_EVERYONE)
export class BetterAuthFeaturesModel {
  @Field(() => Boolean, { description: 'Whether Better-Auth is enabled' })
  enabled: boolean;

  @Field(() => Boolean, { description: 'Whether JWT plugin is enabled' })
  jwt: boolean;

  @Field(() => Boolean, { description: 'Whether 2FA is enabled' })
  twoFactor: boolean;

  @Field(() => Boolean, { description: 'Whether Passkey is enabled' })
  passkey: boolean;

  @Field(() => Boolean, { description: 'Whether legacy password handling is enabled' })
  legacyPassword: boolean;

  @Field(() => [String], { description: 'List of enabled social providers' })
  socialProviders: string[];
}
