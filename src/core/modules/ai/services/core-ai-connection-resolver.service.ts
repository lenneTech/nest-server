import { ForbiddenException, Injectable, Logger, NotFoundException, Optional } from '@nestjs/common';

import { ResolvedAiConnection } from '../interfaces/resolved-ai-connection.interface';
import { CoreAiAvailableConnection } from '../models/core-ai-available-connection.model';
import { CoreAiConnectionPreference } from '../models/core-ai-connection-preference.model';
import { CoreAiConnectionPreferenceService } from './core-ai-connection-preference.service';
import { CoreAiConnectionService } from './core-ai-connection.service';

/**
 * Lightweight connection shape used during resolution (no secrets). `model` and
 * `name` are display-only and not used by the resolution logic itself.
 */
export interface AiResolvableConnection {
  enforced?: boolean;
  enforcedTenantIds?: string[];
  id: string;
  isDefault?: boolean;
  model?: string;
  name?: string;
  tenantIds?: string[];
}

/**
 * Inputs for resolving which connection to use for a prompt.
 */
export interface AiConnectionResolveContext {
  /** Connection explicitly pinned by a module/service/function (highest priority). */
  codeOverride?: string;
  /** Connection requested by the client (`input.connectionId`). */
  requested?: string;
  /** Current tenant id (multi-tenancy), if any. */
  tenantId?: string;
  /** Current user id, if any. */
  userId?: string;
}

/**
 * Resolves WHICH database connection a prompt uses, via a prioritized, fully
 * overridable chain. Connections live in the DB and can be restricted per tenant
 * (`tenantIds`). If there are no usable connections, AI handling is effectively
 * disabled (resolution returns `undefined`). If nothing is explicitly selected,
 * the first available connection is used (so exactly one connection is the
 * implicit default, and multiple connections never produce a dead state).
 *
 * Resolution order (ascending priority — a later layer overrides an earlier one).
 * "Soft" layers (1–4) must pick a connection from the tenant's available set;
 * "hard"/mandatory layers (5–8) are authoritative and win regardless:
 *
 * 1. Global default (`isDefault`)
 * 2. Tenant default (preference, not enforced)
 * 3. User default (preference)
 * 4. Client request (`requested`)
 * 5. Tenant-enforced (preference, enforced)
 * 6. Admin-enforced global (`enforced`)
 * 7. Admin-enforced for tenant (`enforcedTenantIds`)
 * 8. Explicit code override (`codeOverride`) — deliberate, trusted; document that it
 *    bypasses mandates (projects that need mandates to be absolute can reorder).
 *
 * Each layer is an overridable `protected` method, and the whole chain
 * ({@link resolutionLayers}) can be reordered/extended/replaced. Pass a custom
 * subclass via `CoreModule.forRoot(env, { ai: { connectionResolver } })`.
 */
@Injectable()
export class CoreAiConnectionResolverService {
  protected readonly logger = new Logger(CoreAiConnectionResolverService.name);

  /** Per-resolution memo for the tenant preference (one DB read per `ctx`). */
  private readonly tenantPrefCache = new WeakMap<
    AiConnectionResolveContext,
    Promise<{ connectionId: string; enforced?: boolean } | null>
  >();

  constructor(
    protected readonly connectionService: CoreAiConnectionService,
    @Optional() protected readonly preferenceService?: CoreAiConnectionPreferenceService,
  ) {}

  /**
   * Resolve and load the connection to use (with decrypted key), or `undefined`
   * when AI is effectively disabled (no usable connection).
   */
  async resolveConnection(ctx: AiConnectionResolveContext): Promise<ResolvedAiConnection | undefined> {
    const id = await this.resolveConnectionId(ctx);
    return id ? this.connectionService.resolve(id) : undefined;
  }

  /**
   * Resolve the connection id via the prioritized chain.
   */
  async resolveConnectionId(ctx: AiConnectionResolveContext): Promise<string | undefined> {
    const connections = await this.connectionService.listUsable();
    return (await this.resolveFrom(connections, ctx)).selected;
  }

  /**
   * List the connections available to the caller (non-sensitive), marking the
   * currently resolved one (`selected`) and whether the selection is locked by a
   * mandatory layer. Empty when AI handling is disabled (no usable connections).
   */
  async listAvailable(ctx: AiConnectionResolveContext): Promise<CoreAiAvailableConnection[]> {
    const connections = await this.connectionService.listUsable();
    if (!connections.length) {
      return [];
    }
    const available = this.availableConnections(connections, ctx.tenantId);
    const { locked, selected } = await this.resolveFrom(connections, ctx);
    return available.map((c) => {
      const item = new CoreAiAvailableConnection();
      item.id = c.id;
      item.isDefault = !!c.isDefault;
      item.locked = locked;
      item.model = c.model;
      item.name = c.name;
      item.selected = c.id === selected;
      return item;
    });
  }

  /**
   * Set the caller's own user-default connection. Validates that the connection is
   * available to the caller's tenant before storing the preference. Throws when no
   * preference service is wired or the connection is not available.
   */
  async setUserConnection(userId: string, connectionId: string, tenantId?: string): Promise<void> {
    if (!this.preferenceService) {
      throw new ForbiddenException('AI connection preferences are not available');
    }
    const connections = await this.connectionService.listUsable();
    const available = this.availableConnections(connections, tenantId);
    if (!available.some((c) => c.id === connectionId)) {
      throw new ForbiddenException('The selected AI connection is not available');
    }
    await this.preferenceService.upsertPreference('user', userId, connectionId);
  }

  /**
   * Set a tenant/user connection preference (admin self-service). Validates that the
   * connection exists and is usable before persisting, so an admin gets immediate
   * feedback instead of creating a dangling preference. Returns the stored preference.
   */
  async setPreference(
    scope: 'tenant' | 'user',
    refId: string,
    connectionId: string,
    enforced = false,
  ): Promise<CoreAiConnectionPreference> {
    if (!this.preferenceService) {
      throw new ForbiddenException('AI connection preferences are not available');
    }
    await this.assertConnectionUsable(connectionId);
    return this.preferenceService.upsertPreference(scope, refId, connectionId, enforced);
  }

  /**
   * Throw {@link NotFoundException} when the connection id does not exist or is disabled.
   */
  protected async assertConnectionUsable(connectionId: string): Promise<void> {
    const connections = await this.connectionService.listUsable();
    if (!connections.some((c) => c.id === connectionId)) {
      throw new NotFoundException(`AI connection "${connectionId}" does not exist or is not usable`);
    }
  }

  /**
   * Run the resolution chain against a pre-fetched connection list, returning the
   * selected id and whether the selection came from a mandatory (hard) layer.
   */
  protected async resolveFrom(
    connections: AiResolvableConnection[],
    ctx: AiConnectionResolveContext,
  ): Promise<{ locked: boolean; selected?: string }> {
    if (!connections.length) {
      return { locked: false }; // no connections → AI disabled
    }
    const available = this.availableConnections(connections, ctx.tenantId);
    const availableIds = new Set(available.map((c) => c.id));
    const allIds = new Set(connections.map((c) => c.id));

    let locked = false;
    let selected: string | undefined;
    for (const layer of this.resolutionLayers()) {
      const candidate = await layer.resolve(connections, available, ctx);
      if (!candidate) {
        continue;
      }
      // Soft layers may only pick a connection available to the tenant.
      if (layer.soft && !availableIds.has(candidate)) {
        continue;
      }
      selected = candidate;
      // A mandatory (hard) layer dictates the selection — the user cannot override it.
      locked = !layer.soft;
    }

    // Robustness: hard layers (enforced preferences, code override) and externally
    // sourced ids are not pre-filtered by availability, so they can point to a
    // connection that no longer exists or has been disabled. Drop such a stale
    // reference and degrade gracefully instead of returning a dead id that would make
    // `connectionService.resolve()` throw mid-prompt.
    if (selected && !allIds.has(selected)) {
      this.logger.warn(
        `AI connection "${selected}" selected by the resolution chain no longer exists or is disabled; falling back.`,
      );
      locked = false;
      selected = undefined;
    }

    // Nothing explicitly selected → fall back to the first available connection.
    // This covers the "exactly one connection = implicit default" rule and avoids a
    // dead state when multiple connections exist without a default/preference/selection.
    if (!selected && available.length) {
      selected = available[0].id;
    }
    return { locked, selected };
  }

  /**
   * The ordered resolution layers (ascending priority). Override to reorder,
   * extend or replace the chain.
   */
  protected resolutionLayers(): {
    resolve: (
      all: AiResolvableConnection[],
      available: AiResolvableConnection[],
      ctx: AiConnectionResolveContext,
    ) => Promise<string | undefined> | string | undefined;
    soft: boolean;
  }[] {
    return [
      { resolve: (_all, available) => this.globalDefault(available), soft: true },
      { resolve: (_all, _available, ctx) => this.tenantDefault(ctx), soft: true },
      { resolve: (_all, _available, ctx) => this.userDefault(ctx), soft: true },
      { resolve: (_all, _available, ctx) => this.clientSelection(ctx), soft: true },
      { resolve: (_all, _available, ctx) => this.tenantEnforced(ctx), soft: false },
      { resolve: (all) => this.adminEnforcedGlobal(all), soft: false },
      { resolve: (all, _available, ctx) => this.adminEnforcedForTenant(all, ctx), soft: false },
      { resolve: (_all, _available, ctx) => this.codeOverride(ctx), soft: false },
    ];
  }

  // ===================================================================================================================
  // Layers (overridable)
  // ===================================================================================================================

  /** Connections available to the tenant (empty `tenantIds` = available to all). */
  protected availableConnections(connections: AiResolvableConnection[], tenantId?: string): AiResolvableConnection[] {
    return connections.filter((c) => !c.tenantIds?.length || (tenantId ? c.tenantIds.includes(tenantId) : false));
  }

  protected globalDefault(available: AiResolvableConnection[]): string | undefined {
    return available.find((c) => c.isDefault)?.id;
  }

  protected async tenantDefault(ctx: AiConnectionResolveContext): Promise<string | undefined> {
    const pref = await this.loadTenantPreference(ctx);
    return pref && !pref.enforced ? pref.connectionId : undefined;
  }

  protected async userDefault(ctx: AiConnectionResolveContext): Promise<string | undefined> {
    if (!ctx.userId || !this.preferenceService) {
      return undefined;
    }
    return (await this.preferenceService.getPreference('user', ctx.userId))?.connectionId;
  }

  protected clientSelection(ctx: AiConnectionResolveContext): string | undefined {
    return ctx.requested;
  }

  protected async tenantEnforced(ctx: AiConnectionResolveContext): Promise<string | undefined> {
    const pref = await this.loadTenantPreference(ctx);
    return pref?.enforced ? pref.connectionId : undefined;
  }

  /**
   * Load the tenant preference once per resolution (`tenantDefault` + `tenantEnforced`
   * both need it). Memoized on the `ctx` object so a single prompt triggers one DB read.
   */
  protected loadTenantPreference(
    ctx: AiConnectionResolveContext,
  ): Promise<{ connectionId: string; enforced?: boolean } | null> {
    if (!ctx.tenantId || !this.preferenceService) {
      return Promise.resolve(null);
    }
    let cached = this.tenantPrefCache.get(ctx);
    if (!cached) {
      cached = this.preferenceService.getPreference('tenant', ctx.tenantId);
      this.tenantPrefCache.set(ctx, cached);
    }
    return cached;
  }

  protected adminEnforcedGlobal(all: AiResolvableConnection[]): string | undefined {
    return all.find((c) => c.enforced)?.id;
  }

  protected adminEnforcedForTenant(all: AiResolvableConnection[], ctx: AiConnectionResolveContext): string | undefined {
    if (!ctx.tenantId) {
      return undefined;
    }
    return all.find((c) => c.enforcedTenantIds?.includes(ctx.tenantId as string))?.id;
  }

  protected codeOverride(ctx: AiConnectionResolveContext): string | undefined {
    return ctx.codeOverride;
  }
}
