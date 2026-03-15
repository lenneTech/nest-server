import { AsyncLocalStorage } from 'async_hooks';

export interface IRequestContext {
  currentUser?: {
    id: string;
    hasRole?: (roles: string[]) => boolean;
    roles?: string[];
  };
  language?: string;
  /** When true, mongooseRoleGuardPlugin allows role changes regardless of user permissions */
  bypassRoleGuard?: boolean;
  /** When true, mongooseTenantPlugin skips tenant filtering */
  bypassTenantGuard?: boolean;
  /** Validated tenant ID (set by CoreTenantGuard after membership validation, not raw header) */
  tenantId?: string;
  /** Tenant IDs from user's active tenant memberships (used when no specific header is set) */
  tenantIds?: string[];
  /** Tenant role of the current user in the active tenant */
  tenantRole?: string;
  /** When true, indicates admin bypass is active (admin without header sees all data) */
  isAdminBypass?: boolean;
}

/**
 * Request-scoped context using AsyncLocalStorage.
 * Provides access to the current user in Mongoose hooks and other
 * places where NestJS request scope is not available.
 */
export class RequestContext {
  private static storage = new AsyncLocalStorage<IRequestContext>();

  static run<T>(context: IRequestContext, fn: () => T): T {
    return this.storage.run(context, fn);
  }

  static get(): IRequestContext | undefined {
    return this.storage.getStore();
  }

  static getCurrentUser(): IRequestContext['currentUser'] | undefined {
    return this.storage.getStore()?.currentUser;
  }

  static getLanguage(): string | undefined {
    return this.storage.getStore()?.language;
  }

  /**
   * Check if the role guard bypass is active for the current context.
   */
  static isBypassRoleGuard(): boolean {
    return this.storage.getStore()?.bypassRoleGuard === true;
  }

  /**
   * Run a function with the role guard bypass enabled.
   * The current context (user, language) is preserved; only bypassRoleGuard is added.
   *
   * Use this when authorized code needs to set roles on users, e.g.:
   * - signUp with default roles
   * - Admin panel where a non-admin role (e.g. HR_MANAGER) creates users with roles
   * - System setup creating initial admin
   *
   * @example
   * ```typescript
   * await RequestContext.runWithBypassRoleGuard(async () => {
   *   await this.mainDbModel.findByIdAndUpdate(userId, { roles: ['EMPLOYEE'] });
   * });
   * ```
   */
  static runWithBypassRoleGuard<T>(fn: () => T): T {
    const currentStore = this.storage.getStore();
    const context: IRequestContext = {
      ...currentStore,
      bypassRoleGuard: true,
    };
    return this.storage.run(context, fn);
  }

  static getTenantId(): string | undefined {
    return this.storage.getStore()?.tenantId;
  }

  static isBypassTenantGuard(): boolean {
    return this.storage.getStore()?.bypassTenantGuard === true;
  }

  /**
   * Run a function with tenant guard bypass enabled.
   * The current context is preserved; only bypassTenantGuard is added.
   *
   * Use this for cross-tenant operations, e.g.:
   * - Admin dashboards viewing all tenants
   * - Cron jobs processing data across tenants
   * - Migration scripts
   *
   * @example
   * ```typescript
   * const allOrders = await RequestContext.runWithBypassTenantGuard(async () => {
   *   return this.orderService.find();
   * });
   * ```
   */
  static runWithBypassTenantGuard<T>(fn: () => T): T {
    const currentStore = this.storage.getStore();
    const context: IRequestContext = {
      ...currentStore,
      bypassTenantGuard: true,
    };
    return this.storage.run(context, fn);
  }
}
