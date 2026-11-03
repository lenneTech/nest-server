import { describe, expect, it, vi } from 'vitest';

import { CoreSyncService } from '../../src/core/modules/sync/core-sync.service';

/**
 * A client sends the changes of one record with chained base versions, also in one request (protocol §6.2): each later
 * item carries the version the item before it produces. When that item is NOT stored, the later one must not be
 * applied either — on its own its base version can match whatever another writer left, and the change would land on
 * data the client never saw while the client drops it locally (§7). The push therefore holds the later items of that
 * record back; items of other records are unaffected. `tests/sync-contract.e2e-spec.ts` (`push-after-refused-item`)
 * proves it over HTTP on every database.
 */
describe('CoreSyncService.push — the later items of a record whose item was not stored', () => {
  const ID_A = '6720c0aa0000000000000001';
  const ID_B = '6720c0aa0000000000000002';
  const SERVER_RECORD = { data: { title: 'theirs' }, deletedAt: null, id: ID_A, version: 2 };
  const USER = { id: 'user-push' };

  /** A push item; `n` keeps the mutation ids apart */
  const item = (id: string, n: number, baseVersion?: number) => ({
    ...(baseVersion === undefined ? {} : { baseVersion }),
    data: { title: `change ${n}` },
    id,
    mutationId: `mutation-${n}`,
    op: 'upsert',
  });

  /**
   * A service whose single-item path answers from `outcomes` (by mutation id, `applied` otherwise) and records which
   * items it was asked to apply. `visible` is what the caller may see of a record when a held-back item is answered.
   */
  const service = (outcomes: Record<string, string>, visible: Record<string, any> = { [ID_A]: SERVER_RECORD }) => {
    const instance: any = Object.create(CoreSyncService.prototype);
    const applied: string[] = [];
    instance.registration = () => ({ idFormat: 'objectId', name: 'SyncNote' });
    instance.pushItem = vi.fn(async (_registration: unknown, pushed: any) => {
      applied.push(pushed.mutationId);
      const status = outcomes[pushed.mutationId] ?? 'applied';
      return { id: pushed.id, mutationId: pushed.mutationId, status };
    });
    instance.findVisible = vi.fn(async (_registration: unknown, id: string) => visible[id]);
    instance.logger = { warn: vi.fn() };
    return { applied, instance: instance as CoreSyncService };
  };

  /**
   * @regression   12.3.0 — every item was applied on its own, so a change chained to a refused one was applied on the
   *   version another writer left: [base 1 (conflict with their v2), base 2] stored the second change on their data.
   * @seen-failing Stop holding later items back in push()
   *   (src/core/modules/sync/core-sync.service.ts) — registered as mutation `sync-push-loop-ignores-refused-item` in
   *   tests/regression-mutations.json.
   */
  it('answers the later items of a conflicting record with conflict and the current record, without applying them', async () => {
    const { applied, instance } = service({ 'mutation-1': 'conflict' });
    const { results } = await instance.push(
      'SyncNote',
      { items: [item(ID_A, 1, 1), item(ID_A, 2, 2), item(ID_B, 3, 1), item(ID_A, 4, 3)] },
      USER,
    );
    expect(results.map((result) => [result.mutationId, result.status])).toEqual([
      ['mutation-1', 'conflict'],
      ['mutation-2', 'conflict'],
      ['mutation-3', 'applied'],
      ['mutation-4', 'conflict'],
    ]);
    expect(results[1]).toMatchObject({ id: ID_A, record: SERVER_RECORD, version: 2 });
    // Only the first item of the record and the other record's item reached the single-item path (claim, write,
    // recorded outcome) — the held-back ones were never evaluated, so nothing about them is recorded either
    expect(applied).toEqual(['mutation-1', 'mutation-3']);
  });

  it.each(['rejected', 'not_found'])('holds the later items back after %s, too', async (status) => {
    const { applied, instance } = service({ 'mutation-1': status });
    const { results } = await instance.push('SyncNote', { items: [item(ID_A, 1, 1), item(ID_A, 2, 2)] }, USER);
    expect(results[1]).toMatchObject({ record: SERVER_RECORD, status: 'conflict' });
    expect(applied).toEqual(['mutation-1']);
  });

  it('answers not_found when the caller may not see the record — a conflict always carries one', async () => {
    const { instance } = service({ 'mutation-1': 'not_found' }, {});
    const { results } = await instance.push('SyncNote', { items: [item(ID_A, 1, 1), item(ID_A, 2, 2)] }, USER);
    expect(results[1]).toEqual({ id: ID_A, mutationId: 'mutation-2', status: 'not_found' });
  });

  /**
   * @regression   12.3.0 — the item behind a `retry` must not be answered `conflict`: a server-wins client would drop a
   *   change nobody decided against, while its predecessor goes out again.
   * @seen-failing Answer a held-back item behind a retry as a conflict in heldBackItem()
   *   (src/core/modules/sync/core-sync.service.ts) — registered as mutation `sync-push-retry-held-back-as-conflict` in
   *   tests/regression-mutations.json.
   */
  it('a retry holds the later items back as retry, so the client sends them again together', async () => {
    const { applied, instance } = service({ 'mutation-1': 'retry' });
    const { results } = await instance.push(
      'SyncNote',
      { items: [item(ID_A, 1, 1), item(ID_A, 2, 2), item(ID_B, 3, 1)] },
      USER,
    );
    expect(results.map((result) => result.status)).toEqual(['retry', 'retry', 'applied']);
    expect(applied).toEqual(['mutation-1', 'mutation-3']);
  });

  it('applies the later items normally after applied or merged', async () => {
    for (const status of ['applied', 'merged']) {
      const { applied, instance } = service({ 'mutation-1': status });
      const { results } = await instance.push('SyncNote', { items: [item(ID_A, 1, 1), item(ID_A, 2, 2)] }, USER);
      expect(results.map((result) => result.status)).toEqual([status, 'applied']);
      expect(applied).toEqual(['mutation-1', 'mutation-2']);
    }
  });

  it('a held-back item with an id in the wrong format is rejected with INVALID_ID, never looked up', async () => {
    const { instance } = service({ 'mutation-1': 'rejected' });
    const { results } = await instance.push('SyncNote', { items: [item('bad id', 1, 1), item('bad id', 2, 2)] }, USER);
    expect(results[1]).toMatchObject({ code: 'INVALID_ID', status: 'rejected' });
    expect((instance as any).findVisible).not.toHaveBeenCalled();
  });

  it('answers retry when the record cannot be read for a held-back item', async () => {
    const { instance } = service({ 'mutation-1': 'conflict' });
    (instance as any).findVisible = vi.fn(async () => {
      throw new Error('store unavailable');
    });
    const { results } = await instance.push('SyncNote', { items: [item(ID_A, 1, 1), item(ID_A, 2, 2)] }, USER);
    expect(results[1]).toEqual({ id: ID_A, mutationId: 'mutation-2', status: 'retry' });
    expect((instance as any).logger.warn).toHaveBeenCalledWith(expect.stringContaining('store unavailable'));
  });
});
