/**
 * A project on PostgreSQL alone, booted with MongoDB's libraries hidden (`without-mongodb.hooks.mjs`). Run by
 * `scripts/check-without-mongodb.mjs`; plain JavaScript, so the same file runs against the source (through the
 * TypeScript loader), against `dist/` and against the packed package installed into a project without MongoDB.
 *
 * Environment: FRAMEWORK_ENTRY (the framework's index), FRAMEWORK_CONFIG (its `config.env`), PROOF_DATABASE_URL and
 * PROOF_DATABASE_OWNER_URL (a database of this run's own). Prints one line per step and exits non-zero on the first
 * failure.
 */
import 'reflect-metadata';

const step = (text) => console.log(`[without-mongodb] ${text}`);
const fail = (text) => {
  console.error(`[without-mongodb] FAILED: ${text}`);
  process.exit(1);
};

const framework = await import(process.env.FRAMEWORK_ENTRY);
const envConfig = (await import(process.env.FRAMEWORK_CONFIG)).default;
const { Inject, Injectable, Module } = await import('@nestjs/common');
const { Readable } = await import('node:stream');
const { mkdtemp, rm } = await import('node:fs/promises');
const { tmpdir } = await import('node:os');
const { join } = await import('node:path');
const { NestFactory } = await import('@nestjs/core');
const {
  CoreFileService,
  CoreModule,
  CorePersistenceModel,
  CorePersistenceModule,
  CoreUserModel,
  getConnectionToken,
  getStoreToken,
  hasMongoPackages,
  Prop,
  RequestContext,
  Schema,
  SchemaFactory,
} = framework;

if (hasMongoPackages()) {
  fail('MongoDB libraries are reachable — the proof must run with them hidden or uninstalled');
}
step(`framework loaded (${Object.keys(framework).length} exports), MongoDB libraries not installed`);

// The project's models, declared through the framework's own decorators — the form a PostgreSQL project uses
class ProofUser extends CoreUserModel {}
Schema({ collection: 'users', timestamps: true })(ProofUser);

class ProofNote extends CorePersistenceModel {}
Prop({ type: String })(ProofNote.prototype, 'title');
Prop({ default: 0, type: Number })(ProofNote.prototype, 'rank');
// Computed defaults: without Mongoose nothing but the declared schema can compute them
Prop({ default: Date.now, type: Date })(ProofNote.prototype, 'stampedAt');
Prop({ default: {}, type: Object })(ProofNote.prototype, 'meta');
Schema({ collection: 'proofNotes', timestamps: true })(ProofNote);

const config = {
  ...envConfig,
  ai: undefined,
  cronJobs: undefined,
  database: { ownerUrl: process.env.PROOF_DATABASE_OWNER_URL, url: process.env.PROOF_DATABASE_URL },
  execAfterInit: undefined,
  graphQl: false,
  hub: undefined,
  mongoose: undefined,
};

// A project's FileService — what the starter ships: without MongoDB there is no GridFS, so the derived driver is the
// filesystem, its metadata in the PostgreSQL table `filesystem_files`
class ProofFileService extends CoreFileService {
  constructor(connection) {
    super(connection, 'fs');
  }
}
Inject(getConnectionToken())(ProofFileService, undefined, 0);
Injectable()(ProofFileService);

const storageDir = await mkdtemp(join(tmpdir(), 'nest-server-without-mongodb-'));
config.file = { ...config.file, storageDir };

class ProofModule {}
Module({
  imports: [
    CoreModule.forRoot(config),
    CorePersistenceModule.forFeature([
      { model: ProofUser, name: 'User', schema: SchemaFactory.createForClass(ProofUser) },
      { model: ProofNote, name: 'ProofNote', schema: SchemaFactory.createForClass(ProofNote) },
    ]),
  ],
  providers: [ProofFileService],
})(ProofModule);

const app = await NestFactory.create(ProofModule, { logger: ['error', 'fatal'] });
await app.listen(0, '127.0.0.1');
const base = `http://127.0.0.1:${app.getHttpServer().address().port}`;
step(`booted on PostgreSQL alone (${base})`);

try {
  const notes = app.get(getStoreToken('ProofNote'), { strict: false });
  if (notes.driver !== 'postgres') {
    fail(`ProofNote is stored on ${notes.driver}, not on postgres`);
  }
  const created = await RequestContext.runWithBypassTenantGuard(() => notes.insert({ rank: 2, title: 'first' }));
  if (!(created.stampedAt instanceof Date) || JSON.stringify(created.meta) !== '{}') {
    fail(`computed defaults were not applied: ${JSON.stringify(created)}`);
  }
  await notes.updateById(created.id, { $inc: { rank: 1 } });
  const [read] = await notes.find({ title: 'first' });
  if (read?.rank !== 3 || !/^[0-9a-f]{24}$/.test(read.id)) {
    fail(`store CRUD returned ${JSON.stringify(read)}`);
  }
  await notes.deleteById(created.id);
  if ((await notes.count({})) !== 0) {
    fail('deleteById left the record behind');
  }
  step('CRUD through the data store: insert (computed defaults), update ($inc), find, delete');

  const email = `proof-${Date.now()}@without-mongodb.test`;
  const password = 'Proof-Password-123!';
  const json = async (path, init) => {
    const response = await fetch(`${base}${path}`, {
      ...init,
      headers: { 'content-type': 'application/json', ...init?.headers },
    });
    return {
      body: await response.json().catch(() => undefined),
      cookies: response.headers.getSetCookie().map((cookie) => cookie.split(';')[0]),
      status: response.status,
    };
  };
  const signUp = await json('/iam/sign-up/email', {
    body: JSON.stringify({ email, name: 'Proof User', password, termsAndPrivacyAccepted: true }),
    method: 'POST',
  });
  if (signUp.status >= 300) {
    fail(`sign-up answered ${signUp.status}: ${JSON.stringify(signUp.body)}`);
  }
  const signIn = await json('/iam/sign-in/email', { body: JSON.stringify({ email, password }), method: 'POST' });
  if (signIn.status >= 300 || !signIn.cookies.length) {
    fail(`sign-in answered ${signIn.status}: ${JSON.stringify(signIn.body)}`);
  }
  // As a browser does: the session cookie Better-Auth set
  const session = await json('/iam/session', { headers: { cookie: signIn.cookies.join('; ') } });
  if (session.body?.user?.email !== email) {
    fail(`the session does not carry the user: ${session.status} ${JSON.stringify(session.body)}`);
  }
  const users = app.get(getStoreToken('User'), { strict: false });
  const stored = await RequestContext.runWithBypassTenantGuard(() => users.findOne({ email }));
  if (!stored || users.driver !== 'postgres') {
    fail('the user is not in the PostgreSQL users table');
  }
  step('Better-Auth on PostgreSQL: sign-up, sign-in, session, one users row');

  const files = app.get(ProofFileService);
  const content = 'bytes without MongoDB';
  const storedFile = await files.createFile(
    { createReadStream: () => Readable.from([content]), filename: 'proof.txt', mimetype: 'text/plain' },
    { force: true },
  );
  const bytes = await files.getBuffer(storedFile.id, { force: true });
  if (bytes.toString() !== content) {
    fail(`the stored file reads back as ${JSON.stringify(bytes.toString())}`);
  }
  step('file storage without GridFS: written to the filesystem, metadata in PostgreSQL, read back');
} finally {
  await app.close();
  await rm(storageDir, { force: true, recursive: true });
}
step('done');
process.exit(0);
