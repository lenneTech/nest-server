import type { Connection } from 'mongoose';

import type { IamUserMatch } from './core-better-auth-sql.store.js';
import { isValidObjectId, newObjectId } from '../../common/persistence/mongo/mongoose-compat.js';

/** One way to look the app user up on the per-request auth path — by one key at a time */
export interface IamUserLookup {
  findUser(match: IamUserMatch): Promise<null | Record<string, unknown>>;
}

/**
 * The app user on MongoDB for the per-request auth path (token service). The one place on that path that knows a
 * MongoDB id is an ObjectId: the services ask by string, and only this class turns an id into a `_id` filter — a
 * string that is no ObjectId finds nobody, as before. On a SQL source `BetterAuthSqlStore` answers instead.
 */
export class BetterAuthMongoUsers implements IamUserLookup {
  constructor(protected readonly connection: Connection) {}

  async findUser(match: IamUserMatch): Promise<null | Record<string, unknown>> {
    const or: Record<string, unknown>[] = [];
    if (match.email) {
      or.push({ email: match.email });
    }
    if (match.iamId) {
      or.push({ iamId: match.iamId });
    }
    if (match.id && isValidObjectId(match.id)) {
      or.push({ _id: newObjectId(match.id) });
    }
    if (!or.length) {
      return null;
    }
    return this.connection.collection('users').findOne(or.length === 1 ? or[0] : { $or: or });
  }
}
