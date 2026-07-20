import { Injectable, Logger, Optional } from '@nestjs/common';
import { ModuleRef } from '@nestjs/core';
import { SchedulerRegistry } from '@nestjs/schedule';

import { CoreAiInteractionService } from '../../ai/services/core-ai-interaction.service';
import { CoreBetterAuthUserMapper } from '../../better-auth/core-better-auth-user.mapper';
import { CoreErrorCodeService } from '../../error-code/core-error-code.service';
import { CorePermissionsService } from '../../permissions/core-permissions.service';
import { HubCronData, HubErrorCodesData, HubUnavailable } from '../interfaces/hub-panels.interface';

/**
 * Single choke point for the Hub's OPTIONAL data sources.
 *
 * Providers that live in non-global modules (error-code, better-auth, ai, permissions) cannot be
 * `@Optional() @Inject()`-ed — that would always resolve to `undefined` even when the module exists.
 * Instead they are resolved lazily via `ModuleRef.get(Token, { strict: false })` inside method bodies
 * (call time — SWC/TDZ-safe), cached after the first hit, and every panel degrades to
 * `{ available: false }` when its source is absent. `SchedulerRegistry` IS global, so it is injected
 * normally.
 */
@Injectable()
export class CoreHubSourcesService {
  protected readonly logger = new Logger(CoreHubSourcesService.name);
  private readonly resolveCache = new Map<unknown, unknown>();

  constructor(
    protected readonly moduleRef: ModuleRef,
    @Optional() protected readonly schedulerRegistry?: SchedulerRegistry,
  ) {}

  /** AI availability + a light interaction/usage summary. */
  async getAi(): Promise<HubUnavailable | { available: true; totalInteractions: number }> {
    const interactionService = this.resolve<CoreAiInteractionService>(CoreAiInteractionService);
    if (!interactionService) {
      return { available: false, hint: 'The AI module is not enabled.' };
    }
    try {
      const model = (interactionService as unknown as { mainDbModel?: { estimatedDocumentCount(): Promise<number> } })
        .mainDbModel;
      const totalInteractions = model ? await model.estimatedDocumentCount() : 0;
      return { available: true, totalInteractions };
    } catch (error) {
      this.logger.warn(`Failed to read AI interactions: ${error instanceof Error ? error.message : String(error)}`);
      return { available: true, totalInteractions: 0 };
    }
  }

  /** Legacy → IAM auth migration status. */
  async getAuthMigration(): Promise<HubUnavailable | Record<string, unknown>> {
    const mapper = this.resolve<CoreBetterAuthUserMapper>(CoreBetterAuthUserMapper);
    if (!mapper) {
      return { available: false, hint: 'BetterAuth is not enabled.' };
    }
    try {
      return { available: true, ...(await mapper.getMigrationStatus()) };
    } catch (error) {
      this.logger.warn(
        `Failed to read auth migration status: ${error instanceof Error ? error.message : String(error)}`,
      );
      return { available: false, hint: 'Failed to read auth migration status.' };
    }
  }

  /** Registered cron jobs, intervals and timeouts (via `@nestjs/schedule`). */
  getCron(): HubCronData | HubUnavailable {
    if (!this.schedulerRegistry) {
      return { available: false, hint: 'ScheduleModule.forRoot() is not imported.' };
    }
    try {
      const jobs = [];
      for (const [name, job] of this.schedulerRegistry.getCronJobs()) {
        let nextDate: string | undefined;
        let lastDate: string | undefined;
        try {
          nextDate = job.nextDate?.()?.toISO?.() ?? undefined;
        } catch {
          /* a job may throw before first run */
        }
        try {
          lastDate = job.lastDate?.()?.toISOString?.() ?? undefined;
        } catch {
          /* no last run yet */
        }
        jobs.push({ lastDate, name, nextDate, running: Boolean((job as unknown as { running?: boolean }).running) });
      }
      return {
        intervals: [...this.schedulerRegistry.getIntervals()],
        jobs,
        timeouts: [...this.schedulerRegistry.getTimeouts()],
      };
    } catch (error) {
      this.logger.warn(`Failed to read scheduler registry: ${error instanceof Error ? error.message : String(error)}`);
      return { available: false, hint: 'Failed to read scheduled jobs.' };
    }
  }

  /** True when BetterAuth (IAM) is actually wired in — used by the dashboard feature matrix. */
  isBetterAuthActive(): boolean {
    return !!this.resolve(CoreBetterAuthUserMapper);
  }

  /**
   * Whether each optional/degradable panel's backing source is actually present. Fed into the session
   * payload so the client can grey out and DISABLE nav entries whose module is absent, instead of
   * letting the user click through to an "unavailable" panel. Panels not listed here are always
   * available (their data is intrinsic to the Hub).
   */
  getPanelAvailability(): Record<string, boolean> {
    return {
      ai: !!this.resolve(CoreAiInteractionService),
      'auth-migration': !!this.resolve(CoreBetterAuthUserMapper),
      cron: !!this.schedulerRegistry,
      'error-codes': !!this.resolve(CoreErrorCodeService),
      routes: !!this.resolve(CorePermissionsService),
    };
  }

  /** Control a cron job by name (start | stop | trigger). Throws when scheduling is unavailable. */
  controlCron(name: string, action: 'start' | 'stop' | 'trigger'): void {
    if (!this.schedulerRegistry) {
      throw new Error('ScheduleModule.forRoot() is not imported.');
    }
    const job = this.schedulerRegistry.getCronJob(name);
    if (action === 'start') {
      job.start();
    } else if (action === 'stop') {
      job.stop();
    } else {
      // Fire the job's callback once now.
      const fire = (job as unknown as { fireOnTick?: () => void }).fireOnTick;
      if (typeof fire === 'function') {
        fire.call(job);
      }
    }
  }

  /** Error-code catalog with de/en translations. */
  getErrorCodes(locale = 'en'): HubErrorCodesData | HubUnavailable {
    const service = this.resolve<CoreErrorCodeService>(CoreErrorCodeService);
    if (!service) {
      return { available: false, hint: 'The error-code module is not enabled.' };
    }
    try {
      const codes = service.getErrorCodes();
      const de = this.safeTranslations(service, 'de');
      const en = this.safeTranslations(service, 'en');
      return {
        codes: codes.map((code) => ({ code, de: de[code], en: en[code] })),
        locale,
      };
    } catch (error) {
      this.logger.warn(`Failed to read error codes: ${error instanceof Error ? error.message : String(error)}`);
      return { available: false, hint: 'Failed to read error codes.' };
    }
  }

  /** The permissions report (modules + coverage stats), reusing the permissions module's cached scan. */
  async getRoutes(): Promise<HubUnavailable | { modules: unknown[]; stats: unknown; warnings: unknown[] }> {
    const service = this.resolve<CorePermissionsService>(CorePermissionsService);
    if (!service) {
      return { available: false, hint: 'The permissions module is not enabled — see /permissions.' };
    }
    try {
      const report = service.getReport() ?? (await service.getOrScan());
      return { modules: report.modules ?? [], stats: report.stats, warnings: report.warnings ?? [] };
    } catch (error) {
      this.logger.warn(`Failed to read routes report: ${error instanceof Error ? error.message : String(error)}`);
      return { available: false, hint: 'Failed to read routes report.' };
    }
  }

  /** Resolve an optional provider once, container-wide, and cache the result (including a miss). */
  protected resolve<T>(token: unknown): T | undefined {
    if (this.resolveCache.has(token)) {
      return this.resolveCache.get(token) as T | undefined;
    }
    let instance: T | undefined;
    try {
      instance = this.moduleRef.get<T>(token as never, { strict: false });
    } catch {
      instance = undefined;
    }
    this.resolveCache.set(token, instance);
    return instance;
  }

  private safeTranslations(service: CoreErrorCodeService, locale: string): Record<string, string> {
    try {
      return service.getTranslations(locale as never).errors;
    } catch {
      return {};
    }
  }
}
