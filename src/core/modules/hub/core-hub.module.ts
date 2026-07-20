import { DynamicModule, MiddlewareConsumer, Module, NestModule, Provider, Type } from '@nestjs/common';
import { PATH_METADATA } from '@nestjs/common/constants';

import { CoreHubActionsController } from './core-hub-actions.controller';
import { CoreHubHtmlService } from './core-hub-html.service';
import { CoreHubController } from './core-hub.controller';
import { CoreHubService } from './core-hub.service';
import { HUB_CONFIG, HUB_EMAIL_CAPTURE } from './hub.constants';
import { HubConfigContext, isReachableEnv, normalizeHubConfig } from './hub-config.helper';
import { HubTraceMiddleware } from './middleware/hub-trace.middleware';
import { CoreHubActionsService } from './services/core-hub-actions.service';
import { CoreHubDbService } from './services/core-hub-db.service';
import { CoreHubEmailService } from './services/core-hub-email.service';
import { CoreHubMailboxService } from './services/core-hub-mailbox.service';
import { CoreHubMigrationsService } from './services/core-hub-migrations.service';
import { CoreHubSourcesService } from './services/core-hub-sources.service';
import { HubLogBufferService } from './services/hub-log-buffer.service';
import { HubQueryProfilerService } from './services/hub-query-profiler.service';
import { HubTraceBufferService } from './services/hub-trace-buffer.service';
import { IHubConfig } from './interfaces/hub-config.interface';

/** Options passed by `CoreModule.forRoot()` when it registers the Hub. */
export interface CoreHubModuleOptions {
  /** Override the actions controller (must extend `CoreHubActionsController`). */
  actionsController?: Type<any>;
  /** Override the actions service (must extend `CoreHubActionsService`). */
  actionsService?: Type<any>;
  /** Raw hub config from `IServerOptions.hub`. */
  config: boolean | IHubConfig;
  /** Override the page/sidecar controller (must extend `CoreHubController`). */
  controller?: Type<any>;
  /** Environment-derived defaults (env name, version, GraphQL/permissions link resolution). */
  ctx: HubConfigContext;
  /** Override the HTML shell service (must extend `CoreHubHtmlService`). */
  htmlService?: Type<any>;
  /** Override the aggregator service (must extend `CoreHubService`). */
  service?: Type<any>;
}

/**
 * The Hub admin area (operator cockpit).
 *
 * Registered by `CoreModule.forRoot()` when `IServerOptions.hub` is enabled. The controller path and
 * required roles are assigned to the controller class at runtime (via `Reflect.defineMetadata`)
 * because they come from configuration — the same pattern the permissions module uses.
 */
@Module({})
export class CoreHubModule implements NestModule {
  // Write-once-per-forRoot (same accepted pattern as CoreModule.graphQlEnabled). Read by configure()
  // to decide whether to bind the trace middleware. The last forRoot wins in multi-app processes.
  private static traceEnabled = false;

  configure(consumer: MiddlewareConsumer): void {
    if (CoreHubModule.traceEnabled) {
      // Bind before RequestContextMiddleware so timing starts early; the trace path never reads
      // RequestContext (it uses req.user directly), so ordering is a non-issue.
      consumer.apply(HubTraceMiddleware).forRoutes('*');
    }
  }

  static forRoot(options: CoreHubModuleOptions): DynamicModule {
    const resolved = normalizeHubConfig(options.config, options.ctx);
    CoreHubModule.traceEnabled = resolved.collectors.traces !== false;

    // Guard: capture mode silently suppresses outgoing mail — forbid it in production/staging so a
    // misconfiguration cannot make password-reset, 2FA and verification mail vanish (mirrors the
    // JSONTransport guard in EmailService).
    if (resolved.mailbox !== false && resolved.mailbox.mode === 'capture' && isReachableEnv(resolved.env)) {
      throw new Error(
        `Hub mailbox mode 'capture' is not permitted in a reachable environment (${resolved.env}): it ` +
          "suppresses all outgoing mail. Use mode 'copy' (send + record) or disable the mailbox.",
      );
    }

    // Guard: a PUBLIC Hub (roles: false → no auth check whatsoever) in a reachable environment exposes
    // the config viewer, logs and DESTRUCTIVE admin actions (migrations, file delete, cron control) to
    // ANY unauthenticated request. Forbid it in production/staging unless the operator has EXPLICITLY
    // acknowledged it via `allowPublicAccessInProduction` (only sane behind a fully-controlled network
    // boundary). This mirrors the mailbox-capture guard above and closes the single most dangerous
    // Hub misconfiguration (e.g. a `roles: false` copied from a local config).
    if (resolved.roles === false && isReachableEnv(resolved.env) && !resolved.allowPublicAccessInProduction) {
      throw new Error(
        `Hub 'roles: false' (no auth check) is not permitted in a reachable environment (${resolved.env}): ` +
          'it exposes the config viewer, logs and destructive admin actions to unauthenticated requests. ' +
          'Keep the default ADMIN gate (omit `roles`), or — ONLY behind a fully-controlled network ' +
          'boundary — set hub.allowPublicAccessInProduction: true to acknowledge the risk.',
      );
    }

    const ControllerClass = options.controller || CoreHubController;
    const ActionsControllerClass = options.actionsController || CoreHubActionsController;

    // Runtime path + roles metadata (see permissions module), applied to BOTH controllers. Written
    // UNCONDITIONALLY so a second forRoot on the same class fully overrides the first — otherwise
    // stale metadata leaks across app instances that share the class (a real hazard in multi-app
    // tests). `roles: false` clears the metadata, which the guards read as "public" — a deliberate,
    // dangerous opt-out (documented in IHubConfig.roles).
    for (const Ctrl of resolved.actions ? [ControllerClass, ActionsControllerClass] : [ControllerClass]) {
      Reflect.defineMetadata(PATH_METADATA, resolved.path, Ctrl);
      if (resolved.roles === false) {
        Reflect.deleteMetadata('roles', Ctrl);
      } else {
        Reflect.defineMetadata('roles', resolved.roles, Ctrl);
      }
    }

    const providers: Provider[] = [
      { provide: HUB_CONFIG, useValue: resolved },
      { provide: CoreHubService, useClass: options.service || CoreHubService },
      { provide: CoreHubHtmlService, useClass: options.htmlService || CoreHubHtmlService },
      CoreHubDbService,
      CoreHubEmailService,
      CoreHubMigrationsService,
      CoreHubSourcesService,
      // Collectors are always provided; each is inert when its own config slice is disabled, so the
      // sidecar can answer `{ enabled: false }` rather than 404.
      HubLogBufferService,
      HubQueryProfilerService,
      HubTraceBufferService,
      HubTraceMiddleware,
    ];

    // Actions controller/service only when actions are enabled (disabling removes the routes → 404).
    const controllers: Type<any>[] = [ControllerClass];
    if (resolved.actions) {
      controllers.push(ActionsControllerClass);
      providers.push({ provide: CoreHubActionsService, useClass: options.actionsService || CoreHubActionsService });
    }

    // When the mailbox is enabled, provide it AND bind it to the EMAIL_CAPTURE token so EmailService
    // (which injects the token optionally) starts capturing. The module must be global for the token
    // to reach EmailService, which lives in a different module.
    const global = resolved.mailbox !== false;
    if (global) {
      providers.push(CoreHubMailboxService);
      providers.push({ provide: HUB_EMAIL_CAPTURE, useExisting: CoreHubMailboxService });
    }

    return {
      controllers,
      exports: [
        CoreHubService,
        CoreHubHtmlService,
        CoreHubDbService,
        CoreHubEmailService,
        CoreHubMigrationsService,
        CoreHubSourcesService,
        HubLogBufferService,
        HubQueryProfilerService,
        HubTraceBufferService,
        HUB_CONFIG,
        ...(global ? [CoreHubMailboxService, HUB_EMAIL_CAPTURE] : []),
      ],
      global,
      module: CoreHubModule,
      providers,
    };
  }
}
