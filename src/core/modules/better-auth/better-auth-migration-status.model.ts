import { Field, Int, ObjectType } from '@nestjs/graphql';

/**
 * Model representing the migration status from Legacy Auth to Better-Auth (IAM)
 *
 * This model provides administrators with information about how many users
 * have been migrated to the IAM system, helping them determine when it's
 * safe to disable Legacy Auth.
 */
@ObjectType({ description: 'Migration status from Legacy Auth to Better-Auth (IAM)' })
export class BetterAuthMigrationStatusModel {
  /**
   * Total number of users in the system
   */
  @Field(() => Int, { description: 'Total number of users in the system' })
  totalUsers: number;

  /**
   * Number of users that have been migrated to IAM
   * A user is considered migrated when they have an iamId set
   */
  @Field(() => Int, { description: 'Number of users with iamId (linked to IAM)' })
  usersWithIamId: number;

  /**
   * Number of users that have a credential account in IAM
   * This means they can sign in via Better-Auth
   */
  @Field(() => Int, { description: 'Number of users with IAM credential account' })
  usersWithIamAccount: number;

  /**
   * Number of users that are fully migrated (have both iamId and credential account)
   */
  @Field(() => Int, { description: 'Number of users fully migrated (iamId + credential account)' })
  fullyMigratedUsers: number;

  /**
   * Number of users still requiring migration
   * These users have not yet signed in via IAM
   */
  @Field(() => Int, { description: 'Number of users not yet migrated' })
  pendingMigrationUsers: number;

  /**
   * Percentage of users that have been fully migrated (0-100)
   */
  @Field(() => Number, { description: 'Percentage of users fully migrated (0-100)' })
  migrationPercentage: number;

  /**
   * Whether Legacy Auth can be safely disabled
   * True only when ALL users have been fully migrated
   *
   * Note: Even if this returns true, Legacy Auth cannot be removed without
   * code changes because CoreModule.forRoot requires AuthService for
   * GraphQL Subscriptions authentication.
   */
  @Field(() => Boolean, {
    description: 'Whether all users are migrated (Legacy Auth could be disabled if CoreModule supported it)',
  })
  canDisableLegacyAuth: boolean;

  /**
   * List of emails of users pending migration (limited to first 100)
   * Helps administrators identify which users need to sign in via IAM
   */
  @Field(() => [String], {
    description: 'Emails of users pending migration (max 100)',
    nullable: true,
  })
  pendingUserEmails?: string[];
}
