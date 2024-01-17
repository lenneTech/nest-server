import { CronJobParams, CronOnCompleteCommand } from 'cron';

import { CronJobConfig } from './cron-job-config.interface';

/**
 * Interface for cron job configuration
 *
 * This config can define utcOffset but not timezone,
 * if you want to use timezone, you have to use the CronJobConfigWithTimezone
 */
export interface CronJobConfigWithUtcOffset<OC extends CronOnCompleteCommand | null = null, C = null>
  extends CronJobConfig {
  /**
   * Specify the timezone for the execution. This will modify the actual time relative to your timezone.
   * If the timezone is invalid, an error is thrown. Can be any string accepted by luxon's `DateTime.setZone()`
   * (https://moment.github.io/luxon/api-docs/index.html#datetimesetzone).
   */
  timeZone?: null;

  /**
   * This allows you to specify the offset of the timezone rather than using the `timeZone` parameter.
   * Probably don't use both `timeZone` and `utcOffset` together or weird things may happen.
   */
  utcOffset?: CronJobParams<OC, C>['unrefTimeout'];
}
