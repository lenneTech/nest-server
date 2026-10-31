# Offline Sync — Security

What the server guarantees, and what a client has to do itself. Offline sync puts a copy of the user's data on the
device, outside the server's control: the server can decide what reaches a device, but only the client can remove it
again. The protocol is in [`docs/offline-sync-protocol.md`](../../../../docs/offline-sync-protocol.md) (§11 client
duties, §12 server guarantees), the module in [README.md](./README.md).

## What the server enforces

| Guarantee                   | How                                                                                                                                                                                                                                                                                                                                                                                                                                                                             |
| --------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| No path around the rights   | Every pull and push runs through the model's `CrudService` — `process()`, `@Restricted`, `securityCheck()`, the tenant policy, row-level security on PostgreSQL — with the operation roles the model declares (`@PersistedModel({ sync: { roles } })`). There is no lean read path                                                                                                                                                                                              |
| No foreign data             | A pull never delivers a record or tombstone of another tenant or one the caller's rights hide. A push never changes one: an update or delete answers `not_found`, as for an unused id; a create on its id answers `ID_UNAVAILABLE`, the same answer for every reason, with no tenant, owner, content or deletion state. That an id is taken stays observable (protocol §3, decided O2) — ids generated as §3 requires cannot be guessed, and the push rate limit bounds probing |
| Tombstones without content  | A tombstone keeps its id, `version`, `deletedAt`, `updatedAt`, `tenantId` and the user-id scope fields the model declares — nothing a user typed                                                                                                                                                                                                                                                                                                                                |
| No hard delete              | `op: 'delete'` leaves a tombstone through the normal delete pipeline; removing data for good is the purge's alone, after the retention horizon moved past it                                                                                                                                                                                                                                                                                                                    |
| Access loss is enforced     | A changed role, a removed membership or a record moved away answers the next pull with `410 access` while the caller may still pull the model. Once they may not pull it at all (pull roles withdrawn), or `X-Tenant-Id` names a tenant they left or that was deactivated, the pull answers `403`. Either way the client must drop its copies                                                                                                                                   |
| Cookie pushes are CSRF-safe | `Content-Type: application/json` is required, and while cookies are in use a cross-site `Sec-Fetch-Site` or an untrusted `Origin` is refused (`403`)                                                                                                                                                                                                                                                                                                                            |
| Hints say nothing           | `{ model, at }` only, delivered to callers with the pull roles and access to the tenant of the change; an open stream ends when its user's rights change                                                                                                                                                                                                                                                                                                                        |
| Probing is bounded          | Per-user rate limits on pull and push; client ids carry 64 random bits (protocol §3), so the next id of a client cannot be guessed                                                                                                                                                                                                                                                                                                                                              |

## What a client must do

### On logout

The device holds personal data the server no longer controls. When the user signs out, delete:

- **every local record** of every synchronized model,
- **the cursors** (they are bound to the user; another user's pull with them answers `410 invalid`),
- **the outbox** — the unsent changes. Before signing out, tell the user that changes are still unsent and offer to
  sync first; after signing out they cannot be pushed under this account anyway,
- **the credential**: the bearer token from wherever it is stored. A cookie session ends through the server's sign-out
  route, which also clears the cookie.

In a browser that is the IndexedDB database (or the SQLite-WASM file in the OPFS) of the app; in a native or desktop
app the SQLite file. Deleting the whole database is simpler and safer than deleting rows.

### On an account switch

Exactly as on logout, before the next user's first pull. A client that kept the previous user's records would show
them to the next user until a resync — the server cannot reach into the device to prevent it.

### On `410 access`

Delete every local record of that model, keep the unsent changes, pull without a cursor, then push the kept changes
(protocol §8). The records the user may no longer see are gone afterwards — which is the point.

### On `403` on a pull

The caller may no longer pull the model at all, or not in that tenant. Treat it like `410 access` for that model (and
tenant): delete its local records and its cursor. The unsent changes cannot be pushed under this account any more —
tell the user rather than retrying.

### At rest

- A browser app authenticates with the session cookie (`httpOnly`), not with a token in `localStorage`, where any
  script injected into the page can read it.
- A native app keeps its token in the OS keychain, never in the SQLite file next to the data.
- A service worker caches the app shell only, never responses of `/sync` or `/iam` — the reference test client
  (`tests/clients/pwa/sw.js` in the framework repository) shows the split.
- Device encryption is the operating system's job; recommend it where the data is sensitive.

### Ids

Generate the ids of offline records with a secure random source (`crypto.getRandomValues`), as protocol §3 describes
— never a driver's default `new ObjectId()`, whose next value is predictable from the last one.