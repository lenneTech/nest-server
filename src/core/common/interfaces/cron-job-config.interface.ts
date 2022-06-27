import { CronExpression } from '@nestjs/schedule';
import { CronCommand } from 'cron';
import { Falsy } from '../types/falsy.type';

/**
 * Interface for cron job configuration
 */
export interface CronJobConfig {
  /**
   * The context within which to execute the onTick method. This defaults to the cronjob itself allowing you to call
   * `this.stop()`. However, if you change this you'll have access to the functions and values within your context
   * object.
   */
  context?: any;

  /**
   * The time to fire off your job. This can be in the form of cron syntax or a JS `Date` object.
   */
  cronTime: CronExpression | string | Date | Falsy;

  /**
   * A function that will fire when the job is complete, when it is stopped.
   */
  onComplete?: CronCommand | null;

  /**
   * This will immediately fire your `onTickfunction` as soon as the requisit initialization has happened.
   * This option is set to `true` by default.
   */
  runOnInit?: boolean;

  /**
   * Depending on how long the execution of a job takes, it may happen that several executions take place at the
   * same time. This can be prevented with `runParallel = false`.This option is set to `true` by default.
   * If a number is specified, it is used as the number of maximum parallel executions.
   */
  runParallel?: boolean | number;

  /**
   * Whether an exception is thrown or only acknowledged with a console.error.
   * This option is set to `true` by default.
   */
  throwException?: boolean;

  /**
   * Specify the timezone for the execution. This will modify the actual time relative to your timezone.
   * If the timezone is invalid, an error is thrown. Can be any string accepted by luxon's `DateTime.setZone()`
   * (https://moment.github.io/luxon/api-docs/index.html#datetimesetzone).
   */
  timeZone?: string;

  /**
   * If you have code that keeps the event loop running and want to stop the node process when that finishes
   * regardless of the state of your cronjob, you can do so making use of this parameter. This is off by default and
   * cron will run as if it needs to control the event loop. For more information take a look at
   * timers#timers_timeout_unref  from the NodeJS docs.
   */
  unrefTimeout?: boolean;

  /**
   * This allows you to specify the offset of your timezone rather than using the `timeZoneparam.
   * Probably don't use both ``timeZone` andutcOffset`` together or weird things may happen.
   */
  utcOffset?: string | number;
}
