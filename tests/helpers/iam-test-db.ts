import { type Db, MongoClient, ObjectId } from 'mongodb';
import { Client } from 'pg';

/**
 * Direct database access for the IAM suites, on whichever database the run routes the users to: MongoDB in the `e2e`
 * project, PostgreSQL in the `iam-sql-<engine>` projects (`NSC__DATABASE__OWNER_URL` is set there). A suite reads and
 * prepares state through this instead of a MongoDB client of its own, so one suite proves both databases.
 *
 * Records come back with camelCase field names and a string `id`, whichever database answered.
 */
export interface IamTestDb {
  /** Which database the users live in */
  readonly driver: 'mongodb' | 'postgres';
  /** The MongoDB database of the run — for what stays on MongoDB in both projects */
  readonly mongo: Db;
  close(): Promise<void>;
  countUsers(match: UserMatch): Promise<number>;
  /** The user's credential account (`providerId: 'credential'`) */
  credentialAccount(userId: string): Promise<null | Record<string, any>>;
  /** Any account of the user, a credential account or a social one */
  findAccount(userId: string): Promise<null | Record<string, any>>;
  /** A session of the user, the newest */
  findUserSession(userId: string): Promise<null | Record<string, any>>;
  /** Remove users and everything Better-Auth keeps for them (sessions, accounts, 2FA, passkeys) */
  deleteUsers(match: UserMatch): Promise<void>;
  /** Let a session expire a minute ago, as if its lifetime had passed */
  expireSession(token: string): Promise<void>;
  findSession(token: string): Promise<null | Record<string, any>>;
  findUser(match: UserMatch): Promise<null | Record<string, any>>;
  /** Write a credential account for a user directly, as Better-Auth would after a password sign-up */
  insertCredentialAccount(userId: string): Promise<void>;
  /** Write a user row directly, past every policy — for what a suite must plant; answers its id */
  insertUser(fields: Record<string, unknown>): Promise<string>;
  /** The token of the user's newest session */
  latestSessionToken(userId: string): Promise<null | string>;
  /** A passkey challenge mapping where the database keeps it: its own collection on MongoDB, a verification value on SQL */
  passkeyChallenge(challengeId: string): Promise<null | Record<string, any>>;
  /** Set fields on the user rows that match */
  updateUser(match: UserMatch, set: Record<string, unknown>): Promise<void>;
}

/** Users by email (exact or a pattern), by id, or by several ids */
export interface UserMatch {
  email?: RegExp | string;
  id?: string;
  ids?: string[];
}

export async function openIamTestDb(mongoUri: string): Promise<IamTestDb> {
  const mongoClient = await MongoClient.connect(mongoUri);
  const mongo = mongoClient.db();
  const ownerUrl = process.env.NSC__DATABASE__OWNER_URL;
  if (!ownerUrl) {
    return new MongoIamTestDb(mongoClient, mongo);
  }
  const pg = new Client({ connectionString: ownerUrl });
  await pg.connect();
  return new PostgresIamTestDb(mongoClient, mongo, pg);
}

class MongoIamTestDb implements IamTestDb {
  readonly driver = 'mongodb' as const;

  constructor(
    protected readonly client: MongoClient,
    readonly mongo: Db,
  ) {}

  async close(): Promise<void> {
    await this.client.close();
  }

  async countUsers(match: UserMatch): Promise<number> {
    return this.mongo.collection('users').countDocuments(this.filter(match));
  }

  async credentialAccount(userId: string): Promise<null | Record<string, any>> {
    const account = await this.mongo
      .collection('account')
      .findOne({ providerId: 'credential', userId: { $in: this.idForms(userId) } });
    return account ? { ...account, id: String(account._id) } : null;
  }

  async findAccount(userId: string): Promise<null | Record<string, any>> {
    const account = await this.mongo.collection('account').findOne({ userId: { $in: this.idForms(userId) } });
    return account ? { ...account, id: String(account._id) } : null;
  }

  async findUserSession(userId: string): Promise<null | Record<string, any>> {
    const [session] = await this.mongo
      .collection('session')
      .find({ userId: { $in: this.idForms(userId) } })
      .sort({ createdAt: -1 })
      .limit(1)
      .toArray();
    return session ? { ...session, id: String(session._id), userId: String(session.userId) } : null;
  }

  async deleteUsers(match: UserMatch): Promise<void> {
    const users = await this.mongo.collection('users').find(this.filter(match)).toArray();
    const forms = users.flatMap((user) => [user._id, String(user._id), ...(user.iamId ? [user.iamId] : [])]);
    for (const collection of ['session', 'account', 'twoFactor', 'passkey']) {
      await this.mongo.collection(collection).deleteMany({ userId: { $in: forms } });
    }
    await this.mongo.collection('users').deleteMany({ _id: { $in: users.map((user) => user._id) } });
  }

  async expireSession(token: string): Promise<void> {
    await this.mongo.collection('session').updateOne({ token }, { $set: { expiresAt: new Date(Date.now() - 60_000) } });
  }

  async findSession(token: string): Promise<null | Record<string, any>> {
    const session = await this.mongo.collection('session').findOne({ token });
    return session ? { ...session, id: String(session._id), userId: String(session.userId) } : null;
  }

  async findUser(match: UserMatch): Promise<null | Record<string, any>> {
    const user = await this.mongo.collection('users').findOne(this.filter(match));
    return user ? { ...user, id: String(user._id) } : null;
  }

  async insertCredentialAccount(userId: string): Promise<void> {
    const now = new Date();
    await this.mongo.collection('account').insertOne({
      accountId: userId,
      createdAt: now,
      providerId: 'credential',
      updatedAt: now,
      userId: new ObjectId(userId),
    });
  }

  async insertUser(fields: Record<string, unknown>): Promise<string> {
    return String((await this.mongo.collection('users').insertOne({ ...fields })).insertedId);
  }

  async latestSessionToken(userId: string): Promise<null | string> {
    const [session] = await this.mongo
      .collection('session')
      .find({ userId: { $in: this.idForms(userId) } })
      .sort({ createdAt: -1 })
      .limit(1)
      .toArray();
    return session?.token ?? null;
  }

  async passkeyChallenge(challengeId: string): Promise<null | Record<string, any>> {
    return this.mongo.collection('webauthn_challenge_mappings').findOne({ challengeId });
  }

  async updateUser(match: UserMatch, set: Record<string, unknown>): Promise<void> {
    await this.mongo.collection('users').updateMany(this.filter(match), { $set: set });
  }

  /** Better-Auth stores a user reference as the ObjectId, older rows as its string */
  protected idForms(userId: string): unknown[] {
    return ObjectId.isValid(userId) ? [new ObjectId(userId), userId] : [userId];
  }

  protected filter(match: UserMatch): Record<string, unknown> {
    if (match.ids) {
      return { _id: { $in: match.ids.filter((id) => ObjectId.isValid(id)).map((id) => new ObjectId(id)) } };
    }
    if (match.id) {
      return { _id: ObjectId.isValid(match.id) ? new ObjectId(match.id) : match.id };
    }
    return { email: match.email };
  }
}

class PostgresIamTestDb implements IamTestDb {
  readonly driver = 'postgres' as const;

  constructor(
    protected readonly client: MongoClient,
    readonly mongo: Db,
    protected readonly pg: Client,
  ) {}

  async close(): Promise<void> {
    await Promise.all([this.client.close(), this.pg.end()]);
  }

  async countUsers(match: UserMatch): Promise<number> {
    const { params, where } = this.where(match);
    const { rows } = await this.pg.query(`SELECT count(*)::int AS n FROM users WHERE ${where}`, params);
    return rows[0].n;
  }

  async credentialAccount(userId: string): Promise<null | Record<string, any>> {
    const { rows } = await this.pg.query(
      `SELECT * FROM account WHERE user_id = $1 AND provider_id = 'credential' LIMIT 1`,
      [userId],
    );
    return rows[0] ? camelCase(rows[0]) : null;
  }

  async findAccount(userId: string): Promise<null | Record<string, any>> {
    const { rows } = await this.pg.query('SELECT * FROM account WHERE user_id = $1 LIMIT 1', [userId]);
    return rows[0] ? camelCase(rows[0]) : null;
  }

  async findUserSession(userId: string): Promise<null | Record<string, any>> {
    const { rows } = await this.pg.query('SELECT * FROM session WHERE user_id = $1 ORDER BY created_at DESC LIMIT 1', [
      userId,
    ]);
    return rows[0] ? camelCase(rows[0]) : null;
  }

  async deleteUsers(match: UserMatch): Promise<void> {
    const { params, where } = this.where(match);
    const { rows } = await this.pg.query(`SELECT id FROM users WHERE ${where}`, params);
    const ids = rows.map((row) => row.id);
    if (!ids.length) {
      return;
    }
    for (const table of ['session', 'account', 'two_factor', 'passkey']) {
      await this.pg.query(`DELETE FROM ${table} WHERE user_id = ANY($1)`, [ids]).catch(() => undefined);
    }
    await this.pg.query('DELETE FROM users WHERE id = ANY($1)', [ids]);
  }

  async expireSession(token: string): Promise<void> {
    await this.pg.query(`UPDATE session SET expires_at = now() - interval '1 minute' WHERE token = $1`, [token]);
  }

  async findSession(token: string): Promise<null | Record<string, any>> {
    const { rows } = await this.pg.query('SELECT * FROM session WHERE token = $1', [token]);
    return rows[0] ? camelCase(rows[0]) : null;
  }

  async findUser(match: UserMatch): Promise<null | Record<string, any>> {
    const { params, where } = this.where(match);
    const { rows } = await this.pg.query(`SELECT * FROM users WHERE ${where} LIMIT 1`, params);
    return rows[0] ? camelCase(rows[0]) : null;
  }

  async insertCredentialAccount(userId: string): Promise<void> {
    await this.pg.query(
      `INSERT INTO account (id, account_id, provider_id, user_id, created_at, updated_at)
       VALUES ($1, $2, 'credential', $2, now(), now())`,
      [new ObjectId().toHexString(), userId],
    );
  }

  async insertUser(fields: Record<string, unknown>): Promise<string> {
    const id = new ObjectId().toHexString();
    const entries = Object.entries({ ...fields, id });
    await this.pg.query(
      `INSERT INTO users (${entries.map(([key]) => snakeCase(key)).join(', ')}) VALUES (${entries.map((_, index) => `$${index + 1}`).join(', ')})`,
      entries.map(([, value]) => (Array.isArray(value) ? JSON.stringify(value) : value)),
    );
    return id;
  }

  async latestSessionToken(userId: string): Promise<null | string> {
    const { rows } = await this.pg.query(
      'SELECT token FROM session WHERE user_id = $1 ORDER BY created_at DESC LIMIT 1',
      [userId],
    );
    return rows[0]?.token ?? null;
  }

  async passkeyChallenge(challengeId: string): Promise<null | Record<string, any>> {
    const { rows } = await this.pg.query('SELECT value, expires_at FROM verification WHERE identifier = $1', [
      `lt-passkey-challenge:${challengeId}`,
    ]);
    return rows[0] ? { ...JSON.parse(rows[0].value), challengeId, expiresAt: rows[0].expires_at } : null;
  }

  async updateUser(match: UserMatch, set: Record<string, unknown>): Promise<void> {
    const entries = Object.entries(set);
    const { params, where } = this.where(match, entries.length);
    const assignments = entries.map(([key], index) => `${snakeCase(key)} = $${index + 1}`).join(', ');
    const values = entries.map(([, value]) => (Array.isArray(value) ? JSON.stringify(value) : value));
    await this.pg.query(`UPDATE users SET ${assignments} WHERE ${where}`, [...values, ...params]);
  }

  /** A WHERE clause over `users` for the match; parameters numbered after `offset` */
  protected where(match: UserMatch, offset = 0): { params: unknown[]; where: string } {
    if (match.ids) {
      return { params: [match.ids], where: `id = ANY($${offset + 1})` };
    }
    if (match.id) {
      return { params: [match.id], where: `id = $${offset + 1}` };
    }
    if (match.email instanceof RegExp) {
      return { params: [match.email.source], where: `email ~ $${offset + 1}` };
    }
    return { params: [match.email], where: `email = $${offset + 1}` };
  }
}

function snakeCase(field: string): string {
  return field
    .replace(/([a-z\d])([A-Z])/g, '$1_$2')
    .replace(/([A-Z]+)([A-Z][a-z])/g, '$1_$2')
    .toLowerCase();
}

/** A row as MongoDB would return the document: camelCase fields, and a column never written left out (not `null`) */
function camelCase(row: Record<string, any>): Record<string, any> {
  return Object.fromEntries(
    Object.entries(row)
      .filter(([, value]) => value !== null)
      .map(([column, value]) => [column.replace(/_([a-z\d])/g, (_, c: string) => c.toUpperCase()), value]),
  );
}
