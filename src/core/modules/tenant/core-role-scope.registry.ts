import { GLOBAL_ONLY_ROLES, isSystemRole, looksLikeSystemRole } from '../../common/enums/role.enum';
import { ConfigService } from '../../common/services/config.service';
import { DEFAULT_ROLE_HIERARCHY } from './core-tenant.enums';

/**
 * Where a role's authority comes from — and therefore which source may answer it.
 *
 * This is the tenant boundary expressed as data. Roles are plain strings at runtime
 * (`RoleEnum.ADMIN` IS `'admin'`), and they arrive from three trust levels: the framework, the
 * project, and the CUSTOMER (membership roles are free text). Comparing them with `===` in one
 * shared namespace is what allowed a tenant owner to grant themselves platform authority by naming
 * their tenant role `'admin'`.
 *
 * Encoding the scope as an ATTRIBUTE rather than in the name is deliberate, and it is what makes
 * this forward-compatible with admin-managed roles stored in the database: a future
 * `DbRoleScopeSource` can feed the same registry, and every caller keeps working unchanged. A
 * naming convention (e.g. storing tenant roles as `t:owner`) would instead put the scope inside a
 * string that whoever creates the role can mistype, and would add a normalization step to every
 * comparison — inside the authorization path, which is the last place that should grow moving parts.
 */
export enum RoleScope {
  /** Authority granted by the PLATFORM. Resolved against `user.roles`, never a membership role. */
  GLOBAL = 'global',

  /** A runtime-context check (`s_*`), never a stored role and never a string comparison. */
  SYSTEM = 'system',

  /** Authority granted WITHIN one tenant. Resolved against `membership.role` in tenant context. */
  TENANT = 'tenant',

  /** Declared nowhere. Grants nothing — see {@link CoreRoleScopeRegistry.scopeOf}. */
  UNKNOWN = 'unknown',
}

/**
 * A source of role→scope knowledge.
 *
 * Implemented today by the config reader below. The interface exists so an admin-managed,
 * database-backed source can be added later without touching the guards: register it, and every
 * `scopeOf()` caller picks it up.
 */
export interface RoleScopeSource {
  /** All roles this source declares as globally scoped. */
  globalRoles(): Iterable<string>;

  /** All roles this source declares as tenant scoped. */
  tenantRoles(): Iterable<string>;
}

/**
 * Resolves the scope of a role, from one or more sources.
 *
 * **Deny by default.** A role no source declares resolves to {@link RoleScope.UNKNOWN}, and callers
 * must treat that as "grants nothing". That is the property worth having: an undeclared membership
 * role cannot accidentally line up with an undeclared required role and authorize something. The
 * previous behaviour — exact string match against whatever happened to be stored — is precisely the
 * hole this replaces.
 *
 * The registry is a plain object rather than a Nest provider on purpose: `checkRestricted()` runs
 * far outside DI (it is called from decorators and helpers), and giving it an injected dependency
 * would put a container lookup in the field-level authorization path.
 */
export class CoreRoleScopeRegistry {
  private readonly sources: RoleScopeSource[] = [];

  /** Drop all registered sources. Used by tests and by config reloads. */
  clear(): void {
    this.sources.length = 0;
  }

  /**
   * Roles that are declared in BOTH scopes — a contradiction that must fail the boot.
   *
   * Such a role would have to be resolved against `user.roles` and `membership.role` at the same
   * time. Whichever way it were decided, one of the two declarations would silently not hold.
   */
  conflicts(): string[] {
    const global = this.collect((source) => source.globalRoles());
    const tenant = this.collect((source) => source.tenantRoles());
    return [...global].filter((role) => tenant.has(role)).sort();
  }

  /** Is this role declared as tenant-scoped by any source? */
  isTenantRole(role: string): boolean {
    return this.scopeOf(role) === RoleScope.TENANT;
  }

  /** Register a source. Later sources add to, never replace, earlier ones. */
  register(source: RoleScopeSource): void {
    this.sources.push(source);
  }

  /**
   * Scope of a single role.
   *
   * Order matters: system roles first (they are never stored and never string-compared), then
   * global (so a project cannot demote a framework role by declaring it per tenant), then tenant.
   */
  scopeOf(role: string): RoleScope {
    if (typeof role !== 'string') {
      return RoleScope.UNKNOWN;
    }
    if (isSystemRole(role) || looksLikeSystemRole(role)) {
      return RoleScope.SYSTEM;
    }
    if (GLOBAL_ONLY_ROLES.includes(role) || this.collect((source) => source.globalRoles()).has(role)) {
      return RoleScope.GLOBAL;
    }
    if (this.collect((source) => source.tenantRoles()).has(role)) {
      return RoleScope.TENANT;
    }
    return RoleScope.UNKNOWN;
  }

  /**
   * Is any source able to answer tenant-scope questions at all?
   *
   * Lets callers distinguish "declared as NOT a tenant role" from "nothing is declared yet", which
   * are very different answers when deciding whether to deny.
   */
  hasTenantKnowledge(): boolean {
    return this.collect((source) => source.tenantRoles()).size > 0;
  }

  /**
   * Split required roles by the source entitled to answer them.
   *
   * `unknown` is returned separately rather than folded into either half, so callers can decide
   * explicitly. The guards treat it as "grants nothing via tenant membership" but still resolve it
   * against `user.roles` — that keeps a project which never configured `multiTenancy` working
   * exactly as before, while ensuring a membership role can never be the thing that satisfies it.
   */
  split(requiredRoles: string[]): { global: string[]; system: string[]; tenant: string[]; unknown: string[] } {
    const result = { global: [] as string[], system: [] as string[], tenant: [] as string[], unknown: [] as string[] };
    for (const role of requiredRoles ?? []) {
      switch (this.scopeOf(role)) {
        case RoleScope.GLOBAL:
          result.global.push(role);
          break;
        case RoleScope.SYSTEM:
          result.system.push(role);
          break;
        case RoleScope.TENANT:
          result.tenant.push(role);
          break;
        default:
          result.unknown.push(role);
      }
    }
    return result;
  }

  /**
   * The `multiTenancy` config, read fresh on every lookup and ALWAYS consulted.
   *
   * Built in rather than registered, because a registered source only exists after
   * `CoreTenantModule.forRoot()` has run — and the guards can be constructed before that (test
   * fixtures, standalone usage). A registry that silently knows nothing is worse than no registry:
   * `globalOnlyRoles` would be ignored and the roles it protects would fall back to being
   * tenant-satisfiable, which is precisely the escalation this exists to prevent.
   */
  private configSource(): RoleScopeSource {
    return {
      globalRoles: () => ConfigService.configFastButReadOnly?.multiTenancy?.globalOnlyRoles ?? [],
      tenantRoles: () => {
        const config = ConfigService.configFastButReadOnly?.multiTenancy;
        return [
          ...Object.keys(config?.roleHierarchy ?? DEFAULT_ROLE_HIERARCHY),
          ...(config?.additionalMembershipRoles ?? []),
        ];
      },
    };
  }

  private collect(pick: (source: RoleScopeSource) => Iterable<string>): Set<string> {
    const collected = new Set<string>();
    for (const source of [this.configSource(), ...this.sources]) {
      for (const role of pick(source) ?? []) {
        if (typeof role === 'string' && role.length) {
          collected.add(role);
        }
      }
    }
    return collected;
  }
}

/**
 * The process-wide registry.
 *
 * Module-level singleton in an import-free-ish leaf for the same reason the DI tokens live in
 * leaves: it is read from `checkRestricted()`, which sits on the field-level authorization path and
 * must not depend on the Nest container being available.
 */
export const roleScopeRegistry = new CoreRoleScopeRegistry();
