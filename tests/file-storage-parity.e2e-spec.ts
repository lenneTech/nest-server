/**
 * FILE-STORAGE PARITY — the SERVICE contract, executed against all three drivers.
 *
 * The matrix itself (what must hold, and which cells are declared impossible or different by
 * design) lives in `tests/helpers/file-storage-matrix.ts`; the per-driver plumbing in
 * `tests/helpers/file-storage-drivers.ts`. This file is only the executor, and it holds no
 * behaviour list of its own on purpose — a case that exists here but not in the matrix would be
 * coverage nobody can see, and a driver missing from a case would look exactly like a driver that
 * cannot support it.
 *
 * It replaces `tests/file-storage-driver.e2e-spec.ts` (filesystem dispatch) and
 * `tests/file-storage-s3.e2e-spec.ts` (S3 dispatch). Every case those two asserted is re-homed via
 * `FOLDED_IN` in the matrix, and `tests/unit/file-storage-parity-matrix.spec.ts` fails if any of
 * those entries stops naming a real case — so the consolidation cannot quietly lose coverage.
 * `tests/filesystem-storage.e2e-spec.ts` stays: it covers `FilesystemFileHelper` in isolation
 * (on-disk layout, index creation, failed-write cleanup), which is below this contract, not part
 * of it.
 *
 * WHY A SERVICE-LEVEL LAYER AT ALL, given the HTTP one exists: the two fail differently. Most of
 * the contract (`getBufferByName`, `deleteFileByName`, `findFileInfo` paging, the raw lookups a
 * consumer's `checkRights()` reads) has no route in front of it, and the 11.33.1 defect lived in
 * exactly such a method.
 */
import mongoose, { Connection } from 'mongoose';
import { afterAll, beforeAll, describe, expect } from 'vitest';

import envConfig from '../src/config.env';
import { FilterArgs } from '../src/core/common/args/filter.args';
import { ComparisonOperatorEnum } from '../src/core/common/enums/comparison-operator.enum';
import { SortOrderEnum } from '../src/core/common/enums/sort-order.emum';
import { IServerOptions } from '../src/core/common/interfaces/server-options.interface';
import { ConfigService } from '../src/core/common/services/config.service';
import {
  applyParityConfig,
  createParityEnvironment,
  ownerOnlyRule,
  ParityEnvironment,
  ParityFileService,
  restoreConfig,
  upload,
} from './helpers/file-storage-drivers';
import {
  expectExactlyOnce,
  failMissingInfrastructure,
  PARITY_DRIVERS,
  ParityDriver,
  parityComplement,
  parityIt,
} from './helpers/file-storage-matrix';
import { dropS3Buckets } from './helpers/s3-test-cleanup';

const OWNER = { hasRole: () => false, id: '5f0f8c3b1c9d440000a1b2c3' };
const STRANGER = { hasRole: () => false, id: '5f0f8c3b1c9d440000d4e5f6' };

/** Read a stream to a string, so stream and buffer reads can be compared directly. */
async function readStream(stream: NodeJS.ReadableStream): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of stream) {
    chunks.push(Buffer.from(chunk));
  }
  return Buffer.concat(chunks).toString();
}

function filterArgs(partial: Partial<FilterArgs>): FilterArgs {
  return partial as FilterArgs;
}

describe('File storage parity — service contract (e2e)', () => {
  let connection: Connection;
  let configService: ConfigService;
  let env: ParityEnvironment;
  let teardown: () => Promise<void>;
  let previousConfig: Partial<IServerOptions> | undefined;
  /**
   * What every driver's config is built on top of.
   *
   * `configFastButReadOnly` is undefined in a worker that never booted an app — this executor
   * drives the service directly, so it is that worker. Falling back to the real `config.env.ts`
   * keeps the environment realistic (`filter.maxLimit`, `security.*`) instead of running the
   * contract against an empty object nothing in production resembles.
   */
  let base: Partial<IServerOptions>;

  beforeAll(async () => {
    previousConfig = ConfigService.configFastButReadOnly as Partial<IServerOptions> | undefined;
    base = previousConfig ?? (envConfig as Partial<IServerOptions>);
    connection = mongoose.createConnection(envConfig.mongoose.uri);
    await connection.asPromise();
    try {
      ({ configService, env, teardown } = await createParityEnvironment({
        base,
        connection,
        label: 'parity-svc',
      }));
    } catch (error) {
      failMissingInfrastructure('s3', error);
    }
  }, 120_000);

  afterAll(async () => {
    await teardown?.();
    await dropS3Buckets(env?.s3Service?.getClient(), [env?.bucket]);
    await env?.s3Service?.onApplicationShutdown();
    await connection?.close();
    restoreConfig(previousConfig);
  }, 120_000);

  for (const driver of PARITY_DRIVERS) {
    describe(`driver: ${driver}`, () => {
      let service: ParityFileService;
      /** The two stores that are NOT the active driver — the "before the switch" fixtures. */
      const others = PARITY_DRIVERS.filter(other => other !== driver);
      let n = 0;
      /** Unique per case, so a retry cannot collide with its own first attempt. */
      const name = (label: string) => `${env.testId}-${driver}-${label}-${++n}.txt`;

      beforeAll(() => {
        applyParityConfig({ base, bucket: env.bucket, directory: env.directory, driver });
        service = new ParityFileService(connection, env.s3Service, configService);
      });

      // ---------------------------------------------------------------------------------------
      // Resolution + write placement
      // ---------------------------------------------------------------------------------------

      parityIt('service.driverResolution', driver, () => {
        expect(service.driver).toBe(driver);
        // `explicit` distinguishes "the project asked for this" from "we derived it". A derived
        // driver that happens to match would make this case pass while `file.storage` is ignored.
        expect(service.resolution.explicit).toBe(true);
      });

      parityIt('service.writesToActiveStoreOnly', driver, async () => {
        const filename = name('placement');
        const info = await service.createFile(upload('placed', filename));

        expect(info.id).toBeTruthy();
        expect(await env.holdsBytes(driver, info.id)).toBe(true);
        expect((await env.metadataDoc(driver, info.id))?.filename).toBe(filename);

        // …and nothing landed in either other store. Writes go to the active driver ONLY; it is
        // reads that span all three.
        for (const other of others) {
          expect(await env.metadataDoc(other, info.id), `${other} must not hold ${filename}`).toBeNull();
        }
      });

      // ---------------------------------------------------------------------------------------
      // Round trips
      // ---------------------------------------------------------------------------------------

      parityIt('service.readByIdRoundTrip', driver, async () => {
        const filename = name('by-id');
        const content = `bytes for ${filename}`;
        const info = await service.createFile(upload(content, filename));

        expect((await service.getFileInfo(info.id)).filename).toBe(filename);
        expect((await service.getBuffer(info.id)).toString()).toBe(content);
        expect(await readStream(await service.getFileStream(info.id))).toBe(content);

        // resolveFile answers metadata AND store in one pass; the store it reports is what the
        // controller hands to getFileStream(), so a wrong answer reads bytes out of the wrong place.
        const resolved = await service.resolveFile(info.id);
        expect(resolved?.store).toBe(driver);
        expect(resolved?.info.filename).toBe(filename);
      });

      parityIt('service.readByNameRoundTrip', driver, async () => {
        const filename = name('by-name');
        const content = `bytes for ${filename}`;
        const info = await service.createFile(upload(content, filename));

        expect((await service.getFileInfoByName(filename)).id).toBe(info.id);
        expect((await service.getBufferByName(filename)).toString()).toBe(content);
        expect(await readStream(await service.getFileStreamByName(filename))).toBe(content);
      });

      /**
       * Filenames are UNIQUE IN NO STORE, and they are client-supplied on both the multer and the
       * tus path. So the question is not "which of the two files wins" — that is inherently
       * ambiguous and the docs say to prefer the id route — but whether the ONE document a by-name
       * rights check inspects is the one whose bytes come back.
       *
       * Under GridFS it was not: `bucket.find({ filename })` returns natural order (the OLDEST
       * document first) while `openDownloadStreamByName()` defaults to `revision: -1` (the NEWEST).
       * So `getFileInfoByName()` / `getRawFileInfoByName()` authorized against one file and
       * `getFileStreamByName()` / `getBufferByName()` streamed another — a per-file ownership rule
       * therefore approved the caller's own file and handed over somebody else's bytes. The S3 and
       * filesystem drivers resolve an id first and never had the split, which is exactly why one
       * suite per driver could not see it.
       *
       * The fix has two halves. Only one of them is independently observable, and this docblock says
       * so rather than implying a mutation exists for both:
       *
       *  - DETERMINISTIC PICK (mutation below): every store's by-name lookup resolves the MOST
       *    RECENT file of that name, which is GridFS's own by-name revision semantics — so the bytes
       *    a caller already receives do not move, and the three drivers answer alike.
       *  - STRUCTURAL (no mutation): the by-name read paths resolve a document and then read by its
       *    ID. With the sort in place both halves happen to agree, so reverting this one alone
       *    cannot be seen — it is defense in depth against the two pickers drifting apart again
       *    (a tie in `uploadDate` already leaves the driver's own choice undefined).
       *
       * @regression   11.35.0 — GridFS by-name authorize/serve split (see above).
       * @seen-failing Drop the `sort` option from `findFileByName()` in
       *   `src/core/common/helpers/gridfs.helper.ts`, so the lookup falls back to natural order and
       *   answers a different document than the stream — registered as mutation
       *   `by-name-lookup-unsorted` in `tests/regression-mutations.json`.
       */
      parityIt('service.byNameAuthorizesWhatItServes', driver, async () => {
        const filename = name('reused');
        // Two files, one name — the shape a second uploader produces, deliberately or not.
        const first = await service.createFile(upload('FIRST bytes', filename));
        const second = await service.createFile(upload('SECOND bytes', filename));
        expect(first.id).not.toBe(second.id);

        // 1) The pick is the most recent file, in every store.
        const authorized = await service.getFileInfoByName(filename);
        expect(authorized.id, 'by-name resolves the most recent file of that name').toBe(second.id);

        // 2) The rights check reads the SAME document the response describes.
        const raw = await service.rawByName(filename);
        expect(String(raw?._id)).toBe(authorized.id);

        // 3) …and the bytes belong to that document, not to the other one.
        expect(await readStream(await service.getFileStreamByName(filename))).toBe('SECOND bytes');
        expect((await service.getBufferByName(filename)).toString()).toBe('SECOND bytes');

        // A duplicate is a by-name READ plus a WRITE, so it inherits the same property: the copy
        // must hold the bytes of the document that was authorized.
        const copyName = name('reused-copy');
        await service.duplicateByName(filename, copyName);
        expect(await readStream(await service.getFileStreamByName(copyName))).toBe('SECOND bytes');
      });

      /**
       * @regression 11.33.0 — `getRawFileInfoByName()` consulted S3 and GridFS but NOT the
       *   filesystem store, so a by-name ownership rule authorized against a different file set
       *   than the download route served. It failed CLOSED for the documented `!!raw && …` shape
       *   and OPEN for the equally natural `if (!raw) return true`.
       * @seen-failing Delete the `findFilesystemFileByName` line from `getRawFileInfoByName()` in
       *   `src/core/modules/file/core-file.service.ts` — registered as mutation
       *   `raw-by-name-skips-filesystem` in `tests/regression-mutations.json`, verified red by
       *   `pnpm run check:mutations`.
       */
      parityIt('service.metadataRoundTrip', driver, async () => {
        const filename = name('owned');
        const info = await service.createFile(upload('owned bytes', filename), {
          metadata: { ownerId: OWNER.id },
        });

        // BOTH raw lookups. They are separate code paths over separate helpers, and the by-name one
        // is the half that shipped broken — a passing by-id assertion says nothing about it.
        expect((await service.rawById(info.id))?.metadata?.ownerId).toBe(OWNER.id);
        expect((await service.rawByName(filename))?.metadata?.ownerId).toBe(OWNER.id);
      });

      // ---------------------------------------------------------------------------------------
      // Deletes
      // ---------------------------------------------------------------------------------------

      parityIt('service.deleteById', driver, async () => {
        const filename = name('delete-by-id');
        const info = await service.createFile(upload('doomed', filename));
        expect(await env.holdsBytes(driver, info.id)).toBe(true);

        await service.deleteFile(info.id);

        expect(await service.getFileInfo(info.id)).toBeNull();
        expect(await env.metadataDoc(driver, info.id)).toBeNull();
        // Bookkeeping AND bytes: a metadata-only delete leaves an orphan nothing can ever find.
        expect(await env.holdsBytes(driver, info.id)).toBe(false);
      });

      parityIt('service.deleteByName', driver, async () => {
        const filename = name('delete-by-name');
        const info = await service.createFile(upload('doomed', filename));

        const deleted = await service.deleteFileByName(filename);

        expect(deleted?.id).toBe(info.id);
        expect(await service.getFileInfoByName(filename)).toBeNull();
        expect(await env.metadataDoc(driver, info.id)).toBeNull();
        expect(await env.holdsBytes(driver, info.id)).toBe(false);
      });

      /**
       * @regression 11.33.1 — `deleteFileByName()` authorized the caller and then re-resolved the
       *   file via `getFileInfoByName(filename)` WITHOUT forwarding `serviceOptions`, so an
       *   overridden `checkRights()` was asked two different questions about one request. The owner
       *   was cleared by the outer check, the inner lookup denied with an empty context, and the
       *   caller got `File not found` for a file that exists and that they were just authorized for.
       * @seen-failing Drop `serviceOptions` from the `getFileInfoByName()` call in
       *   `src/core/modules/file/core-file.service.ts` — registered as mutation
       *   `delete-by-name-drops-context` in `tests/regression-mutations.json`, verified red by
       *   `pnpm run check:mutations`.
       *
       * This can only detect the defect because the rule FAILS CLOSED on a missing user. An
       * `if (!options.currentUser) return true` shortcut makes the context-less inner lookup
       * succeed too, and the assertion passes with the bug fully present — which is precisely how
       * it shipped. The refusal half below is what keeps the pair honest: without it, a rule that
       * had gone permissive would explain the green just as well.
       */
      parityIt('service.deleteByNameForwardsContext', driver, async () => {
        const filename = name('delete-context');
        const info = await service.createFile(upload('owned bytes', filename), {
          metadata: { ownerId: OWNER.id },
        });
        service.useRule(ownerOnlyRule(service));

        try {
          // A stranger is refused, and the file survives.
          expect(await service.deleteFileByName(filename, { currentUser: STRANGER })).toBeNull();
          expect(await env.metadataDoc(driver, info.id)).not.toBeNull();

          // The owner deletes with the very context the outer check granted them.
          const deleted = await service.deleteFileByName(filename, { currentUser: OWNER });
          expect(deleted?.id).toBe(info.id);
          expect(await env.metadataDoc(driver, info.id)).toBeNull();
          expect(await env.holdsBytes(driver, info.id)).toBe(false);
        } finally {
          service.useRule(undefined);
        }
      });

      // ---------------------------------------------------------------------------------------
      // Refusal shape
      // ---------------------------------------------------------------------------------------

      parityIt('service.checkRightsRefusalIsUniform', driver, async () => {
        const filename = name('refused');
        const info = await service.createFile(upload('secret bytes', filename), {
          metadata: { ownerId: OWNER.id },
        });
        service.useRule(ownerOnlyRule(service));

        try {
          const as = { currentUser: STRANGER };
          // Every read path answers the "no file" value for its own return type. A path that
          // answered something else — a throw, a stream, an empty buffer — would either leak that
          // the id is real or crash the route instead of 404-ing it.
          expect(await service.getFileInfo(info.id, as)).toBeNull();
          expect(await service.getFileInfoByName(filename, as)).toBeNull();
          expect(await service.getBuffer(info.id, as)).toBeNull();
          expect(await service.getBufferByName(filename, as)).toBeNull();
          expect(await service.getFileStream(info.id, as)).toBeNull();
          expect(await service.getFileStreamByName(filename, as)).toBeNull();
          expect(await service.resolveFile(info.id, as)).toBeNull();
          expect(await service.getDownloadUrl(info.id, as)).toBeUndefined();
          expect(await service.deleteFile(info.id, as)).toBeNull();
          expect(await service.deleteFileByName(filename, as)).toBeNull();

          // …and the refusal genuinely refused: nothing was deleted along the way.
          expect(await env.metadataDoc(driver, info.id)).not.toBeNull();
        } finally {
          service.useRule(undefined);
        }
      });

      // ---------------------------------------------------------------------------------------
      // Listing: filter, sort, page
      // ---------------------------------------------------------------------------------------

      parityIt('service.findFilterByName', driver, async () => {
        const wanted = name('filter-hit');
        const other = name('filter-miss');
        await service.createFile(upload('a', wanted));
        await service.createFile(upload('b', other));

        const found = await service.findFileInfo(
          filterArgs({
            filter: {
              singleFilter: { field: 'filename', operator: ComparisonOperatorEnum.EQ, value: wanted },
            },
          } as any),
        );

        expect(found.map(file => file.filename)).toEqual([wanted]);
      });

      parityIt('service.findSorts', driver, async () => {
        // One shared prefix, three names whose alphabetical order is NOT their insertion order —
        // so a result that merely preserves write order cannot pass.
        const prefix = `${env.testId}-${driver}-sort-${++n}`;
        const names = [`${prefix}-c.txt`, `${prefix}-a.txt`, `${prefix}-b.txt`];
        for (const filename of names) {
          await service.createFile(upload('x', filename));
        }

        const query = (order: SortOrderEnum) =>
          service.findFileInfo(
            filterArgs({
              filter: {
                singleFilter: {
                  field: 'filename',
                  operator: ComparisonOperatorEnum.REGEX,
                  value: prefix,
                },
              },
              sort: [{ field: 'filename', order }],
            } as any),
          );

        // Both orders are DERIVED, never hard-coded, so a result that merely preserves write
        // order cannot pass. `toReversed()` is deliberate: it is exactly what `oxlint --fix`
        // rewrites `.reverse()` into, and `tsconfig.tests.json` raises `lib` to ES2023 so that
        // rewrite compiles. Until it did, lint (which `check` runs first) and typecheck
        // disagreed, and `pnpm run check` could turn itself red on a file nobody had edited.
        const ascending = [...names].sort();
        const descending = ascending.toReversed();

        expect((await query(SortOrderEnum.ASC)).map(file => file.filename)).toEqual(ascending);
        expect((await query(SortOrderEnum.DESC)).map(file => file.filename)).toEqual(descending);
      });

      parityIt('service.findPages', driver, async () => {
        const prefix = `${env.testId}-${driver}-page-${++n}`;
        const names = ['a', 'b', 'c', 'd'].map(letter => `${prefix}-${letter}.txt`);
        for (const filename of names) {
          await service.createFile(upload('x', filename));
        }

        const page = (limit: number, skip: number) =>
          service.findFileInfo(
            filterArgs({
              filter: {
                singleFilter: {
                  field: 'filename',
                  operator: ComparisonOperatorEnum.REGEX,
                  value: prefix,
                },
              },
              limit,
              skip,
              sort: [{ field: 'filename', order: SortOrderEnum.ASC }],
            } as any),
          );

        const first = (await page(2, 0)).map(file => file.filename);
        const second = (await page(2, 2)).map(file => file.filename);

        expect(first).toEqual(names.slice(0, 2));
        expect(second).toEqual(names.slice(2, 4));
        // The property the merge path gets wrong when `limit`/`skip` are applied PER STORE and the
        // results concatenated: rows come back twice AND others are dropped. Containment cannot see
        // that; disjointness plus the exact slices can.
        expect(first.filter(filename => second.includes(filename))).toEqual([]);
      });

      // ---------------------------------------------------------------------------------------
      // Cross-driver — the "switching drivers is forward-only, no migration" promise
      // ---------------------------------------------------------------------------------------

      /**
       * @regression 11.33.0 — `findS3FileById/ByName` were gated on the ACTIVE driver rather than
       *   on whether S3 is usable, so adopting S3 kept GridFS readable while switching BACK turned
       *   every S3-stored file into a 404. Running this case for all three drivers covers all six
       *   ordered (written-under, read-under) pairs.
       * @seen-failing Re-gate `findS3FileById()` on `this.storageDriver === 's3'` in
       *   `src/core/modules/file/core-file.service.ts` — registered as mutation
       *   `s3-lookup-gated-on-active-driver` in `tests/regression-mutations.json`.
       */
      parityIt('service.crossDriverRead', driver, async () => {
        for (const other of others) {
          const filename = name(`legacy-${other}`);
          const content = `written under ${other}, read under ${driver}`;
          const planted = await env.plant(other, { content, filename, metadata: { ownerId: OWNER.id } });

          expect((await service.getFileInfo(planted.id)).filename).toBe(filename);
          expect((await service.getBuffer(planted.id)).toString()).toBe(content);
          expect((await service.getFileInfoByName(filename)).id).toBe(planted.id);
          expect((await service.getBufferByName(filename)).toString()).toBe(content);
          // resolveFile must report the store the bytes are ACTUALLY in — it is derived from the
          // collection that answered, never from what the document says about itself.
          expect((await service.resolveFile(planted.id))?.store).toBe(other);
          // …and the authorization read sees the same file, or a per-file rule would decide about
          // a document the download does not serve.
          expect((await service.rawByName(filename))?.metadata?.ownerId).toBe(OWNER.id);
        }
      });

      parityIt('service.crossDriverDelete', driver, async () => {
        for (const other of others) {
          const filename = name(`legacy-delete-${other}`);
          const planted = await env.plant(other, { content: 'to be deleted', filename });

          await service.deleteFile(planted.id);

          expect(await service.getFileInfo(planted.id)).toBeNull();
          expect(await env.metadataDoc(other, planted.id)).toBeNull();
          expect(await env.holdsBytes(other, planted.id)).toBe(false);
        }
      });

      // ---------------------------------------------------------------------------------------
      // Listing across stores — executed for filesystem/s3, complemented for gridfs
      // ---------------------------------------------------------------------------------------

      if (driver === 'gridfs') {
        parityComplement('service.findMergesOtherStores', 'gridfs', async () => {
          const marker = `${env.testId}-gridfs-single-store-${++n}`;
          const own = `${marker}-gridfs.txt`;
          const foreign = `${marker}-filesystem.txt`;
          await service.createFile(upload('gridfs side', own));
          const planted = await env.plant('filesystem', { content: 'filesystem side', filename: foreign });

          const names = (
            await service.findFileInfo(
              filterArgs({
                filter: {
                  singleFilter: {
                    field: 'filename',
                    operator: ComparisonOperatorEnum.REGEX,
                    value: marker,
                  },
                },
              } as any),
            )
          ).map(file => file.filename);

          // The LISTING is deliberately single-store under this driver…
          expect(names).toEqual([own]);
          // …while the row stays fully reachable by id and by name, which is what keeps a driver
          // switch forward-only. Both halves matter: the first alone would also pass if reads had
          // silently become single-store too.
          expect((await service.getFileInfo(planted.id)).filename).toBe(foreign);
          expect((await service.getFileInfoByName(foreign)).id).toBe(planted.id);
        });
      } else {
        parityIt('service.findMergesOtherStores', driver, async () => {
          const marker = `${env.testId}-${driver}-merged-${++n}`;
          const own = `${marker}-active.txt`;
          await service.createFile(upload('active side', own));
          const planted: string[] = [own];
          for (const other of others) {
            const filename = `${marker}-${other}.txt`;
            await env.plant(other, { content: `${other} side`, filename });
            planted.push(filename);
          }

          const names = (
            await service.findFileInfo(
              filterArgs({
                filter: {
                  singleFilter: {
                    field: 'filename',
                    operator: ComparisonOperatorEnum.REGEX,
                    value: marker,
                  },
                },
              } as any),
            )
          ).map(file => file.filename);

          for (const filename of planted) {
            expect(names, `${filename} must appear in the merged page`).toContain(filename);
            expectExactlyOnce(names, filename);
          }
        });
      }

      // ---------------------------------------------------------------------------------------
      // Presigned downloads (off in this configuration)
      // ---------------------------------------------------------------------------------------

      parityIt('service.downloadUrlWithoutPresigning', driver, async () => {
        // The property is "answers, never throws". Under gridfs/filesystem the S3 branch must not
        // be entered at all; under s3 it is entered and must fall through because
        // `s3.presignedDownloads` is off. Both end at `undefined`, so the controller streams —
        // which is what makes the presigned path a pure optimization rather than a second
        // authorization surface.
        const filename = name('download-url');
        const info = await service.createFile(upload('x', filename));

        expect(await service.getDownloadUrl(info.id)).toBeUndefined();
        // …and for an unknown id too, rather than throwing on a missing metadata row.
        expect(await service.getDownloadUrl(new mongoose.Types.ObjectId().toHexString())).toBeUndefined();
      });
    });
  }
});
