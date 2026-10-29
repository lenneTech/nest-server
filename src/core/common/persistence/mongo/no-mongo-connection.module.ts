import { Global, Module } from '@nestjs/common';

import { getConnectionToken } from './mongoose-compat.js';

/**
 * The Mongoose connection token where no MongoDB is configured (`database` names no MongoDB source): `null`.
 *
 * Services of the core receive the connection through `@InjectConnection()` and use it only on their MongoDB path —
 * on a SQL source they work through the data store. Without this provider every one of them would fail DI in a project
 * that keeps its data in PostgreSQL alone; with it, a MongoDB path that is reached anyway fails with a named error
 * (`CorePersistenceModule` stand-ins, `requireMongoPackages()`) instead of a missing-provider stack trace at boot.
 */
@Global()
@Module({
  exports: [getConnectionToken()],
  providers: [{ provide: getConnectionToken(), useValue: null }],
})
export class NoMongoConnectionModule {}
