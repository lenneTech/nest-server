---
title: "process() Performance Optimization"
description: "How the process() pipeline of CrudService avoids memory and CPU overhead on hot paths and service cascades, without weakening any security check."
---

> **Status: implemented in 11.23.0** (see `migration-guides/11.22.x-to-11.23.0.md`). This page records the changes as
> they were made. The code excerpts and line numbers show the state at that time; the current implementation may
> differ in detail — the source files named below are authoritative.

## Context

The `process()` pipeline in `ModuleService` is the central processing path for all CRUD operations. With
high-frequency or nested calls (service cascades) it caused unnecessarily high memory and CPU usage. The optimizations
below reduce the overhead without weakening security.

**Basis of the analysis:** 8 customer projects and 13 lenne.tech projects were checked — all changes are backward
compatible.

---

## Change 1: Make the JSON.stringify debug output configurable

### File: `src/core/common/services/module.service.ts`

### Problem

Lines 149-164 serialized the input **twice** on every `process()` call (before and after) — only for a
`console.debug` comparison. The `new Promise(() => ...)` was fire-and-forget without `await`.

### Code before (lines 149-165)

```typescript
const originalInput = config.input;
const inputJSON = JSON.stringify(originalInput);
const preparedInput = await this.prepareInput(config.input, config);
new Promise(() => {
  if (
    inputJSON?.replace(/"password":\s*"[^"]*"/, '') !==
    JSON.stringify(preparedInput)?.replace(/"password":\s*"[^"]*"/, '')
  ) {
    console.debug(
      'CheckSecurityInterceptor: securityCheck changed input of type',
      originalInput.constructor.name,
      'to type',
      preparedInput.constructor.name,
    );
  }
});
config.input = preparedInput;
```

### New code

```typescript
const preparedInput = await this.prepareInput(config.input, config);

// Debug comparison only when explicitly configured (default: false)
if (this.configService?.getFastButReadOnly('debugProcessInput', false)) {
  try {
    const originalJSON = JSON.stringify(config.input)?.replace(/"password":\s*"[^"]*"/, '');
    const preparedJSON = JSON.stringify(preparedInput)?.replace(/"password":\s*"[^"]*"/, '');
    if (originalJSON !== preparedJSON) {
      console.debug(
        'process: prepareInput changed input of type',
        config.input?.constructor?.name,
        'to type',
        preparedInput?.constructor?.name,
      );
    }
  } catch {
    // JSON.stringify can fail on circular references — ignore
  }
}

config.input = preparedInput;
```

### File: `src/core/common/interfaces/server-options.interface.ts`

Added to the `IServerOptions` interface:

```typescript
/**
 * When true, logs a debug message when prepareInput() changes the input type.
 * Default: false. Enable only for debugging — has performance cost due to JSON.stringify.
 */
debugProcessInput?: boolean;
```

### Security

Not affected — purely diagnostic.

### Compatibility

Default `false` — no existing project changes its behavior.

---

## Change 2: Replace this.get(dbObject) with a lean query

### File: `src/core/common/services/module.service.ts`

### Problem

Lines 168-176 called `this.get()`, which runs the whole `process()` pipeline **recursively** — including
`prepareInput`, `checkRights`, `processFieldSelection` and `prepareOutput`. That is unnecessary, because the
`dbObject` is only needed as context for the rights check.

It was even **counterproductive**: `this.get()` without `force` can remove fields such as `createdBy` (because of
`@Restricted(RoleEnum.ADMIN)`), which are then missing for the `S_CREATOR` check.

### Code before (lines 168-176)

```typescript
// Get DB object
if (config.dbObject && config.checkRights && this.checkRights) {
  if (typeof config.dbObject === 'string' || config.dbObject instanceof Types.ObjectId) {
    const dbObject = await this.get(getStringIds(config.dbObject));
    if (dbObject) {
      config.dbObject = dbObject;
    }
  }
}
```

### New code

```typescript
// Get DB object for rights checking — lean query to avoid recursive process() call.
// Using lean preserves ALL fields (including createdBy) which is needed for
// S_CREATOR and S_SELF checks. The full process() pipeline would remove
// restricted fields, potentially breaking these checks.
if (config.dbObject && config.checkRights && this.checkRights) {
  if (typeof config.dbObject === 'string' || config.dbObject instanceof Types.ObjectId) {
    if (this.mainDbModel) {
      const rawDoc = await this.mainDbModel.findById(getStringIds(config.dbObject)).lean().exec();
      if (rawDoc) {
        // Map to Model instance so securityCheck() is available as a method
        config.dbObject = (this.mainModelConstructor as any)?.map
          ? (this.mainModelConstructor as any).map(rawDoc)
          : rawDoc;
      }
    }
  }
}
```

### Security

**Improved** — the lean query keeps all fields (e.g. `createdBy`), which makes the `S_CREATOR` check more reliable
than the previous code.

### Downstream steps checked

- `checkRights(input)` (lines 179-184): uses `config.dbObject` for the `S_CREATOR` / `S_SELF` / `memberOf` checks via
  `equalIds()` — works with lean + map, because `equalIds` compares ObjectIds as well as strings.
- `checkRights(output)` (lines 239-250): same usage — works.
- `validateRestricted()` in `checkRestricted()` (`restricted.decorator.ts`, lines 172-174): checks
  `'createdBy' in data && equalIds(data.createdBy, user)` — the lean object always has `createdBy` (not removed by the
  pipeline).
- `memberOf` check (lines 196-218): reads `config.dbObject?.[property]` — the lean object has all properties.

### Compatibility

- `CrudService.update()` (line 552) already sets `dbObject` as a lean object (`findById().lean()`) → consistent.
- No project passes a Mongoose document as `dbObject` → no conflict.
- Services that call `process()` directly with `dbObject` as a string (for example a project's own offer service)
  benefit from the optimization.

---

## Change 3: Depth tracking in RequestContext

### File: `src/core/common/services/request-context.service.ts`

### Problem

In service cascades (A.create → B.create → C.create) the full `process()` pipeline ran on every level. Populate,
`prepareOutput` mapping and the output `checkRights` on inner levels are unnecessary, because the outer level and the
`CheckSecurityInterceptor` take care of them.

### Change to the interface

```typescript
export interface IRequestContext {
  // ... existing fields ...

  /**
   * Tracks the nesting depth of process() calls.
   * 0 = outermost call (full pipeline), > 0 = nested call (reduced pipeline).
   * Used to skip redundant populate, output mapping, and output rights checks
   * on inner calls — the outermost call and CheckSecurityInterceptor handle these.
   */
  processDepth?: number;
}
```

### New methods

```typescript
/**
 * Get the current process() nesting depth.
 * Returns 0 if not inside a process() call.
 */
static getProcessDepth(): number {
  return this.storage.getStore()?.processDepth || 0;
}

/**
 * Run a function with incremented process depth.
 * Skips context creation if already at depth > 0 to avoid redundant object spread.
 */
static runWithIncrementedProcessDepth<T>(fn: () => T): T {
  const currentStore = this.storage.getStore();
  const currentDepth = currentStore?.processDepth || 0;
  const context: IRequestContext = {
    ...currentStore,
    processDepth: currentDepth + 1,
  };
  return this.storage.run(context, fn);
}
```

### Security

Not affected — depth tracking is purely informational and changes no permissions.

---

## Change 4: Depth-based optimization in process()

### File: `src/core/common/services/module.service.ts`

### Change in process() (line 81 ff.)

At the start of the method, after the config is created (after line 108):

```typescript
// Detect nested process() calls
const currentDepth = RequestContext.getProcessDepth();
const isNested = currentDepth > 0;
```

### Run serviceFunc with depth tracking (replaces lines 201-205)

```typescript
// Run service function with incremented depth
// When force is enabled, also bypass the Mongoose role guard plugin
const executeServiceFunc = () =>
  RequestContext.runWithIncrementedProcessDepth(() => serviceFunc(config));

let result = config.force
  ? await RequestContext.runWithBypassRoleGuard(executeServiceFunc)
  : await executeServiceFunc();
```

### Skip processFieldSelection on inner calls (replaces lines 207-217)

```typescript
// Pop and map main model
// Skip on nested calls UNLESS populate was explicitly requested —
// the outermost call handles population for the final response.
if (config.processFieldSelection && config.fieldSelection && this.processFieldSelection) {
  if (!isNested || config.populate) {
    let temps = result;
    if (!Array.isArray(result)) {
      temps = [result];
    }
    for (const temp of temps) {
      const field = config.outputPath ? _.get(temp, config.outputPath) : temp;
      await this.processFieldSelection(field, config.fieldSelection, config.processFieldSelection);
    }
  }
}
```

**Logic:**

- `isNested = false` (depth 0, outermost call): populate always runs → the user gets the complete result.
- `isNested = true` (depth > 0, inner call) WITHOUT `config.populate`: populate is skipped → the result is processed
  further internally.
- `isNested = true` WITH `config.populate` (set explicitly by the caller): populate runs → the inner service asked for
  it explicitly because it needs the data.

### Reduce prepareOutput on inner calls (replaces lines 219-236)

```typescript
// Prepare output
if (config.prepareOutput && this.prepareOutput) {
  const opts = config.prepareOutput;
  if (!opts.targetModel && config.outputType) {
    opts.targetModel = config.outputType;
  }

  // On nested calls without explicit populate: skip model mapping
  // (the outermost call and CheckSecurityInterceptor handle final mapping).
  // Secret removal (removeSecrets) stays active at ALL depths.
  if (isNested && !config.populate && typeof opts === 'object') {
    opts.targetModel = undefined;
  }

  if (config.outputPath) {
    let temps = result;
    if (!Array.isArray(result)) {
      temps = [result];
    }
    for (const temp of temps) {
      _.set(temp, config.outputPath, await this.prepareOutput(_.get(temp, config.outputPath), opts));
    }
  } else {
    result = await this.prepareOutput(result, config);
  }
}
```

### Skip the output checkRights on inner calls (replaces lines 238-250)

```typescript
// Check output rights
// Skip on nested calls — the outermost process() and CheckSecurityInterceptor
// perform the final output rights check on the complete response.
if (!isNested && config.checkRights && (await this.checkRights(undefined, config.currentUser as any, config))) {
  const opts: any = {
    dbObject: config.dbObject,
    processType: ProcessType.OUTPUT,
    roles: config.roles,
    throwError: false,
  };
  if (config.outputType) {
    opts.metatype = config.outputType;
  }
  result = await this.checkRights(result, config.currentUser as any, opts);
}
```

### Security

**Ensured by three layers:**

1. **The input checkRights ALWAYS runs** (also when `isNested`) — unauthorized input is caught on every level.
2. **The output checkRights runs at depth 0** — the outermost call filters the final result.
3. **CheckSecurityInterceptor** — the last safety net in the HTTP response pipeline calls `securityCheck()`
   recursively on the whole response tree, including every nested object.

**Counter-check:** What happens when an inner service returns an object the user may not see?

- The inner `process()` skips the output rights check → the object stays unchanged.
- The outer `process()` runs the output rights check → the fields are removed.
- If the outer `process()` misses it as well → `CheckSecurityInterceptor` removes the fields.

### Compatibility

Checked against real cascades:

- **A five-level create cascade** (a company with its profile sites, categories, entries and forms): the inner creates
  need no populate — their results are only used for their ids.
- **A participation service calling `UserService.create()`**: the result is used inline, not returned to the user.
- **A shipping service calling bounce and e-mail services**: no populate needed on inner levels.
- **Services with an explicit `populate:`** keep working, because `config.populate` overrides the `isNested` skip.

---

## Change 5: Caching of the checkRestricted metadata

### File: `src/core/common/decorators/restricted.decorator.ts`

### Problem

`getRestricted()` (lines 50-58) called `Reflect.getMetadata()` for every property check. For an object with 15
properties and nested objects, this adds up to hundreds of Reflect lookups per request. The metadata never changes at
runtime (decorators are static).

### Code before (lines 50-58)

```typescript
export const getRestricted = (object: unknown, propertyKey?: string): RestrictedType => {
  if (!object) {
    return null;
  }
  if (!propertyKey) {
    return Reflect.getMetadata(restrictedMetaKey, object);
  }
  return Reflect.getMetadata(restrictedMetaKey, object, propertyKey);
};
```

### New code

```typescript
// Cache for Restricted metadata — decorators are static, metadata never changes at runtime.
// Map<CacheTarget, Map<propertyKey | '__class__', RestrictedType>>
//
// CacheTarget is the class constructor (for instances) or the class itself (when object IS a constructor).
// This distinction is critical: getRestricted(data.constructor) passes a class as `object`,
// and (classFunction).constructor === Function for ALL classes — so we must use the class itself.
const restrictedMetadataCache = new Map<unknown, Map<string, RestrictedType>>();

export const getRestricted = (object: unknown, propertyKey?: string): RestrictedType => {
  if (!object) {
    return null;
  }

  // Determine cache target: use the class constructor for instances, the object itself for classes.
  // When object IS a constructor (typeof === 'function'), using object.constructor would give Function
  // for ALL classes, causing cache collisions.
  const cacheTarget = typeof object === 'function' ? object : (object as any).constructor;
  if (!cacheTarget) {
    // Fallback for objects without constructor (e.g. Object.create(null))
    return propertyKey
      ? Reflect.getMetadata(restrictedMetaKey, object, propertyKey)
      : Reflect.getMetadata(restrictedMetaKey, object);
  }

  // Cache lookup
  let classCache = restrictedMetadataCache.get(cacheTarget);
  if (!classCache) {
    classCache = new Map();
    restrictedMetadataCache.set(cacheTarget, classCache);
  }

  const cacheKey = propertyKey || '__class__';
  if (classCache.has(cacheKey)) {
    return classCache.get(cacheKey);
  }

  // Cache miss: perform Reflect lookup and cache the result
  const metadata = propertyKey
    ? Reflect.getMetadata(restrictedMetaKey, object, propertyKey)
    : Reflect.getMetadata(restrictedMetaKey, object);

  classCache.set(cacheKey, metadata);
  return metadata;
};
```

### Additionally: _.uniq() optimization in checkRestricted (line 260)

```typescript
// Before:
const concatenatedRestrictions = config.mergeRoles ? _.uniq(objectRestrictions.concat(restricted)) : restricted;

// Optimized — avoids an array allocation when objectRestrictions is empty:
const concatenatedRestrictions = config.mergeRoles && objectRestrictions.length
  ? _.uniq(objectRestrictions.concat(restricted))
  : restricted;
```

This line runs for **every property of every object**. When `objectRestrictions` is empty (common for models without
a class-level `@Restricted`), it saves one array allocation and one `uniq` computation per property.

### Security

**Not affected** — same results, because decorator metadata does not change at runtime. The cache returns exactly the
values of the direct Reflect lookup.

### Compatibility

Transparent — no project needs to be adapted.

---

## Summary of the savings

### Single API call (depth 0, no nesting)

| Change | Saving |
|--------|--------|
| No JSON.stringify | ~0.1-1 KB + 2 serializations |
| Lean dbObject instead of this.get() | ~5-15 KB + 1 recursive process() run |
| Metadata cache | CPU: hundreds of Reflect lookups fewer |

### Nested call (depth > 0)

| Step | Before | After |
|------|--------|-------|
| JSON.stringify | 2 serializations | Skipped |
| prepareInput | Runs | Runs (unchanged) |
| this.get(dbObject) | Recursive process() | Lean query + map |
| checkRights(input) | Runs | Runs (unchanged) |
| serviceFunc | Runs | Runs (unchanged) |
| processFieldSelection | Full population | Skipped (unless populate is explicit) |
| prepareOutput | Full mapping | Secret removal only |
| checkRights(output) | Runs | Skipped |

**Per nested call: ~30-70 KB and 2-5 database queries fewer.**

### Example: an 8-level service cascade (e.g. incident handling)

- Before: 8 × ~50 KB = ~400 KB
- After: 1 × ~50 KB (outer) + 7 × ~10 KB (inner) = ~120 KB
- **~70% less memory**

---

## Affected files

| File | Change |
|------|--------|
| `src/core/common/services/module.service.ts` | Changes 1, 2, 4 |
| `src/core/common/services/request-context.service.ts` | Change 3 |
| `src/core/common/decorators/restricted.decorator.ts` | Change 5 |
| `src/core/common/interfaces/server-options.interface.ts` | Config option `debugProcessInput` |

---

## Verification

1. **Existing E2E tests** must all stay green — the changes are backward compatible.
2. **Test a service cascade**: e.g. a `create()` that calls other services internally.
3. **Populate on the outermost level**: `{ populate: ['user', 'customer'] }` must keep working.
4. **securityCheck()**: sensitive fields (password etc.) must never appear in the response.
5. **S_CREATOR check**: the user who created an object must still be able to edit it.
6. **Performance**: measure `process.memoryUsage()` before and after the optimization for nested calls.

---

## Risks

| Risk | Safeguard |
|------|-----------|
| An inner service needs the populate result | `config.populate` overrides the `isNested` skip — an explicit request is respected |
| The output rights check on the inner result is missing | `CheckSecurityInterceptor` is the safety net on the HTTP level |
| The metadata cache becomes stale | Impossible — decorator metadata is fixed when the classes are defined |
| The lean `dbObject` has a different structure than a hydrated one | `modelConstructor.map()` restores the expected structure |
