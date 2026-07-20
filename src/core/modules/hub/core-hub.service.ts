import { Inject, Injectable, Optional } from '@nestjs/common';
import { InjectConnection } from '@nestjs/mongoose';
import { Connection } from 'mongoose';

import { getBuildInfo } from '../../common/helpers/meta.helper';
import { ConfigService } from '../../common/services/config.service';

import { HUB_CONFIG } from './hub.constants';
import { HUB_PANEL_GROUPS, HUB_PANELS } from './hub-nav';
import { maskConfigDeep } from './helpers/hub-mask.helper';
import { CoreHubSourcesService } from './services/core-hub-sources.service';
import { HubDashboardData, HubDiagnosticsData, HubSessionData } from './interfaces/hub-panels.interface';
import { ResolvedHubConfig } from './interfaces/hub-config.interface';

/**
 * Framework-default secret field names (see CheckSecurityInterceptor). Union with the pattern-based
 * masking in {@link maskConfigDeep} and the project's `security.secretFields`.
 */
const FRAMEWORK_SECRET_FIELDS = [
  'password',
  'verificationToken',
  'passwordResetToken',
  'refreshTokens',
  'tempTokens',
  'apiKeyEncrypted',
];

const MONGO_STATES: Record<number, string> = {
  0: 'disconnected',
  1: 'connected',
  2: 'connecting',
  3: 'disconnecting',
  99: 'uninitialized',
};

/**
 * Aggregator for the Hub's own data (dashboard + diagnostics + the feature matrix). Panel-specific
 * data lives in the focused services (`CoreHubDbService`, `CoreHubMigrationsService`, …).
 *
 * Overridable via `overrides.hub.service`.
 */
@Injectable()
export class CoreHubService {
  constructor(
    @Inject(HUB_CONFIG) protected readonly config: ResolvedHubConfig,
    protected readonly configService: ConfigService,
    protected readonly sources: CoreHubSourcesService,
    @Optional() @InjectConnection() protected readonly connection?: Connection,
  ) {}

  /** Data for the dashboard panel. */
  getDashboard(): HubDashboardData {
    const mem = process.memoryUsage();
    const build = getBuildInfo({ env: this.config.env, version: this.config.version });
    const readyState = this.connection?.readyState ?? 0;

    return {
      build: { commit: build.commit, env: this.config.env, version: this.config.version },
      features: this.featureMatrix(),
      links: { ...this.config.links },
      memory: { heapTotal: mem.heapTotal, heapUsed: mem.heapUsed, rss: mem.rss },
      mongo: { readyState, state: MONGO_STATES[readyState] ?? 'unknown' },
      time: new Date().toISOString(),
      uptimeSeconds: Math.round(process.uptime()),
    };
  }

  /** Data for the diagnostics panel. `buffers` is filled once the collectors are wired (Phase 6). */
  getDiagnostics(buffers: HubDiagnosticsData['buffers'] = {}): HubDiagnosticsData {
    const mem = process.memoryUsage();
    const cpu = process.cpuUsage();

    return {
      arch: process.arch,
      buffers,
      cpuUsage: { system: cpu.system, user: cpu.user },
      env: this.config.env,
      memory: {
        arrayBuffers: mem.arrayBuffers,
        external: mem.external,
        heapTotal: mem.heapTotal,
        heapUsed: mem.heapUsed,
        rss: mem.rss,
      },
      nodeVersion: process.version,
      pid: process.pid,
      platform: process.platform,
      time: new Date().toISOString(),
      uptimeSeconds: Math.round(process.uptime()),
    };
  }

  /**
   * The full server config with all secrets masked. Deep-cloned first (never mutate the live config),
   * then masked by key heuristics + the framework/project secret-field lists.
   */
  getConfigMasked(): Record<string, unknown> {
    const raw = this.configService.configFastButReadOnly as Record<string, unknown>;
    const projectSecretFields = this.configService.get<string[]>('security.secretFields', []) ?? [];
    return maskConfigDeep(raw, [...FRAMEWORK_SECRET_FIELDS, ...projectSecretFields]);
  }

  /** The resolved Hub config (for controller/actions/gating decisions). */
  getResolvedConfig(): ResolvedHubConfig {
    return this.config;
  }

  /**
   * Cockpit-chrome data the client needs to build the navigation AFTER a successful ADMIN auth check.
   * Served ADMIN-gated via `GET /{hub}/session.json`. Because it sits behind the roles guard, the
   * public shell can carry NO nav/env/links — an unauthenticated request reveals nothing of the Hub.
   */
  getSessionPayload(): HubSessionData {
    // Availability of the optional-source panels, so the client can grey out + disable dead nav
    // entries. `mailbox` depends on config (its service is only provided when enabled); everything not
    // covered is intrinsic to the Hub and always available.
    const sourceAvailability = this.sources.getPanelAvailability();
    const isAvailable = (id: string): boolean => {
      if (id === 'mailbox') {
        return this.config.mailbox !== false;
      }
      return sourceAvailability[id] ?? true;
    };

    return {
      authenticated: true,
      env: this.config.env,
      links: { ...this.config.links },
      logoutEndpoint: this.config.logoutEndpoint,
      panelGroups: [...HUB_PANEL_GROUPS],
      panels: HUB_PANELS.map((panel) => ({
        available: isAvailable(panel.id),
        group: panel.group,
        id: panel.id,
        optional: !!panel.optional,
        path: panel.path,
        title: panel.title,
      })),
      version: this.config.version,
    };
  }

  /** Which optional framework features are active, for the dashboard feature matrix. */
  protected featureMatrix(): Record<string, boolean> {
    const has = (key: string): boolean => {
      const value = this.configService.get(key);
      if (value === undefined || value === null || value === false) {
        return false;
      }
      if (typeof value === 'object') {
        return (value as { enabled?: boolean }).enabled !== false;
      }
      return true;
    };

    return {
      ai: has('ai'),
      // Runtime check: BetterAuth can be active via BetterAuthModule.forRoot() without an obvious
      // config flag, so config-sniffing is unreliable — ask whether it is actually wired in.
      betterAuth: this.sources.isBetterAuthActive(),
      cookies: this.configService.get('cookies') !== false,
      graphQl: this.configService.get('graphQl') !== false,
      healthCheck: has('healthCheck'),
      multiTenancy: has('multiTenancy'),
      permissions: has('permissions'),
      tus: has('tus'),
    };
  }
}
