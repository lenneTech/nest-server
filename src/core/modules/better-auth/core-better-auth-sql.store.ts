import type { DataStore } from '../../common/persistence/data-store.interface.js';
import type { IamSqlStorage } from '../../common/persistence/persistence-runtime.registry.js';
import { quoteIdentifier, quoteMysqlIdentifier } from '../../common/persistence/sql/sql-naming.js';
import { RequestContext } from '../../common/services/request-context.service.js';
import type { BetterAuthInstance } from './better-auth.config.js';

/** A user row identified by any of its keys — the lookups the framework did with `$or` on MongoDB */
export interface IamUserMatch {
  email?: string;
  iamId?: string;
  id?: string;
}

/** What `findSession()` and `findActiveSession()` answer: Better-Auth's session and its user, with logical names */
export interface IamSessionRecord {
  session: { expiresAt: Date; id: string; token: string; userId: string };
  user: { email: string; emailVerified?: boolean; id: string; name?: string };
}

/** The counts behind the IAM migration status, over every user and account */
export interface IamMigrationCounts {
  /** Users with an `iamId` AND a credential account */
  fullyMigrated: number;
  /** Addresses of users without one of the two, at most the requested number */
  pendingEmails: string[];
  total: number;
  /** Distinct users holding a credential account */
  withIamAccount: number;
  withIamId: number;
}

/** What the store needs to count in the database Better-Auth runs on: which one it is, and a statement runner */
export type IamSqlQueryable = Pick<IamSqlStorage, 'driver' | 'query'>;

/** A passkey challenge mapping as `CoreBetterAuthChallengeService` keeps it */
export interface IamChallengeMapping {
  expiresAt: Date;
  type: 'authentication' | 'registration';
  userId?: string;
  verificationToken: string;
}

/** Identifier prefix of passkey challenge mappings in Better-Auth's `verification` table */
const CHALLENGE_PREFIX = 'lt-passkey-challenge:';

/**
 * Better-Auth's data on a SQL source, for the framework code that reached it natively on MongoDB (user mapper, token
 * service, session and JWKS lookups, passkey challenges, system setup). Two ways in, by who owns the data:
 *
 * - the user row's FRAMEWORK fields (roles, verified, the legacy password, iamId …) through the user model's store, so
 *   the framework's policies apply to them as everywhere else — `users` is one table shared with Better-Auth;
 * - Better-Auth's OWN fields and tables (name, emailVerified, sessions, accounts, JWKS, verification values) through
 *   Better-Auth's own adapter, which knows their names and runs Better-Auth's database hooks (a deleted session reaches
 *   the WebSocket revocation plugin).
 *
 * Ids are strings: on SQL Better-Auth's user id IS the framework's id (one row), and `iamId` equals it.
 */
export class BetterAuthSqlStore {
  constructor(
    readonly users: DataStore<any>,
    protected readonly auth: BetterAuthInstance,
    protected readonly sql?: IamSqlQueryable,
  ) {}

  // ---------------------------------------------------------------------------------------------
  // The user row: framework fields
  // ---------------------------------------------------------------------------------------------

  async findUser(match: IamUserMatch, select?: readonly string[]): Promise<any | null> {
    const where = whereOf(match);
    return where ? this.users.findOne(where, select ? { select } : undefined) : null;
  }

  /** Set framework fields on the first matching user; `null` when none matches */
  async updateUser(match: IamUserMatch, set: Record<string, unknown>): Promise<any | null> {
    const where = whereOf(match);
    return where ? this.users.updateOne(where, { $set: set } as any) : null;
  }

  /**
   * Set fields the role guard protects (`roles`) as system work — what the native write on MongoDB did, which no plugin
   * saw. Only for the framework's own decisions (the initial administrator), never for request input.
   */
  async updateUserAsSystem(id: string, set: Record<string, unknown>): Promise<any | null> {
    return RequestContext.runWithBypassRoleGuard(() => this.users.updateById(id, { $set: set } as any));
  }

  async countUsers(where: Record<string, unknown> = {}): Promise<number> {
    return this.users.count(where as any);
  }

  async findUsers(where: Record<string, unknown>, limit: number, select?: readonly string[]): Promise<any[]> {
    return this.users.find(where as any, { limit, select });
  }

  async deleteUser(id: string): Promise<void> {
    await this.users.deleteById(id);
  }

  // ---------------------------------------------------------------------------------------------
  // Better-Auth's fields and tables
  // ---------------------------------------------------------------------------------------------

  /** Better-Auth's own fields of the user row (`name`, `emailVerified`, `image`) — the user model does not declare them */
  async updateIamUser(userId: string, data: Record<string, unknown>): Promise<void> {
    await (await this.context()).internalAdapter.updateUser(userId, data);
  }

  async findCredentialAccount(userId: string): Promise<any | null> {
    return (await this.context()).internalAdapter.findCredentialAccount(userId);
  }

  async createAccount(account: Record<string, unknown>): Promise<any> {
    return (await this.context()).internalAdapter.createAccount(account);
  }

  async updateCredentialPassword(userId: string, hash: string): Promise<void> {
    await (await this.context()).internalAdapter.updatePassword(userId, hash);
  }

  /** End every session of a user; answers how many there were */
  async deleteSessions(userId: string): Promise<number> {
    const { adapter, internalAdapter } = await this.context();
    const count = Number(await adapter.count({ model: 'session', where: [{ field: 'userId', value: userId }] }));
    await internalAdapter.deleteUserSessions(userId);
    return count;
  }

  /** Remove every account of a user; answers how many there were */
  async deleteAccounts(userId: string): Promise<number> {
    const { adapter, internalAdapter } = await this.context();
    const count = Number(await adapter.count({ model: 'account', where: [{ field: 'userId', value: userId }] }));
    await internalAdapter.deleteAccounts(userId);
    return count;
  }

  async countCredentialAccounts(): Promise<number> {
    const adapter = (await this.context()).adapter;
    return Number(await adapter.count({ model: 'account', where: [{ field: 'providerId', value: 'credential' }] }));
  }

  /**
   * The IAM migration counts, computed in the database over every user and account — the definitions of the MongoDB
   * aggregation (`CoreBetterAuthUserMapper.getMigrationStatus()`). Never a page of rows: Better-Auth's `findMany()`
   * stops at 100 without a limit, which capped the status at 100 migrated users. Table and column names come from
   * Better-Auth's own schema, so they follow what `withSqlStorage()` mapped. The same statements on every SQL database,
   * only the identifier quotes differ; counts are converted here because MySQL answers them as strings.
   */
  async migrationCounts(pendingEmailLimit: number): Promise<IamMigrationCounts> {
    if (!this.sql) {
      throw new Error('BetterAuthSqlStore: migration counts need the database Better-Auth runs on');
    }
    const quote = this.sql.driver === 'postgres' ? quoteIdentifier : quoteMysqlIdentifier;
    const { tables } = await this.context();
    const table = (model: string) => quote(tables[model].modelName);
    const column = (model: string, field: string) => quote(tables[model].fields[field]?.fieldName ?? field);
    const users = table('user');
    const accounts = table('account');
    const iamId = column('user', 'iamId');
    const userId = column('account', 'userId');
    const providerId = column('account', 'providerId');
    const migrated = `EXISTS (SELECT 1 FROM ${accounts} a WHERE a.${userId} = u.${quote('id')} AND a.${providerId} = $1)`;
    const {
      rows: [counts],
    } = await this.sql.query(
      `SELECT (SELECT count(*) FROM ${users}) AS ${quote('total')},
              (SELECT count(*) FROM ${users} WHERE ${iamId} IS NOT NULL) AS ${quote('withIamId')},
              (SELECT count(DISTINCT ${userId}) FROM ${accounts} WHERE ${providerId} = $1) AS ${quote('withIamAccount')},
              (SELECT count(*) FROM ${users} u WHERE u.${iamId} IS NOT NULL AND ${migrated}) AS ${quote('fullyMigrated')}`,
      ['credential'],
    );
    const pending =
      pendingEmailLimit > 0
        ? await this.sql.query(
            `SELECT u.${column('user', 'email')} AS ${quote('email')} FROM ${users} u
              WHERE u.${iamId} IS NULL OR NOT ${migrated} ORDER BY u.${quote('id')} LIMIT $2`,
            ['credential', pendingEmailLimit],
          )
        : { rows: [] };
    return {
      fullyMigrated: Number(counts.fullyMigrated),
      pendingEmails: pending.rows.map((row) => row.email).filter(Boolean),
      total: Number(counts.total),
      withIamAccount: Number(counts.withIamAccount),
      withIamId: Number(counts.withIamId),
    };
  }

  /** A session by its token with its user; `null` when unknown — expiry is the caller's check, as on MongoDB */
  async findSession(token: string): Promise<IamSessionRecord | null> {
    const found = await (await this.context()).internalAdapter.findSession(token);
    return found?.session && found.user ? toSessionRecord(found.session, found.user) : null;
  }

  /** The newest session of a user that has not expired yet */
  async findActiveSession(userId: string): Promise<IamSessionRecord | null> {
    const context = await this.context();
    const [session] = await context.adapter.findMany({
      limit: 1,
      model: 'session',
      sortBy: { direction: 'desc', field: 'createdAt' },
      where: [
        { field: 'userId', value: userId },
        { field: 'expiresAt', operator: 'gt', value: new Date() },
      ],
    });
    const user = session ? await context.internalAdapter.findUserById(userId) : null;
    return session && user ? toSessionRecord(session, user) : null;
  }

  async findJwk(kid: string): Promise<any | null> {
    return (await this.context()).adapter.findOne({ model: 'jwks', where: [{ field: 'id', value: kid }] });
  }

  // ---------------------------------------------------------------------------------------------
  // Passkey challenge mappings — Better-Auth's verification values: short-lived, with an expiry, one row each
  // ---------------------------------------------------------------------------------------------

  async storeChallenge(challengeId: string, mapping: IamChallengeMapping): Promise<void> {
    const { internalAdapter, adapter } = await this.context();
    // Expired mappings are removed as new ones arrive: there is no TTL index on SQL, and expiry is checked on read anyway
    await adapter.deleteMany({
      model: 'verification',
      where: [
        { field: 'identifier', operator: 'starts_with', value: CHALLENGE_PREFIX },
        { field: 'expiresAt', operator: 'lt', value: new Date() },
      ],
    });
    await internalAdapter.createVerificationValue({
      expiresAt: mapping.expiresAt,
      identifier: CHALLENGE_PREFIX + challengeId,
      value: JSON.stringify({
        type: mapping.type,
        userId: mapping.userId,
        verificationToken: mapping.verificationToken,
      }),
    });
  }

  async findChallenge(challengeId: string): Promise<IamChallengeMapping | null> {
    const stored = await (await this.context()).internalAdapter.findVerificationValue(CHALLENGE_PREFIX + challengeId);
    if (!stored) {
      return null;
    }
    try {
      return { ...JSON.parse(stored.value), expiresAt: new Date(stored.expiresAt) };
    } catch {
      return null;
    }
  }

  async deleteChallenge(challengeId: string): Promise<void> {
    await (await this.context()).internalAdapter.deleteVerificationByIdentifier(CHALLENGE_PREFIX + challengeId);
  }

  async deleteUserChallenges(userId: string): Promise<number> {
    const { adapter } = await this.context();
    const stored = await adapter.findMany({
      model: 'verification',
      where: [{ field: 'identifier', operator: 'starts_with', value: CHALLENGE_PREFIX }],
    });
    const owned = stored.filter((row: { value: string }) => {
      try {
        return JSON.parse(row.value).userId === userId;
      } catch {
        return false;
      }
    });
    for (const row of owned) {
      await adapter.delete({ model: 'verification', where: [{ field: 'id', value: row.id }] });
    }
    return owned.length;
  }

  /**
   * Remove the sessions and verification values whose expiry has passed. Better-Auth never deletes an expired session
   * itself, and it clears expired verification values only when somebody looks one up; on MongoDB a TTL index removes
   * the verification documents. Readers check the expiry either way, so this only keeps the tables from growing
   */
  async deleteExpired(now = new Date()): Promise<{ sessions: number; verificationValues: number }> {
    const { adapter } = await this.context();
    const expired = [{ field: 'expiresAt', operator: 'lt', value: now }];
    return {
      sessions: Number(await adapter.deleteMany({ model: 'session', where: expired })),
      verificationValues: Number(await adapter.deleteMany({ model: 'verification', where: expired })),
    };
  }

  /** Better-Auth's context: its adapter maps every model and field to the tables `withSqlStorage()` named */
  protected context(): Promise<any> {
    return (this.auth as any).$context;
  }
}

/** The `$or` the framework queried on MongoDB, over the keys given; `undefined` when none is */
function whereOf(match: IamUserMatch): Record<string, unknown> | undefined {
  const or = Object.entries(match)
    .filter(([, value]) => typeof value === 'string' && value.length > 0)
    .map(([key, value]) => ({ [key]: value }));
  if (!or.length) {
    return undefined;
  }
  return or.length === 1 ? or[0] : { $or: or };
}

function toSessionRecord(session: any, user: any): IamSessionRecord {
  return {
    session: {
      expiresAt: new Date(session.expiresAt),
      id: String(session.id),
      token: session.token,
      userId: String(session.userId),
    },
    user: { email: user.email, emailVerified: user.emailVerified, id: String(user.id), name: user.name },
  };
}
