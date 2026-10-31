import { createHash } from 'node:crypto';

import type { DataStore, StoredRecord } from '../../common/persistence/data-store.interface.js';

/** The recorded outcome of a mutation: what a repeat of it is answered with (protocol §6.5) */
export interface SyncMutationOutcome {
  code?: string;
  status: string;
  version?: number;
}

/**
 * What a claim found:
 * - `claimed`: this request writes the mutation and then records its outcome (`complete()`) or gives it up (`release()`)
 * - `busy`: another request is writing it right now — answer `retry`
 * - `done`: it was applied before — answer with its outcome
 */
export type SyncMutationClaim = { kind: 'busy' } | { kind: 'claimed' } | { kind: 'done'; outcome: SyncMutationOutcome };

interface MutationRecord {
  attempt?: number;
  claimedAt?: Date;
  code?: null | string;
  expiresAt?: Date;
  key: string;
  state?: string;
  status?: null | string;
  version?: null | number;
}

/**
 * Idempotency of pushed changes (offline-sync plan §3.7): the mutation is claimed BEFORE the record is written, under a
 * unique key, so two tabs sending the same change at once end in one write — the second finds the claim and is told to
 * retry, then finds the outcome. A record written after the write could not give that: both requests would miss it.
 *
 * A claim older than the claim timeout belongs to a request that died between claiming and recording; it is taken over
 * with a conditional write on `attempt`, which exactly one contender wins. An entry past `expiresAt` counts as absent
 * whether or not the TTL has removed it yet.
 */
export class CoreSyncMutationStore {
  constructor(
    protected readonly store: DataStore<MutationRecord>,
    protected readonly options: { claimTimeoutMs: number; retentionMs: number },
  ) {}

  /**
   * The key of a mutation: model, user, record and mutation id, hashed to a fixed length. The user is part of it, so a
   * mutation id of somebody else can neither block a change nor reveal its outcome.
   */
  static key(model: string, userId: string, recordId: string, mutationId: string): string {
    return createHash('sha256').update([model, userId, recordId, mutationId].join('\u0000')).digest('hex');
  }

  async claim(key: string, now = new Date()): Promise<SyncMutationClaim> {
    // A concurrent claimant can make each step fail once; three rounds settle every interleaving of two requests
    for (let round = 0; round < 3; round++) {
      const existing = await this.store.findOne({ key });
      if (!existing) {
        try {
          await this.store.insert({ key, ...this.pending(now, 1) });
          return { kind: 'claimed' };
        } catch (error) {
          if (!isDuplicateKey(error)) {
            throw error;
          }
          continue;
        }
      }
      if (isExpired(existing, now)) {
        if (await this.takeOver(existing, now)) {
          return { kind: 'claimed' };
        }
        continue;
      }
      if (existing.state === 'done' && existing.status) {
        return { kind: 'done', outcome: outcomeOf(existing) };
      }
      const claimedAt = existing.claimedAt ? new Date(existing.claimedAt).getTime() : 0;
      if (now.getTime() - claimedAt < this.options.claimTimeoutMs) {
        return { kind: 'busy' };
      }
      return (await this.takeOver(existing, now)) ? { kind: 'claimed' } : { kind: 'busy' };
    }
    return { kind: 'busy' };
  }

  /** Record the outcome of a claimed mutation; kept for the retention period from now */
  async complete(key: string, outcome: SyncMutationOutcome, now = new Date()): Promise<void> {
    await this.store.updateOne(
      { key },
      {
        $set: {
          code: outcome.code ?? null,
          expiresAt: new Date(now.getTime() + this.options.retentionMs),
          state: 'done',
          status: outcome.status,
          version: outcome.version ?? null,
        },
      },
    );
  }

  /** Give up a claim whose write did not happen (a transient failure), so the client's retry is written anew */
  async release(key: string): Promise<void> {
    await this.store.deleteOne({ key, state: 'pending' });
  }

  protected pending(now: Date, attempt: number): Omit<MutationRecord, 'key'> {
    return {
      attempt,
      claimedAt: now,
      code: null,
      expiresAt: new Date(now.getTime() + this.options.retentionMs),
      state: 'pending',
      status: null,
      version: null,
    };
  }

  /** Take an abandoned or expired entry over: conditional on the attempt the reader saw, so one contender wins */
  protected async takeOver(existing: StoredRecord<MutationRecord>, now: Date): Promise<boolean> {
    const attempt = existing.attempt ?? 0;
    const taken = await this.store.updateOne(
      { attempt: existing.attempt ?? null, id: existing.id },
      { $set: this.pending(now, attempt + 1) },
    );
    return !!taken;
  }
}

function isExpired(record: MutationRecord, now: Date): boolean {
  return !!record.expiresAt && new Date(record.expiresAt).getTime() <= now.getTime();
}

function outcomeOf(record: MutationRecord): SyncMutationOutcome {
  return {
    ...(record.code ? { code: record.code } : {}),
    status: record.status,
    ...(typeof record.version === 'number' ? { version: record.version } : {}),
  };
}

/** A unique index refused the write — MongoDB's code, which the SQL stores carry too (`DuplicateKeyError`) */
export function isDuplicateKey(error: unknown): boolean {
  return (error as { code?: unknown })?.code === 11000;
}
