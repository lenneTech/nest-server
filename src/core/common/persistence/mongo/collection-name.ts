import { optionalMongoPackages } from './mongo-packages.js';

/**
 * The collection name MongoDB gives a model that declares none — and therefore the name of its SQL table
 * (`postgres-schema.compiler.ts` → `tableName()`), so a model keeps one name on every database.
 *
 * Where Mongoose is installed its CURRENT pluralizer decides, a project's own `mongoose.pluralize(fn)` (or `null`,
 * which keeps the name) included. Without Mongoose the legacy rules below decide — Mongoose's default
 * (`lib/helpers/pluralize.js`, MIT, © LearnBoost and Automattic, extracted by TJ Holowaychuk from `_ext.js`), copied
 * unchanged so a model is named alike whether or not the project installs Mongoose;
 * `tests/unit/collection-name.spec.ts` compares the two.
 */
export function defaultCollectionName(modelName: string): string {
  const packages = optionalMongoPackages();
  if (packages) {
    const pluralize = packages.mongoose.pluralize();
    return pluralize ? pluralize(modelName) : modelName;
  }
  return legacyPluralize(modelName);
}

const RULES: Array<[RegExp, string]> = [
  [/human$/gi, 'humans'],
  [/(m|wom)an$/gi, '$1en'],
  [/(pe)rson$/gi, '$1ople'],
  [/(child)$/gi, '$1ren'],
  [/^(ox)$/gi, '$1en'],
  [/(ax|test)is$/gi, '$1es'],
  [/(octop|cact|foc|fung|nucle)us$/gi, '$1i'],
  [/(alias|status|virus)$/gi, '$1es'],
  [/(bu)s$/gi, '$1ses'],
  [/(buffal|tomat|potat)o$/gi, '$1oes'],
  [/([ti])um$/gi, '$1a'],
  [/sis$/gi, 'ses'],
  [/(?:([^f])fe|([lr])f)$/gi, '$1$2ves'],
  [/(hive)$/gi, '$1s'],
  [/([^aeiouy]|qu)y$/gi, '$1ies'],
  [/(x|ch|ss|sh)$/gi, '$1es'],
  [/(matr|vert|ind)ix|ex$/gi, '$1ices'],
  [/([m|l])ouse$/gi, '$1ice'],
  [/(kn|w|l)ife$/gi, '$1ives'],
  [/(quiz)$/gi, '$1zes'],
  [/^goose$/i, 'geese'],
  [/s$/gi, 's'],
  [/([^a-z])$/, '$1'],
  [/$/gi, 's'],
];

const UNCOUNTABLES = new Set([
  'advice',
  'energy',
  'excretion',
  'digestion',
  'cooperation',
  'health',
  'justice',
  'labour',
  'machinery',
  'equipment',
  'information',
  'pollution',
  'sewage',
  'paper',
  'money',
  'species',
  'series',
  'rain',
  'rice',
  'fish',
  'sheep',
  'moose',
  'deer',
  'news',
  'expertise',
  'status',
  'media',
]);

/** Mongoose's legacy pluralizer: lowercased, then the first matching rule */
export function legacyPluralize(name: string): string {
  const lower = name.toLowerCase();
  if (UNCOUNTABLES.has(lower)) {
    return lower;
  }
  const rule = RULES.find(([pattern]) => lower.match(pattern));
  return rule ? lower.replace(rule[0], rule[1]) : lower;
}
