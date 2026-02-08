import { CronJobParams, CronOnCompleteCommand } from 'cron';

import { CronJobConfig } from './cron-job-config.interface';

/**
 * Interface for cron job configuration
 *
 * This config can define timezone but not utcOffset,
 * if you want to use utcOffset, you have to use the CronJobConfigWithUtcOffset
 */
export interface CronJobConfigWithTimeZone<
  OC extends CronOnCompleteCommand | null = null,
  C = null,
> extends CronJobConfig {
  /**
   * Specify the timezone for the execution. This will modify the actual time relative to your timezone.
   * If the timezone is invalid, an error is thrown. Can be any string accepted by luxon's `DateTime.setZone()`
   * (https://moment.github.io/luxon/api-docs/index.html#datetimesetzone).
   */
  timeZone?: CronJobParams<OC, C>['timeZone'];

  /**
   * This allows you to specify the offset of the timezone rather than using the `timeZone` parameter.
   * Probably don't use both `timeZone` and `utcOffset` together or weird things may happen.
   */
  utcOffset?: null;
}
