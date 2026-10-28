/**
 * Node module hooks that make MongoDB's libraries look NOT INSTALLED — for proving that the framework loads and runs on
 * PostgreSQL alone (12.1.0+, `mongoose`, `@nestjs/mongoose` and `mongodb` are optional peers).
 *
 * `module.registerHooks()` (synchronous hooks) covers `import`, `require()` and `createRequire()` alike, which is what
 * makes the proof honest: the framework loads its MongoDB support through `createRequire()`, and a hook seen only by
 * `import` would let that path through. Resolution fails exactly as for an absent package (`ERR_MODULE_NOT_FOUND` /
 * `MODULE_NOT_FOUND`, naming the specifier), so the framework's own "not installed" detection is what is exercised.
 *
 * Usage: `node --import ./scripts/lib/without-mongodb.hooks.mjs …`
 */
import { registerHooks } from 'node:module';

/** The packages a project on PostgreSQL alone does not install, and the driver internals they would bring */
const HIDDEN = /^(mongoose|@nestjs\/mongoose|mongodb|bson|@better-auth\/mongo-adapter)(\/|$)/;

registerHooks({
  resolve(specifier, context, nextResolve) {
    if (HIDDEN.test(specifier)) {
      const commonJs = context.conditions?.includes('require');
      const error = new Error(
        `Cannot find ${commonJs ? 'module' : 'package'} '${specifier}' (hidden: no MongoDB) imported from ${context.parentURL}`,
      );
      error.code = commonJs ? 'MODULE_NOT_FOUND' : 'ERR_MODULE_NOT_FOUND';
      throw error;
    }
    return nextResolve(specifier, context);
  },
});
