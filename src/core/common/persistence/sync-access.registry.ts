/**
 * How a change of access to synchronized records reaches the sync module (offline-sync plan §3.8) without the
 * persistence layer or the tenant module importing it: `CrudService.update()` and `CoreTenantGuard.invalidateTenant()`
 * report here, and the sync module — when it is registered — bumps the access epochs, so the clients concerned answer
 * their next pull with a full resync. Every successful write of `CrudService.create()` / `update()` / `delete()` on a
 * synchronized model reports here too, which the sync module turns into a hint (plan §3.9). Nothing is registered
 * without a `sync` configuration, and every report is then a no-op.
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

/** A successful write of a synchronized record, for the hints (plan §3.9) */
export interface SyncRecordChange {
  /** The model's registered name */
  model: string;
  /** The tenants the record was in before and after the write (none on a model without tenants) */
  tenantIds: string[];
}

export interface SyncAccessListener {
  /** A write of `CrudService.create()` / `update()` / `delete()` on a synchronized model succeeded */
  recordChanged?(change: SyncRecordChange): void;
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
