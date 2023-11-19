import { CronJobParams, CronOnCompleteCommand } from 'cron';

/**
 * Interface for cron job configuration
 * @deprecated Use CronJobConfigWithTimeZone or CronJobConfigWithUtcOffset instead
 */
export interface CronJobConfig<OC extends CronOnCompleteCommand | null = null, C = null> {
  /**
   * The context within which to execute the onTick method. This defaults to the cronjob itself allowing you to call
   * `this.stop()`. However, if you change this you'll have access to the functions and values within your context
   * object.
   */
  context?: CronJobParams<OC, C>['context'];

  /**
   * The time to fire off your job. This can be in the form of cron syntax or a JS `Date` object.
   */
  cronTime: CronJobParams<OC, C>['cronTime'];

  /**
   * Whether the cron job is disabled or not.
   * This option is set to `false` by default
   */
  disabled?: boolean;

  /**
   * A function that will fire when the job is complete, when it is stopped.
   */
  onComplete?: CronJobParams<OC, C>['onComplete'];

  /**
   * This will immediately fire the `onTick` function as soon as the requisite initialization has happened.
   * This option is set to `true` by default.
   */
  runOnInit?: CronJobParams<OC, C>['runOnInit'];

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
  timeZone?: CronJobParams<OC, C>['timeZone'] | null;

  /**
   * If you have code that keeps the event loop running and want to stop the node process when that finishes
   * regardless of the state of your cronjob, you can do so making use of this parameter. This is off by default and
   * cron will run as if it needs to control the event loop. For more information take a look at
   * timers#timers_timeout_unref  from the NodeJS docs.
   */
  unrefTimeout?: CronJobParams<OC, C>['unrefTimeout'];

  /**
   * This allows you to specify the offset of the timezone rather than using the `timeZone` parameter.
   * Probably don't use both `timeZone` and `utcOffset` together or weird things may happen.
   */
  utcOffset?: CronJobParams<OC, C>['unrefTimeout'] | null;
}
