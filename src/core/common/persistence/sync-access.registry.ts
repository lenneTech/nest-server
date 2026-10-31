/**
 * How a change of access to synchronized records reaches the sync module (offline-sync plan §3.8) without the
 * persistence layer or the tenant module importing it: `CrudService.update()` and `CoreTenantGuard.invalidateTenant()`
 * report here, and the sync module — when it is registered — bumps the access epochs, so the clients concerned answer
 * their next pull with a full resync. Nothing is registered without a `sync` configuration, and every report is then a
 * no-op.
 *
 * Import-free leaf (types only): every caller may import it without an import cycle.
 */

/** A record whose access changed through `CrudService.update()` */
export interface SyncRecordMove {
  /** The model's registered name */
  model: string;
  /** The tenant the record was in before the write (`undefined` on a model without tenants) */
  tenantId?: string;
  /** The write moved the record to another tenant: every member of `tenantId` lost it */
  tenantChanged: boolean;
  /** Users a scope field (`sync.scope`, e.g. `ownerId`) pointed at before and no longer points at */
  usersLost: string[];
}

export interface SyncAccessListener {
  /** `CrudService.update()` moved a synchronized record away from users who could see it */
  recordMoved(move: SyncRecordMove): Promise<void>;
  /** `CoreTenantGuard.invalidateTenant()`: what the tenant's members may see may have changed */
  tenantInvalidated(tenantId: string): Promise<void>;
}

let listener: SyncAccessListener | undefined;

/** Set by the sync module when it starts, cleared when it stops */
export function setSyncAccessListener(value: SyncAccessListener | undefined): void {
  listener = value;
}

export function getSyncAccessListener(): SyncAccessListener | undefined {
  return listener;
}
