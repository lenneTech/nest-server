// What do automatic schema tools do to EXISTING DATA on typical model changes?
// v1: { id, title, qty:text, legacy } with 3 rows  ->  v2: title renamed to name, qty text->int, legacy dropped,
// note added (optional), code added (required, no default), index on name.
import 'reflect-metadata';
import { DataSource, EntitySchema } from 'typeorm';

const URL = 'postgres://proto_owner:proto@127.0.0.1:5434/proto';
const out = [];
const log = (engine, step, detail) => out.push(`${engine.padEnd(16)} ${step.padEnd(34)} ${detail}`);

// ---------------- TypeORM ----------------
const v1T = new EntitySchema({ name: 'Item', tableName: 'evo_typeorm', columns: {
  id: { type: 'text', primary: true }, title: { type: 'text' }, qty: { type: 'text' }, legacy: { type: 'text', nullable: true } } });
const v2T = new EntitySchema({ name: 'Item', tableName: 'evo_typeorm', columns: {
  id: { type: 'text', primary: true }, name: { type: 'text' }, qty: { type: 'int' }, note: { type: 'text', nullable: true },
  code: { type: 'text' } }, indices: [{ name: 'evo_typeorm_name_idx', columns: ['name'] }] });

let d = await new DataSource({ type: 'postgres', url: URL, entities: [v1T] }).initialize();
await d.query('DROP TABLE IF EXISTS evo_typeorm');
await d.synchronize();
await d.query(`INSERT INTO evo_typeorm VALUES ('a','Alpha','1','x'),('b','Beta','2','y'),('c','Gamma','3',NULL)`);
await d.destroy();

d = await new DataSource({ type: 'postgres', url: URL, entities: [v2T] }).initialize();
const plan = await d.driver.createSchemaBuilder().log();
log('TypeORM', 'planned (migration:generate)', plan.upQueries.map((q) => q.query.replace(/\s+/g, ' ')).join(' | '));
try {
  await d.synchronize();
  const rows = await d.query('SELECT * FROM evo_typeorm ORDER BY id');
  log('TypeORM', 'synchronize: result', JSON.stringify(rows));
} catch (e) {
  log('TypeORM', 'synchronize: FAILED', e.message.split('\n')[0]);
  const rows = await d.query('SELECT * FROM evo_typeorm ORDER BY id').catch((x) => x.message);
  log('TypeORM', 'synchronize: table after failure', JSON.stringify(rows));
}
await d.destroy();

// ---------------- MikroORM ----------------
const { MikroORM, EntitySchema: MikroSchema } = await import('@mikro-orm/postgresql');
const v1M = new MikroSchema({ name: 'Item', tableName: 'evo_mikro', properties: {
  id: { type: 'string', primary: true, columnType: 'text' }, title: { type: 'string', columnType: 'text' }, qty: { type: 'string', columnType: 'text' },
  legacy: { type: 'string', columnType: 'text', nullable: true } } });
const v2M = new MikroSchema({ name: 'Item', tableName: 'evo_mikro', properties: {
  id: { type: 'string', primary: true, columnType: 'text' }, name: { type: 'string', columnType: 'text', index: true },
  qty: { type: 'integer' }, note: { type: 'string', columnType: 'text', nullable: true }, code: { type: 'string', columnType: 'text' } } });

for (const mode of ['default', 'safe']) {
  let orm = await MikroORM.init({ entities: [v1M], clientUrl: URL, allowGlobalContext: true });
  await orm.em.getConnection().execute('DROP TABLE IF EXISTS evo_mikro');
  await orm.schema.update();
  await orm.em.getConnection().execute(`INSERT INTO evo_mikro VALUES ('a','Alpha','1','x'),('b','Beta','2','y'),('c','Gamma','3',NULL)`);
  await orm.close();
  orm = await MikroORM.init({ entities: [v2M], clientUrl: URL, allowGlobalContext: true });
  const opts = mode === 'safe' ? { safe: true, dropTables: false } : {};
  const sqlPlan = await orm.schema.getUpdateSchemaSQL({ wrap: false, ...opts });
  log(`MikroORM ${mode}`, 'planned', sqlPlan.replace(/\s+/g, ' ').trim());
  try {
    await orm.schema.update(opts);
    const rows = await orm.em.getConnection().execute('SELECT * FROM evo_mikro ORDER BY id');
    log(`MikroORM ${mode}`, 'update: result', JSON.stringify(rows));
  } catch (e) {
    log(`MikroORM ${mode}`, 'update: FAILED', e.message.split('\n')[0].slice(0, 160));
  }
  await orm.close();
}
console.log(out.join('\n'));
