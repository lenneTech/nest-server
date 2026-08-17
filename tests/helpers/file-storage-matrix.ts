/**
 * THE FILE-STORAGE PARITY MATRIX — one declaration of what file storage must do, and of the
 * cells where a driver genuinely cannot do it.
 *
 * WHY THIS EXISTS
 * ---------------
 * `@lenne.tech/nest-server` ships three storage drivers (`filesystem`, `gridfs`, `s3`) behind ONE
 * service contract, and until now each had its OWN spec file: `filesystem-storage`,
 * `file-storage-driver`, `file-storage-s3`, plus the app-level `file` suite. Different files,
 * different drivers, overlapping intent, no shared list of behaviours. A behaviour that was correct
 * under GridFS and broken under `filesystem` therefore had nowhere to show up — which is not a
 * hypothetical: 11.33.0 shipped `getRawFileInfoByName()` consulting the S3 and GridFS stores but
 * NOT the filesystem one, so a by-name ownership rule authorized against a different file set than
 * the download route served. Every suite was green.
 *
 * The fix for the bug is one line. The fix for the BUG CLASS is this file: a single matrix of
 * behaviours, executed against every driver, so "works under one driver" can never again be
 * mistaken for "works".
 *
 * THE THREE STATES A CELL CAN BE IN — and why they must look different
 * -------------------------------------------------------------------
 * Omitting a case for a driver and declaring it impossible for that driver produce the same thing
 * in a test report: nothing. That is exactly how a gap hides. So a (case, driver) cell is in one of
 * three declared states, and `tests/unit/file-storage-parity-matrix.spec.ts` fails the build on
 * anything else:
 *
 *   EXECUTED     — the case lists the driver. The e2e executor registers a real `it()`.
 *   IMPOSSIBLE   — an exclusion whose reason starts with `IMPOSSIBLE:`. The behaviour cannot exist
 *                  for that store at all (no equivalent primitive). Nothing is registered.
 *   BY DESIGN    — an exclusion whose reason starts with `DIFFERENT-BY-DESIGN:`. The driver
 *                  behaves differently ON PURPOSE, so the cell MUST name a `provenBy` case that
 *                  asserts the complementary behaviour positively, and the executor registers that
 *                  complement via `parityComplement()`. A design difference nobody asserts is
 *                  indistinguishable from a bug nobody noticed.
 *
 * An UNDECLARED cell — a case that simply forgets a driver — is none of the three and fails the
 * guard. That is the whole point.
 *
 * WHAT THE EXECUTORS ARE
 * ----------------------
 * Two, because the contract has two surfaces and they fail differently:
 *
 *   `tests/file-storage-parity.e2e-spec.ts`      — the SERVICE contract (`CoreFileService`),
 *                                                  driven directly, three drivers, no HTTP.
 *   `tests/file-storage-http-parity.e2e-spec.ts` — the ROUTE contract (`CoreFileController` via
 *                                                  the real `ServerModule`), three drivers, real
 *                                                  requests, real role gate, real `checkRights()`.
 *
 * They are separate FILES so vitest can run them in parallel (the HTTP one boots a Nest app per
 * driver), and they read from this one matrix so they cannot drift apart.
 */
import { expect, it } from 'vitest';

/** The three storage drivers, exactly as `file.storage` accepts them. */
export type ParityDriver = 'filesystem' | 'gridfs' | 's3';

export const PARITY_DRIVERS: readonly ParityDriver[] = ['filesystem', 'gridfs', 's3'] as const;

/** Which surface a case is executed against. */
export type ParityLayer = 'http' | 'service';

export interface ParityCase {
  /** Stable id, referenced by exclusions, by the folded-in map and by the completeness guard. */
  id: string;
  /** Which executor registers it. */
  layer: ParityLayer;
  /** Drivers this case is EXECUTED for. Every driver not listed needs an exclusion entry. */
  drivers: readonly ParityDriver[];
  /** The `it()` title. Kept here so the two executors cannot describe the same case differently. */
  title: string;
}

export interface ParityExclusion {
  /** {@link ParityCase.id} this exclusion applies to. */
  case: string;
  driver: ParityDriver;
  /**
   * Must start with `IMPOSSIBLE:` or `DIFFERENT-BY-DESIGN:` — see the docblock above. The prefix is
   * not decoration: it decides whether a complementary assertion is REQUIRED.
   */
  reason: string;
  /**
   * Case id that asserts the complementary behaviour. Required for `DIFFERENT-BY-DESIGN:`,
   * forbidden for `IMPOSSIBLE:` (there is nothing to assert instead).
   */
  provenBy?: string;
}

/**
 * The matrix.
 *
 * Adding a driver means adding it to {@link PARITY_DRIVERS}; every case then either lists it or
 * needs an exclusion, and the guard says which ones are missing. That is deliberate — a new driver
 * should be loud, not quietly half-covered.
 */
export const PARITY_CASES: readonly ParityCase[] = [
  // -------------------------------------------------------------------------------------------
  // Service layer — the contract every project's FileService inherits.
  // -------------------------------------------------------------------------------------------
  {
    drivers: PARITY_DRIVERS,
    id: 'service.driverResolution',
    layer: 'service',
    title: 'resolves the configured driver and reports it as explicit',
  },
  {
    drivers: PARITY_DRIVERS,
    id: 'service.writesToActiveStoreOnly',
    layer: 'service',
    title: 'writes new bytes to the active store and to no other',
  },
  {
    drivers: PARITY_DRIVERS,
    id: 'service.readByIdRoundTrip',
    layer: 'service',
    title: 'reads a file back by id — info, buffer and stream agree',
  },
  {
    drivers: PARITY_DRIVERS,
    id: 'service.readByNameRoundTrip',
    layer: 'service',
    title: 'reads a file back by name — info, buffer and stream agree',
  },
  {
    drivers: PARITY_DRIVERS,
    id: 'service.byNameAuthorizesWhatItServes',
    layer: 'service',
    title: 'by-name reads authorize and serve the SAME document when a filename is reused',
  },
  {
    drivers: PARITY_DRIVERS,
    id: 'service.metadataRoundTrip',
    layer: 'service',
    title: 'round-trips custom metadata into BOTH raw lookups (by id and by name)',
  },
  {
    drivers: PARITY_DRIVERS,
    id: 'service.deleteById',
    layer: 'service',
    title: 'deletes by id — bytes and bookkeeping both gone',
  },
  {
    drivers: PARITY_DRIVERS,
    id: 'service.deleteByName',
    layer: 'service',
    title: 'deletes by name — bytes and bookkeeping both gone',
  },
  {
    drivers: PARITY_DRIVERS,
    id: 'service.deleteByNameForwardsContext',
    layer: 'service',
    title: 'deleteFileByName forwards the caller context to its inner lookup',
  },
  {
    drivers: PARITY_DRIVERS,
    id: 'service.checkRightsRefusalIsUniform',
    layer: 'service',
    title: 'a refused read answers like a missing file on every read path',
  },
  {
    drivers: PARITY_DRIVERS,
    id: 'service.writeRefusalWritesNothing',
    layer: 'service',
    title: 'a refused upload writes no bytes and no bookkeeping',
  },
  {
    drivers: PARITY_DRIVERS,
    id: 'service.findFilterByName',
    layer: 'service',
    title: 'findFileInfo filters on a whole filename value',
  },
  {
    drivers: PARITY_DRIVERS,
    id: 'service.findSorts',
    layer: 'service',
    title: 'findFileInfo honours a sort spec across the WHOLE result, not per store',
  },
  {
    drivers: PARITY_DRIVERS,
    id: 'service.findPages',
    layer: 'service',
    title: 'findFileInfo pages without duplicating or dropping rows',
  },
  {
    drivers: PARITY_DRIVERS,
    id: 'service.crossDriverRead',
    layer: 'service',
    title: 'files written under either OTHER driver stay readable by id and by name',
  },
  {
    drivers: PARITY_DRIVERS,
    id: 'service.crossDriverDelete',
    layer: 'service',
    title: 'deletes a file that lives in another store',
  },
  {
    // GridFS excluded — see PARITY_EXCLUSIONS.
    drivers: ['filesystem', 's3'],
    id: 'service.findMergesOtherStores',
    layer: 'service',
    title: 'findFileInfo merges rows from the other stores into one page',
  },
  {
    drivers: PARITY_DRIVERS,
    id: 'service.downloadUrlWithoutPresigning',
    layer: 'service',
    title: 'getDownloadUrl answers undefined (never throws) while presigned downloads are off',
  },

  // -------------------------------------------------------------------------------------------
  // HTTP layer — the two inherited download routes, through the real app.
  // -------------------------------------------------------------------------------------------
  {
    drivers: PARITY_DRIVERS,
    id: 'http.ownerDownloadsById',
    layer: 'http',
    title: 'GET /files/id/:id serves the owner their own bytes',
  },
  {
    drivers: PARITY_DRIVERS,
    id: 'http.ownerDownloadsByName',
    layer: 'http',
    title: 'GET /files/:filename serves the owner their own bytes',
  },
  {
    drivers: PARITY_DRIVERS,
    id: 'http.deliveryHeaders',
    layer: 'http',
    title: 'delivers identical Content-Type / Content-Disposition / Cache-Control headers',
  },
  {
    drivers: PARITY_DRIVERS,
    id: 'http.nonOwnerGets404LikeUnknownId',
    layer: 'http',
    title: 'refuses a non-owner by id with a 404 byte-identical to an unknown id',
  },
  {
    drivers: PARITY_DRIVERS,
    id: 'http.nonOwnerGets404LikeUnknownName',
    layer: 'http',
    title: 'refuses a non-owner by name with a 404 byte-identical to an unknown filename',
  },
  {
    drivers: PARITY_DRIVERS,
    id: 'http.anonymousGets401',
    layer: 'http',
    title: 'refuses an anonymous caller with 401 on both routes',
  },
  {
    drivers: PARITY_DRIVERS,
    id: 'http.adminDownloads',
    layer: 'http',
    title: 'lets ADMIN through on both routes',
  },
  {
    drivers: PARITY_DRIVERS,
    id: 'http.crossDriverDownload',
    layer: 'http',
    title: 'downloads a file written under another driver, by id and by name',
  },
] as const;

/**
 * The cells that are NOT executed, and why.
 *
 * Keep this list short and specific. An exclusion is a claim about the PRODUCT, not a way to make a
 * failing test go away — if you find yourself adding one to get green, you are writing down a bug.
 */
export const PARITY_EXCLUSIONS: readonly ParityExclusion[] = [
  {
    case: 'service.findMergesOtherStores',
    driver: 'gridfs',
    provenBy: 'service.crossDriverRead',
    reason:
      'DIFFERENT-BY-DESIGN: with `file.storage: \'gridfs\'` findFileInfo takes the single-store fast '
      + 'path — nothing was ever written to the other stores BY THIS CONFIGURATION, so it queries GridFS '
      + 'alone and stays exact (no over-fetch, no merge). Rows in the other stores therefore do not '
      + 'appear in a LISTING, while remaining fully readable by id and by name. The complement is '
      + 'asserted by parityComplement() in the service executor.',
  },
] as const;

/**
 * Cases folded in from the suites this matrix replaced — the receipt that consolidating did not
 * quietly drop coverage.
 *
 * `tests/unit/file-storage-parity-matrix.spec.ts` asserts every `into` here names a real case id,
 * so deleting a case without re-homing its origin fails the build.
 */
export const FOLDED_IN: readonly { from: string; into: string; was: string }[] = [
  // tests/file-storage-driver.e2e-spec.ts (filesystem dispatch, service level)
  { from: 'file-storage-driver', into: 'service.driverResolution', was: 'resolves the configured driver instead of defaulting to GridFS' },
  { from: 'file-storage-driver', into: 'service.writesToActiveStoreOnly', was: 'writes new files to the filesystem, not to GridFS' },
  { from: 'file-storage-driver', into: 'service.readByIdRoundTrip', was: 'round-trips content through the service' },
  { from: 'file-storage-driver', into: 'service.readByNameRoundTrip', was: 'round-trips content through the service (by-name half)' },
  { from: 'file-storage-driver', into: 'service.metadataRoundTrip', was: 'carries custom metadata through, so a per-file rule has something to read' },
  { from: 'file-storage-driver', into: 'service.crossDriverRead', was: 'still reads files written under a PREVIOUS driver' },
  { from: 'file-storage-driver', into: 'service.crossDriverDelete', was: 'still reads files written under a PREVIOUS driver (delete half)' },
  { from: 'file-storage-driver', into: 'service.deleteById', was: 'deletes from the filesystem store' },
  { from: 'file-storage-driver', into: 'service.findMergesOtherStores', was: 'merges both stores in findFileInfo' },
  // tests/file-storage-s3.e2e-spec.ts (s3 dispatch, service level)
  { from: 'file-storage-s3', into: 'service.driverResolution', was: 'resolves the S3 driver and boots without falling back' },
  { from: 'file-storage-s3', into: 'service.writesToActiveStoreOnly', was: 'writes new files to S3, not to GridFS' },
  { from: 'file-storage-s3', into: 'service.readByIdRoundTrip', was: 'round-trips content through the service' },
  { from: 'file-storage-s3', into: 'service.readByNameRoundTrip', was: 'round-trips content through the service (by-name half)' },
  { from: 'file-storage-s3', into: 'service.metadataRoundTrip', was: 'carries custom metadata through, so a per-file rule has something to read' },
  { from: 'file-storage-s3', into: 'service.crossDriverRead', was: 'still reads files written under a PREVIOUS driver' },
  { from: 'file-storage-s3', into: 'service.crossDriverDelete', was: 'still reads files written under a PREVIOUS driver (delete half)' },
  { from: 'file-storage-s3', into: 'service.deleteById', was: 'deletes both the object and its metadata' },
  { from: 'file-storage-s3', into: 'service.findMergesOtherStores', was: 'merges both stores in findFileInfo' },
] as const;

// =====================================================================================================================
//  Lookup + registration helpers, shared by both executors
// =====================================================================================================================

export function getParityCase(id: string): ParityCase {
  const found = PARITY_CASES.find(entry => entry.id === id);
  if (!found) {
    throw new Error(`Unknown parity case '${id}'. Declare it in tests/helpers/file-storage-matrix.ts.`);
  }
  return found;
}

export function getParityExclusion(id: string, driver: ParityDriver): ParityExclusion | undefined {
  return PARITY_EXCLUSIONS.find(entry => entry.case === id && entry.driver === driver);
}

/**
 * Register an executed cell.
 *
 * Refuses to register a case for a driver the matrix does not list — otherwise a copy-paste would
 * silently add coverage the guard does not know about, and the matrix would stop being the
 * description of what runs.
 */
export function parityIt(id: string, driver: ParityDriver, body: () => Promise<void> | void): void {
  const spec = getParityCase(id);
  if (!spec.drivers.includes(driver)) {
    const exclusion = getParityExclusion(id, driver);
    throw new Error(
      `Parity case '${id}' is not declared for driver '${driver}'`
      + `${exclusion ? ` (excluded: ${exclusion.reason})` : ''}. `
      + 'Either add the driver to the case, or register the complement with parityComplement().',
    );
  }
  it(spec.title, body);
}

/**
 * Register the COMPLEMENT of a `DIFFERENT-BY-DESIGN:` exclusion.
 *
 * The excluded behaviour is replaced by a positive assertion of what the driver does instead, so
 * the difference is pinned rather than merely asserted in prose. Refuses to register when the cell
 * is not actually excluded, or when it is excluded as `IMPOSSIBLE:` — an impossible cell has no
 * complement to assert, and pretending otherwise is how a vacuous test is born.
 */
export function parityComplement(id: string, driver: ParityDriver, body: () => Promise<void> | void): void {
  const exclusion = getParityExclusion(id, driver);
  if (!exclusion) {
    throw new Error(`Parity case '${id}' is not excluded for driver '${driver}' — use parityIt().`);
  }
  if (!exclusion.reason.startsWith('DIFFERENT-BY-DESIGN:')) {
    throw new Error(
      `Parity case '${id}' is excluded for driver '${driver}' as IMPOSSIBLE — there is nothing to assert instead.`,
    );
  }
  const spec = getParityCase(id);
  it(`instead of "${spec.title}": ${exclusion.reason.replace('DIFFERENT-BY-DESIGN: ', '')}`, body);
}

/**
 * Fail loudly, with the exact command to fix it, when infrastructure a driver NEEDS is missing.
 *
 * Never skip. A silently skipped storage test is how an untested driver ships — the same reasoning
 * `.claude/rules/testing.md` applies to the Redis/S3 suites, restated here because this matrix is
 * the one place where "one driver could not run today" would be least visible.
 */
export function failMissingInfrastructure(driver: ParityDriver, error: unknown): never {
  const detail = error instanceof Error ? error.message : String(error);
  throw new Error(
    `The file-storage parity matrix could not run against the '${driver}' driver: ${detail}\n`
      + 'Start the test infrastructure with `pnpm run test:infra` (Redis 6380 + RustFS 9102).',
    { cause: error },
  );
}

/**
 * Assert a filename appears EXACTLY once in a listing.
 *
 * Its own helper because "appears" and "appears once" are different properties and the merge path
 * gets the second one wrong in a way containment cannot see: applying `limit`/`skip` per store and
 * concatenating returns rows twice AND drops others, so a `toContain()` passes on a broken page.
 */
export function expectExactlyOnce(names: string[], filename: string): void {
  expect(names.filter(name => name === filename), `${filename} in ${JSON.stringify(names)}`).toHaveLength(1);
}
