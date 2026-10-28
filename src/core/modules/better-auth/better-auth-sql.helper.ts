import { getAuthTables } from 'better-auth/db';
import { getMigrations } from 'better-auth/db/migration';

import { DataSourceConfigError } from '../../common/persistence/data-source.config.js';
import { generateId } from '../../common/persistence/id-format.js';
import { type IamSqlStorage, registerForeignColumns } from '../../common/persistence/persistence-runtime.registry.js';
import { columnName, quoteIdentifier } from '../../common/persistence/sql/sql-naming.js';

/** The table Better-Auth shares with the user model — created and owned by the framework */
const USERS_TABLE = 'users';

/**
 * Better-Auth's own fields of the user row that the user model does not declare. Their columns are Better-Auth's, not
 * left-overs of a removed field: the framework's schema evolution must not report them at every boot.
 */
registerForeignColumns(USERS_TABLE, ['email_verified', 'image', 'name']);

/** Postgres column type of a Better-Auth field, for a column the framework adds before Better-Auth's migration */
const SQL_TYPES: Record<string, string> = {
  boolean: 'boolean',
  date: 'timestamptz',
  json: 'jsonb',
  number: 'integer',
  'number[]': 'jsonb',
  string: 'text',
  'string[]': 'jsonb',
};

/** The tables Better-Auth's own options name (models of plugins come from the plugins) */
const CORE_MODELS = ['user', 'session', 'account', 'verification'] as const;

type Options = Record<string, any>;

/**
 * Better-Auth on a SQL data source: its built-in Kysely adapter on the given `pg` pool (Better-Auth recognises the
 * pool and builds its own Kysely instance — the core imports no Kysely), ids in the framework's format, and every table
 * and column named the way the framework names it.
 *
 * Naming is not cosmetic. Better-Auth and the user model share ONE row per user in `users`: the framework creates that
 * table from the user model, its column for a field is `columnName(field)` (`firstName` → `first_name`), and Better-Auth
 * must address exactly those columns — a second, camelCase `firstName` column would split one value in two. Applying the
 * same rule to every name Better-Auth uses (the stored name it has on MongoDB, snake-cased) covers the user model's
 * fields, Better-Auth's own tables and every plugin's tables, the project's plugins included, with no list to maintain.
 * On MongoDB nothing of this applies: the stored names stay exactly as they are.
 *
 * Plugins are copied, never changed: a plugin object a project passes may also serve an instance on MongoDB in the same
 * process, which must keep its names.
 */
export function withSqlStorage(options: Options, pool: unknown): Options {
  const sqlOptions: Options = {
    ...options,
    advanced: {
      ...options.advanced,
      // ObjectId-hex, generated in the application: the id the framework gives every other row, so a user created by
      // Better-Auth and one created through the user service are indistinguishable (plan §3.5)
      database: { ...options.advanced?.database, generateId: () => generateId() },
    },
    database: pool,
    plugins: (options.plugins ?? []).map((plugin: Options) =>
      plugin?.schema ? { ...plugin, schema: snakeCaseSchema(plugin.schema) } : plugin,
    ),
  };
  const tables = getAuthTables(sqlOptions as any) as Record<
    string,
    { fields: Record<string, Options>; modelName: string }
  >;
  for (const model of CORE_MODELS) {
    const own = (sqlOptions[model] ?? {}) as Options;
    const fields: Record<string, string> = {};
    for (const [key, field] of Object.entries(tables[model]?.fields ?? {})) {
      fields[key] = columnName(field.fieldName ?? key);
    }
    sqlOptions[model] = {
      ...own,
      additionalFields: own.additionalFields ? snakeCaseFields(own.additionalFields) : undefined,
      fields,
      modelName: columnName(own.modelName ?? tables[model]?.modelName ?? model),
    };
  }
  return sqlOptions;
}

/** A plugin's schema with its tables and columns named like the framework's */
function snakeCaseSchema(schema: Record<string, Options>): Record<string, Options> {
  return Object.fromEntries(
    Object.entries(schema).map(([key, table]) => [
      key,
      {
        ...table,
        fields: snakeCaseFields(table.fields ?? {}),
        // A plugin's entry for a core table only adds fields; the table's name is Better-Auth's own option
        ...((CORE_MODELS as readonly string[]).includes(key) ? {} : { modelName: columnName(table.modelName ?? key) }),
      },
    ]),
  );
}

function snakeCaseFields(fields: Record<string, Options>): Record<string, Options> {
  return Object.fromEntries(
    Object.entries(fields).map(([key, field]) => [key, { ...field, fieldName: columnName(field.fieldName ?? key) }]),
  );
}

/** The tables Better-Auth's options declare that Better-Auth owns: all of them but the shared `users` table */
export function betterAuthOwnedTables(options: Options): string[] {
  const tables = getAuthTables(options as any) as Record<string, { modelName: string }>;
  return [...new Set(Object.values(tables).map((table) => table.modelName))].filter((name) => name !== USERS_TABLE);
}

/**
 * Bring Better-Auth's tables up to date before the instance exists (it validates its schema as it starts): Better-Auth's
 * own migrator, run as the owner under the framework's schema lock. It only creates tables and adds columns — on `users`
 * the ones the user model does not declare (`name`, `email_verified`, `image`); it never drops or alters a column.
 * Without an owner connection it only checks, and a pending change stops the boot like a framework table would.
 */
export async function applyBetterAuthSchema(options: Options, storage: IamSqlStorage): Promise<void> {
  await storage.applySchema(async (pool, asOwner) => {
    const nullable = asOwner ? await addRequiredUserColumnsAsNullable(options, pool as PgPool) : new Set<string>();
    const { runMigrations, toBeAdded, toBeCreated } = await getMigrations({
      ...options,
      database: pool,
      logger: withoutNullabilityWarnings(options.logger, nullable),
    } as any);
    if (asOwner) {
      await runMigrations();
      return;
    }
    const pending = [...toBeCreated, ...toBeAdded].map((change: { table: string }) => change.table);
    if (pending.length) {
      throw new DataSourceConfigError(
        `Better-Auth's tables in "${storage.source}" are not up to date (${[...new Set(pending)].join(', ')}), and ` +
          'without database.ownerUrl the application role may only verify them — configure the owner, or migrate them',
      );
    }
  }, betterAuthOwnedTables(options));
}

interface PgPool {
  query(text: string, params?: unknown[]): Promise<{ rows: any[] }>;
}

/**
 * A field Better-Auth declares required without a default (`name`) becomes a NOT NULL column when Better-Auth adds it —
 * and every user the FRAMEWORK creates (legacy sign-up, user service, system setup) would then fail to insert, because the
 * user model knows nothing of it. On MongoDB such a user simply has no `name`. So the framework adds these columns
 * first, nullable like every column it creates (the database does not enforce `required`, as on MongoDB); Better-Auth
 * then finds them and adds nothing. Returns every required user column that is nullable by the framework's design.
 */
async function addRequiredUserColumnsAsNullable(options: Options, pool: PgPool): Promise<Set<string>> {
  const users = (getAuthTables(options as any) as Record<string, any>).user;
  const { rows } = await pool.query(
    'SELECT column_name FROM information_schema.columns WHERE table_schema = current_schema() AND table_name = $1',
    [users.modelName],
  );
  const existing = new Set(rows.map((row) => row.column_name as string));
  const nullable = new Set<string>();
  for (const [key, field] of Object.entries(users.fields as Record<string, any>)) {
    const column = field.fieldName ?? key;
    if (field.required === false) {
      continue;
    }
    // Every column the framework created for a field is nullable — the user model's `email` and timestamps included
    nullable.add(column);
    if (field.defaultValue === undefined && !existing.has(column) && SQL_TYPES[field.type]) {
      await pool.query(
        `ALTER TABLE ${quoteIdentifier(users.modelName)} ADD COLUMN IF NOT EXISTS ${quoteIdentifier(column)} ${SQL_TYPES[field.type]}`,
      );
    }
  }
  return nullable;
}

/**
 * Better-Auth's logger, minus the warning that a required user column is nullable — for the columns the framework made
 * nullable on purpose; every other message (a type mismatch, an unsafe change) is still reported
 */
function withoutNullabilityWarnings(logger: Options | undefined, columns: Set<string>): Options | undefined {
  if (!columns.size || typeof logger?.log !== 'function') {
    return logger;
  }
  return {
    ...logger,
    log: (level: string, message: string, ...args: unknown[]) => {
      const column = /^Column "([^"]+)" on table "users" stays nullable/.exec(String(message))?.[1];
      if (level === 'warn' && column && columns.has(column)) {
        return;
      }
      logger.log(level, message, ...args);
    },
  };
}
