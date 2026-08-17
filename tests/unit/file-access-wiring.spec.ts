import { afterEach, describe, expect, it } from 'vitest';

import { IServerOptions } from '../../src/core/common/interfaces/server-options.interface';
import { ConfigService } from '../../src/core/common/services/config.service';
import { RequestContext } from '../../src/core/common/services/request-context.service';
import { CoreFileService, FileInputCheckType } from '../../src/core/modules/file/core-file.service';
import { FileServiceOptions } from '../../src/core/modules/file/interfaces/file-service-options.interface';

/**
 * The WIRING of `file.access`: that the preset is actually reached, that it reads the metadata it
 * claims to read, and that it costs a lookup only where the decision uses one.
 *
 * `file-access-presets.spec.ts` states the four project classes against a pure function. That cannot
 * see whether `CoreFileService` consults it, hands it the RAW document (the public `getFileInfo()`
 * runs `prepareOutput()`, which strips `metadata` — the very field the decision rests on), or asks it
 * about the right input type. Those are exactly the mistakes this module has already made: a rule fed
 * a document it cannot authorize against, and a rule asked two different questions about one request.
 *
 * A subclass exposes the protected seam and counts the lookups, because "it returned false" and "it
 * returned false without ever looking at the file" are different answers, and only one of them is the
 * rule working.
 *
 * @regression   NOT a shipped defect — a NEW feature, tagged because both mutations below are
 *   reachable and therefore worth registering: they are what make these cases demonstrably
 *   non-vacuous. A preset the service never consults, or one that decides on metadata nothing writes,
 *   would leave every assertion here green for the wrong reason.
 * @seen-failing Make the `preset === 'custom'` early return in `checkRights()` fire for every preset,
 *   and make `accessMetadata()` return the caller's metadata unchanged — registered as mutations
 *   `file-access-preset-not-reached` and `file-access-stamps-no-metadata` in
 *   `tests/regression-mutations.json`.
 */

/** Test double: no database, no store — just the two raw lookups the presets need. */
class WiredFileService extends CoreFileService {
  lookupsById = 0;
  lookupsByName = 0;
  stored: Record<string, any> | null = null;

  constructor() {
    // The base constructor reaches for a Mongo connection; a stub is enough because every read path
    // under test goes through the two overridden raw lookups below.
    super({ db: { collection: () => ({}) } } as any, 'fs');
  }

  ask(input: any, options: { checkInputType: FileInputCheckType } & FileServiceOptions) {
    return this.checkRights(input, options);
  }

  stampFor(options?: FileServiceOptions) {
    return this.accessMetadata(options);
  }

  protected override async getRawFileInfo(): Promise<null | Record<string, any>> {
    this.lookupsById++;
    return this.stored;
  }

  protected override async getRawFileInfoByName(): Promise<null | Record<string, any>> {
    this.lookupsByName++;
    return this.stored;
  }
}

const configure = (access?: string) =>
  ConfigService.setConfig(
    { env: 'test', file: access ? { access } : {}, mongoose: { uri: 'mongodb://localhost/x' } } as unknown as IServerOptions,
    { reInit: true },
  );

const ALICE = { hasRole: () => false, id: 'alice' };
const BOB = { hasRole: () => false, id: 'bob' };

describe('file.access wiring in CoreFileService', () => {
  afterEach(() => ConfigService.setConfig({ env: 'test' } as unknown as IServerOptions, { reInit: true }));

  it('is inert by default — the base rule still answers true for everything', async () => {
    configure(undefined);
    const service = new WiredFileService();
    service.stored = { metadata: { ownerId: 'alice' } };

    expect(await service.ask('id', { checkInputType: 'id', currentUser: BOB })).toBe(true);
    expect(service.lookupsById, 'and it costs no lookup either').toBe(0);
  });

  it('reaches the owner preset and decides from the RAW metadata', async () => {
    configure('owner');
    const service = new WiredFileService();
    service.stored = { metadata: { ownerId: 'alice' } };

    expect(await service.ask('id', { checkInputType: 'id', currentUser: ALICE })).toBe(true);
    expect(await service.ask('id', { checkInputType: 'id', currentUser: BOB })).toBe(false);
    expect(service.lookupsById, 'the decision must actually read the document').toBe(2);
  });

  it('covers the by-NAME branch, which is a different lookup', async () => {
    configure('owner');
    const service = new WiredFileService();
    service.stored = { metadata: { ownerId: 'alice' } };

    expect(await service.ask('name.txt', { checkInputType: 'filename', currentUser: BOB })).toBe(false);
    expect(service.lookupsByName).toBe(1);
  });

  it('spends no lookup on a write or a listing', async () => {
    configure('owner');
    const service = new WiredFileService();

    expect(await service.ask({}, { checkInputType: 'file', currentUser: ALICE })).toBe(true);
    expect(await service.ask(undefined, { checkInputType: 'filterArgs', currentUser: ALICE })).toBe(false);
    expect(service.lookupsById + service.lookupsByName).toBe(0);
  });

  it('honours force without consulting anything', async () => {
    configure('owner');
    const service = new WiredFileService();

    expect(await service.ask('id', { checkInputType: 'id', force: true })).toBe(true);
    expect(service.lookupsById).toBe(0);
  });

  /**
   * The tenant preset must read the VALIDATED tenant from `RequestContext`, not a header and not
   * `serviceOptions`. That is the same source `mongooseTenantPlugin` filters by, so a file decision
   * and a database decision cannot disagree about which tenant the request is in.
   */
  it('reads the tenant from RequestContext, and fails closed without one', async () => {
    configure('tenant');
    const service = new WiredFileService();
    service.stored = { metadata: { tenantId: 't1' } };

    expect(await service.ask('id', { checkInputType: 'id', currentUser: ALICE })).toBe(false);

    const inTenant = (tenantId: string) =>
      RequestContext.run({ currentUser: ALICE, tenantId } as any, () =>
        service.ask('id', { checkInputType: 'id', currentUser: ALICE }),
      );
    expect(await inTenant('t1')).toBe(true);
    expect(await inTenant('t2')).toBe(false);
  });
});

/**
 * The other half of a usable preset: the metadata it decides on has to GET there.
 *
 * `'owner'` reads `metadata.ownerId` and `'tenant'` reads `metadata.tenantId`. If the framework only
 * READ those and left the writing to the project, the preset would be a rule about data that does not
 * exist — every file ADMIN-only, which is exactly the shape TUS uploads had before 11.35.0 and exactly
 * the report that came back from downstream.
 *
 * Stamped only when a preset needs it, so a `'custom'` project's metadata is untouched. And never
 * overriding a value the caller supplied, so a project that records ownership itself keeps winning.
 */
describe('file.access metadata stamping', () => {
  afterEach(() => ConfigService.setConfig({ env: 'test' } as unknown as IServerOptions, { reInit: true }));

  const stamp = (service: WiredFileService, options?: FileServiceOptions) => service.stampFor(options);

  it('stamps nothing under the default preset', () => {
    configure(undefined);
    expect(stamp(new WiredFileService(), { currentUser: ALICE })).toBeUndefined();
  });

  it('stamps the uploader under the owner preset', () => {
    configure('owner');
    expect(stamp(new WiredFileService(), { currentUser: ALICE })).toEqual({ ownerId: 'alice' });
  });

  it('stamps the validated tenant under the tenant preset', () => {
    configure('tenant');
    const service = new WiredFileService();
    const stamped = RequestContext.run({ currentUser: ALICE, tenantId: 't1' } as any, () =>
      stamp(service, { currentUser: ALICE }),
    );
    expect(stamped).toEqual({ ownerId: 'alice', tenantId: 't1' });
  });

  it('never overrides what the caller supplied', () => {
    configure('owner');
    expect(stamp(new WiredFileService(), { currentUser: ALICE, metadata: { ownerId: 'explicit' } })).toEqual({
      ownerId: 'explicit',
    });
  });

  it('keeps the caller\'s other metadata', () => {
    configure('owner');
    expect(stamp(new WiredFileService(), { currentUser: ALICE, metadata: { kind: 'avatar' } })).toEqual({
      kind: 'avatar',
      ownerId: 'alice',
    });
  });

  it('stamps nothing it cannot know — an anonymous upload gets no owner', () => {
    configure('owner');
    expect(stamp(new WiredFileService(), {})).toBeUndefined();
  });
});
