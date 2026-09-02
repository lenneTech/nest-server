import { Injectable, Logger, OnApplicationBootstrap, Optional } from '@nestjs/common';

import { ConfigService } from '../../common/services/config.service';
import { CoreBetterAuthUserMapper } from '../better-auth/core-better-auth-user.mapper';
import { isLegacyEndpointEnabled } from './helpers/legacy-endpoints.helper';

/**
 * Says out loud, once at boot, that this deployment still exposes Legacy Auth.
 *
 * WHY THIS EXISTS
 *
 * Legacy Auth is superseded by IAM (Better-Auth) and slated for removal (see
 * `.claude/rules/module-deprecation.md`). Until 11.38.0 nothing ever mentioned that a
 * project was still running it: `auth.legacyEndpoints.enabled` defaulted to `true`, so a
 * second fully functional password-authentication surface stayed open by inertia, and
 * `betterAuthMigrationStatus.canDisableLegacyAuth` — which exists precisely to say when
 * it can be closed — only answered when somebody thought to ask.
 *
 * Registered only by `CoreAuthModule`, which exists only when a project passes the
 * legacy three-argument `CoreModule.forRoot(CoreAuthService, AuthModule.forRoot(...),
 * envConfig)`. An IAM-only project never sees any of this.
 *
 * It only REPORTS. Turning legacy auth off for a project that still needs it would lock
 * out every user who has not signed in through IAM yet, which is the opposite of a safe
 * default — the migration has to be finished before the door closes, and only the
 * operator can know when that is.
 */
@Injectable()
export class CoreLegacyAuthDeprecationInitializer implements OnApplicationBootstrap {
  protected readonly logger = new Logger(CoreLegacyAuthDeprecationInitializer.name);

  constructor(
    protected readonly configService: ConfigService,
    @Optional() protected readonly userMapper?: CoreBetterAuthUserMapper,
  ) {}

  onApplicationBootstrap(): void {
    const legacyConfig = this.configService.getFastButReadOnly('auth')?.legacyEndpoints;
    const graphqlOn = isLegacyEndpointEnabled(legacyConfig, 'graphql');
    const restOn = isLegacyEndpointEnabled(legacyConfig, 'rest');

    if (!graphqlOn && !restOn) {
      // Every endpoint is closed. That is the state the migration aims at — but it is only
      // GOOD if the migration is actually finished, and 11.38.0 made this the DEFAULT. So a
      // project that upgraded without deciding lands here whether or not its users can still
      // sign in.
      //
      // Reporting only the enabled case would mean the warning fires in the safe state and
      // stays silent in the dangerous one. This branch says the other half: you just closed a
      // door some of your users still need.
      void this.reportLockoutRisk();
      return;
    }

    const surfaces = [graphqlOn && 'GraphQL', restOn && 'REST'].filter(Boolean).join(' + ');
    this.logger.warn(
      `Legacy Auth is ENABLED (${surfaces}). It is deprecated in favour of IAM (Better-Auth) and will be removed. ` +
        'Close it with auth.legacyEndpoints.enabled: false once your users are migrated.',
    );

    // Say how far the migration actually is, so the warning carries a next step rather
    // than just a verdict.
    //
    // Deliberately NOT awaited. Nest waits for every onApplicationBootstrap hook before
    // `listen()` resolves, and `getMigrationStatus()` is collection-scale work — so awaiting it
    // would add to time-to-ready on every pod of every rolling deploy, for a log line. A
    // readiness probe that fails while the server counts users is a worse outcome than a
    // warning that arrives a second late.
    void this.reportMigrationStatus();
  }

  /**
   * Warns when legacy auth is closed while users still depend on it.
   *
   * The counterpart to the deprecation warning: that one fires when the door is open, this one
   * when it was just shut on people who cannot get in any other way. Best-effort and detached
   * from the boot, for the same reason as {@link reportMigrationStatus}.
   */
  protected async reportLockoutRisk(): Promise<void> {
    try {
      const status = await this.userMapper?.getMigrationStatus?.({ includePendingEmails: false });
      if (!status || status.totalUsers === 0 || status.canDisableLegacyAuth) {
        return;
      }

      this.logger.warn(
        `Legacy Auth is DISABLED, but only ${status.fullyMigratedUsers}/${status.totalUsers} users ` +
          `(${status.migrationPercentage}%) are migrated to IAM — the rest cannot sign in at all. ` +
          'Set auth.legacyEndpoints.enabled: true (LEGACY_AUTH_ENABLED=true) until this reaches 100%.',
      );
    } catch (error) {
      this.logger.debug(
        `Could not read the IAM migration status: ${error instanceof Error ? error.message : 'Unknown error'}`,
      );
    }
  }

  /**
   * Reads and logs the IAM migration progress. Best-effort by construction: it runs detached
   * from the boot, and a failure is reported at debug level rather than surfaced.
   */
  protected async reportMigrationStatus(): Promise<void> {
    try {
      // `includePendingEmails: false` — this reporter needs the counts, never the addresses.
      // Collecting them costs two more collection-scale queries, one a guaranteed COLLSCAN,
      // and handling PII that is then discarded.
      const status = await this.userMapper?.getMigrationStatus?.({ includePendingEmails: false });
      if (!status) {
        return;
      }
      if (status.canDisableLegacyAuth) {
        this.logger.warn(
          `All ${status.totalUsers} users are migrated to IAM — Legacy Auth can be switched off now ` +
            '(auth.legacyEndpoints.enabled: false).',
        );
      } else {
        this.logger.log(
          `IAM migration status: ${status.fullyMigratedUsers}/${status.totalUsers} users migrated ` +
            `(${status.migrationPercentage}%). Legacy Auth stays required until this reaches 100%.`,
        );
      }
    } catch (error) {
      this.logger.debug(
        `Could not read the IAM migration status: ${error instanceof Error ? error.message : 'Unknown error'}`,
      );
    }
  }
}
