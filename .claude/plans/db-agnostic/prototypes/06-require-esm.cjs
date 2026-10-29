// A1: a CommonJS consumer must be able to require() every SQL-side dependency (require(esm), no top-level await).
const results = [];
for (const name of ['kysely', 'pg', '@mikro-orm/core', '@mikro-orm/postgresql', 'better-auth', 'better-auth/db']) {
  try {
    const mod = require(name);
    results.push(`PASS  require('${name}') -> ${Object.keys(mod).length} exports`);
  } catch (e) {
    results.push(`FAIL  require('${name}') -> ${e.code ?? ''} ${e.message.split('\n')[0]}`);
  }
}
console.log(results.join('\n'));
