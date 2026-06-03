/**
 * UnifiedField Enum — OpenAPI (Swagger) schema generation
 *
 * Regression guard for the bug where an enum-typed `@UnifiedField` produced a
 * BROKEN, UNNAMED enum reference in the generated OpenAPI document:
 *
 *   "status": { "allOf": [{ "$ref": "#/components/schemas/" }], ... }   // empty name!
 *
 * and never added the enum to `components.schemas`. The empty `$ref` crashes
 * OpenAPI client generators (e.g. @hey-api/openapi-ts:
 * «Missing $ref pointer "#/components/schemas/". Token "" does not exist.»).
 *
 * Root cause: the decorator set `swaggerOpts.type = () => String` ALONGSIDE
 * `enum` + `enumName`. @nestjs/swagger <= 11.2 tolerated it; >= 11.4 emits the
 * broken unnamed ref. The fix drops `type` for enum fields so the enum +
 * enumName drive a proper named schema.
 *
 * These tests inspect the REAL OpenAPI document built by
 * `SwaggerModule.createDocument` — the exact artifact a client generator
 * consumes — so the empty-ref defect cannot reappear unnoticed.
 */
import 'reflect-metadata';

import { Body, Controller, INestApplication, Module, Post } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { DocumentBuilder, SwaggerModule } from '@nestjs/swagger';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { UnifiedField } from '../src/core/common/decorators/unified-field.decorator';
import { registerEnum } from '../src/core/common/helpers/register-enum.helper';

// =============================================================================
// Test enums
// =============================================================================

enum SwaggerStatusEnum {
  DRAFT = 'draft',
  PUBLISHED = 'published',
  REVIEW = 'review',
}

enum SwaggerPriorityEnum {
  HIGH = 30,
  LOW = 10,
  MEDIUM = 20,
}

enum SwaggerTagEnum {
  A = 'a',
  B = 'b',
}

enum SwaggerAutoEnum {
  OFF = 'off',
  ON = 'on',
}

// Long-form deprecated API: `enum: { enum: X, enumName: 'Y' }` — still
// supported for backwards compatibility, emits a deprecation warning at
// decoration time. Must produce a NAMED schema just like the shortcut form.
enum SwaggerLegacyEnum {
  ALPHA = 'alpha',
  BETA = 'beta',
}

// Explicit-disable path: `enumName: null` must produce an INLINE enum (no
// named component schema) but MUST NOT emit an empty `$ref`.
enum SwaggerInlineEnum {
  KEEP = 'keep',
  SKIP = 'skip',
}

// Auto-detection FAILURE path: this enum is intentionally NOT registered and
// has no explicit `enumName`. `getEnumName()` returns undefined, so swagger
// receives `enumName: undefined` and must emit an INLINE enum WITHOUT an
// empty `$ref` (this is the exact crash trigger we are guarding against).
enum SwaggerUnregisteredEnum {
  X = 'x',
  Y = 'y',
}

// Auto-detection path: register the enum (mirrors `registerEnums()` setup) so
// the decorator can resolve its name WITHOUT an explicit `enumName`.
registerEnum(SwaggerAutoEnum, { graphql: false, name: 'SwaggerAutoEnum' });

// =============================================================================
// Test input — every enum variant that must produce a NAMED schema
// =============================================================================

class SwaggerEnumInput {
  // Shortcut form with explicit enumName (the form kit projects use).
  @UnifiedField({ description: 'string enum', enum: SwaggerStatusEnum, enumName: 'SwaggerStatusEnum', isOptional: true })
  status?: SwaggerStatusEnum;

  // Numeric enum with explicit enumName.
  @UnifiedField({ description: 'numeric enum', enum: SwaggerPriorityEnum, enumName: 'SwaggerPriorityEnum', isOptional: true })
  priority?: SwaggerPriorityEnum;

  // Array enum with explicit enumName (array fields must declare their element type).
  @UnifiedField({
    description: 'array enum',
    enum: SwaggerTagEnum,
    enumName: 'SwaggerTagEnum',
    isArray: true,
    isOptional: true,
    type: () => SwaggerTagEnum,
  })
  tags?: SwaggerTagEnum[];

  // No enumName — name resolved via registerEnum auto-detection.
  @UnifiedField({ description: 'auto enum', enum: SwaggerAutoEnum, isOptional: true })
  auto?: SwaggerAutoEnum;

  // Deprecated long-form: `enum: { enum: X, enumName: 'Y' }`.
  // Emits a console.warn but must still produce a NAMED schema.
  @UnifiedField({
    description: 'legacy long-form enum',
    enum: { enum: SwaggerLegacyEnum, enumName: 'SwaggerLegacyEnum' },
    isOptional: true,
  })
  legacy?: SwaggerLegacyEnum;

  // Explicit `enumName: null` — opt out of named schema. Must produce
  // an INLINE enum (no $ref) and NOT emit an empty `$ref`.
  @UnifiedField({ description: 'inline enum', enum: SwaggerInlineEnum, enumName: null, isOptional: true })
  inline?: SwaggerInlineEnum;

  // Unregistered enum without enumName — auto-detection finds nothing.
  // Must NOT crash, must NOT emit an empty `$ref`, schema becomes inline.
  @UnifiedField({ description: 'unregistered enum', enum: SwaggerUnregisteredEnum, isOptional: true })
  unregistered?: SwaggerUnregisteredEnum;
}

@Controller('swagger-enum')
class SwaggerEnumController {
  @Post()
  create(@Body() body: SwaggerEnumInput) {
    return body;
  }
}

@Module({ controllers: [SwaggerEnumController] })
class SwaggerEnumModule {}

// =============================================================================
// Helpers
// =============================================================================

/** Recursively collect every `$ref` string in the document. */
function collectRefs(node: unknown, acc: string[] = []): string[] {
  if (Array.isArray(node)) {
    for (const item of node) collectRefs(item, acc);
  } else if (node && typeof node === 'object') {
    for (const [key, value] of Object.entries(node as Record<string, unknown>)) {
      if (key === '$ref' && typeof value === 'string') acc.push(value);
      else collectRefs(value, acc);
    }
  }
  return acc;
}

/** Resolve the enum schema name a property points at (handles `allOf` + direct `$ref`). */
function refTarget(prop: any): string | undefined {
  const ref: string | undefined = prop?.$ref ?? prop?.allOf?.[0]?.$ref ?? prop?.items?.$ref ?? prop?.items?.allOf?.[0]?.$ref;
  return ref ? ref.replace('#/components/schemas/', '') : undefined;
}

// =============================================================================
// Test suite
// =============================================================================

describe('UnifiedField enum — OpenAPI schema generation', () => {
  let app: INestApplication;
  let document: any;

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({ imports: [SwaggerEnumModule] }).compile();
    app = moduleRef.createNestApplication({ logger: false });
    await app.init();
    const config = new DocumentBuilder().setTitle('enum-spec-test').setVersion('1.0').build();
    document = SwaggerModule.createDocument(app, config);
  });

  afterAll(async () => {
    if (app) await app.close();
  });

  it('produces NO empty/unnamed $ref anywhere in the document (the crash trigger)', () => {
    const refs = collectRefs(document);
    const empty = refs.filter((r) => r.replace(/\/+$/, '').endsWith('schemas') || r === '#/components/schemas/');
    expect(empty).toEqual([]);
  });

  it('registers a named component schema for every enum (string, numeric, array, auto-detected, long-form)', () => {
    const schemas = document.components?.schemas ?? {};
    expect(schemas).toHaveProperty('SwaggerStatusEnum');
    expect(schemas).toHaveProperty('SwaggerPriorityEnum');
    expect(schemas).toHaveProperty('SwaggerTagEnum');
    expect(schemas).toHaveProperty('SwaggerAutoEnum');
    expect(schemas).toHaveProperty('SwaggerLegacyEnum');
  });

  it('the named enum schemas carry the correct values (order-independent)', () => {
    const schemas = document.components.schemas;
    const sortedValues = (name: string) => [...schemas[name].enum].sort();
    expect(sortedValues('SwaggerStatusEnum')).toEqual(['draft', 'published', 'review']);
    expect(sortedValues('SwaggerPriorityEnum')).toEqual([10, 20, 30]);
    expect(sortedValues('SwaggerTagEnum')).toEqual(['a', 'b']);
    expect(sortedValues('SwaggerAutoEnum')).toEqual(['off', 'on']);
    expect(sortedValues('SwaggerLegacyEnum')).toEqual(['alpha', 'beta']);
  });

  it('each named-enum property references its component schema (no inline duplication, no empty ref)', () => {
    const props = document.components.schemas.SwaggerEnumInput.properties;
    expect(refTarget(props.status)).toBe('SwaggerStatusEnum');
    expect(refTarget(props.priority)).toBe('SwaggerPriorityEnum');
    expect(refTarget(props.auto)).toBe('SwaggerAutoEnum');
    expect(refTarget(props.legacy)).toBe('SwaggerLegacyEnum');
    // Array enum: the items reference the named schema.
    expect(props.tags.type).toBe('array');
    expect(refTarget(props.tags)).toBe('SwaggerTagEnum');
  });

  it('opt-out via `enumName: null` produces an INLINE enum (no $ref, no named component)', () => {
    const props = document.components.schemas.SwaggerEnumInput.properties;
    const schemas = document.components.schemas;
    // No named schema is registered for the opted-out enum.
    expect(schemas).not.toHaveProperty('SwaggerInlineEnum');
    // Property carries the enum values inline and has no $ref.
    expect(refTarget(props.inline)).toBeUndefined();
    expect([...(props.inline.enum ?? [])].sort()).toEqual(['keep', 'skip']);
  });

  it('unregistered enum without `enumName` falls back to an INLINE enum WITHOUT an empty $ref', () => {
    const props = document.components.schemas.SwaggerEnumInput.properties;
    const schemas = document.components.schemas;
    // Auto-detection found no name → no named schema is registered.
    expect(schemas).not.toHaveProperty('SwaggerUnregisteredEnum');
    // The crash trigger: an empty `$ref` would have appeared here on the broken path.
    expect(refTarget(props.unregistered)).toBeUndefined();
    expect([...(props.unregistered.enum ?? [])].sort()).toEqual(['x', 'y']);
  });
});
