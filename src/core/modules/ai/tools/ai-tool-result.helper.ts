import { FRAMEWORK_SECRET_FIELDS } from '../../../common/helpers/redact-secrets.helper.js';
import { columnName } from '../../../common/persistence/sql/sql-naming.js';
import { ConfigService } from '../../../common/services/config.service.js';

/** How deep a result is walked; below that it is left as it is. */
const MAX_DEPTH = 32;

/**
 * Removes secret fields from a tool result before it reaches the model (12.10.0, nestjs-ai plan §1: "secrets never
 * reach a model").
 *
 * A tool result travels into the model's context and back to the client in `actions[].result`; the HTTP safety net
 * (`CheckSecurityInterceptor`) never sees it on the model's side. `CoreAiService.sanitizeResult()` ran
 * `securityCheck()` on model instances only, so a tool that returned a lean document or a plain object
 * (`{ ...user }`) handed its `password` hash, reset token or encrypted API key to the model. The field list is the
 * interceptor's: the framework defaults plus `security.secretFields`, each also under its SQL column name.
 *
 * Returns a copy; the tool's own value is never mutated. Values that are not plain data (Date, Buffer, ObjectId) are kept
 * as they are; a Mongoose document is replaced by its stripped `toJSON()`; a class instance is copied to a plain object
 * of its own enumerable fields.
 */
export function stripSecretFieldsForModel(value: unknown): unknown {
  return strip(value, secretKeys(), new WeakMap(), 0);
}

/**
 * A tool result as a model (or an MCP client) may read it: `securityCheck(user)` on every model instance at any depth —
 * inside arrays and plain wrappers such as the documented `{ success, data }` — the step the HTTP response pipeline takes,
 * then {@link stripSecretFieldsForModel}. Used by the chat loop (`CoreAiService.sanitizeResult()`) and the MCP server
 * (`CoreAiMcpService.mcpCallTool()`).
 */
export function sanitizeToolResultForModel(value: unknown, user: unknown): unknown {
  return stripSecretFieldsForModel(applySecurityChecks(value, user, new WeakMap(), 0));
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return false;
  }
  const proto = Object.getPrototypeOf(value);
  return proto === Object.prototype || proto === null;
}

function applySecurityChecks(value: unknown, user: unknown, seen: WeakMap<object, unknown>, depth: number): unknown {
  if (!value || typeof value !== 'object' || depth > MAX_DEPTH) {
    return value;
  }
  if (seen.has(value)) {
    return seen.get(value);
  }
  if (typeof (value as { securityCheck?: unknown }).securityCheck === 'function') {
    const checked = (value as { securityCheck: (u: unknown) => unknown }).securityCheck(user);
    seen.set(value, checked);
    return checked;
  }
  if (Array.isArray(value)) {
    const copy: unknown[] = [];
    seen.set(value, copy);
    for (const item of value) {
      copy.push(applySecurityChecks(item, user, seen, depth + 1));
    }
    return copy;
  }
  if (!isPlainObject(value)) {
    return value;
  }
  const copy: Record<PropertyKey, unknown> = {};
  seen.set(value, copy);
  for (const key of Reflect.ownKeys(value)) {
    if (Object.prototype.propertyIsEnumerable.call(value, key)) {
      copy[key] = applySecurityChecks((value as Record<PropertyKey, unknown>)[key], user, seen, depth + 1);
    }
  }
  return copy;
}

function secretKeys(): Set<string> {
  const configured = ConfigService.configFastButReadOnly?.security?.secretFields;
  const fields = [...FRAMEWORK_SECRET_FIELDS, ...(Array.isArray(configured) ? configured : [])];
  const keys = new Set<string>();
  for (const field of fields) {
    if (typeof field !== 'string') {
      continue;
    }
    keys.add(field);
    try {
      keys.add(columnName(field));
    } catch {
      // Not an identifier, so no column carries it
    }
  }
  return keys;
}

function isOpaque(value: object): boolean {
  return (
    value instanceof Date ||
    value instanceof RegExp ||
    value instanceof Map ||
    value instanceof Set ||
    Buffer.isBuffer(value) ||
    ArrayBuffer.isView(value) ||
    (value as { _bsontype?: unknown })._bsontype !== undefined
  );
}

/** A hydrated Mongoose document: what `JSON.stringify` would write of it is its `toJSON()`. */
function isMongooseDocument(value: object): value is { toJSON(): unknown } {
  return (value as { $__?: unknown }).$__ !== undefined && typeof (value as { toJSON?: unknown }).toJSON === 'function';
}

function strip(value: unknown, keys: Set<string>, seen: WeakMap<object, unknown>, depth: number): unknown {
  if (!value || typeof value !== 'object' || depth > MAX_DEPTH) {
    return value;
  }
  if (seen.has(value)) {
    return seen.get(value);
  }
  if (Array.isArray(value)) {
    const copy: unknown[] = [];
    seen.set(value, copy);
    for (const item of value) {
      copy.push(strip(item, keys, seen, depth + 1));
    }
    return copy;
  }
  if (isOpaque(value)) {
    return value;
  }
  // A Mongoose document is serialised through its toJSON() — every stored field, secrets included — so that is what
  // gets stripped
  if (isMongooseDocument(value)) {
    const json = strip(value.toJSON(), keys, seen, depth + 1);
    seen.set(value, json);
    return json;
  }
  const copy: Record<string, unknown> = {};
  seen.set(value, copy);
  for (const [key, item] of Object.entries(value)) {
    if (keys.has(key)) {
      continue;
    }
    copy[key] = strip(item, keys, seen, depth + 1);
  }
  // Symbol keys are markers of the framework's own (the ask_user_question sentinel), never data a model reads: JSON
  // drops them, the run loop needs them
  for (const symbol of Object.getOwnPropertySymbols(value)) {
    if (Object.prototype.propertyIsEnumerable.call(value, symbol)) {
      (copy as Record<symbol, unknown>)[symbol] = (value as Record<symbol, unknown>)[symbol];
    }
  }
  return copy;
}
