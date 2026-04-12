/**
 * UnifiedField Enum — full HTTP-pipeline coverage
 *
 * Purpose: validate that enum-typed UnifiedFields behave correctly when
 * exercised end-to-end via the real Nest validation pipeline (`ValidationPipe`),
 * not just via direct `validateSync()` calls. Unit-level validation can hide
 * subtle differences between class-validator behavior and Nest's transform +
 * pipe stack — the imo bug we fixed (`status?: PartnerStatusEnum` rejected as
 * "must be an object") only manifested through real HTTP requests.
 *
 * Test surface:
 * - long form `enum: { enum: MyEnum }`
 * - shortcut form `enum: MyEnum`
 * - required vs optional fields
 * - string enums, numeric enums, const-object enums
 * - array fields with `each: true`
 * - escape hatches (`isAny`, custom `validator`)
 * - the original imo regression scenario as a named guard
 *
 * Setup is intentionally minimal: a single Nest app with one controller and
 * a `ValidationPipe`, no database, no auth, no GraphQL bootstrap. This keeps
 * the test focused on the validation pipeline.
 */
import 'reflect-metadata';

import { Body, Controller, INestApplication, Module, Post, ValidationPipe } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { UnifiedField } from '../src/core/common/decorators/unified-field.decorator';

// =============================================================================
// Test enums
// =============================================================================

enum ApiStringEnum {
  DRAFT = 'draft',
  PUBLISHED = 'published',
  REVIEW = 'review',
}

enum ApiNumericEnum {
  HIGH = 30,
  LOW = 10,
  MEDIUM = 20,
}

const ApiConstEnum = {
  EAST: 'east',
  NORTH: 'north',
  SOUTH: 'south',
  WEST: 'west',
} as const;
type ApiConstEnum = (typeof ApiConstEnum)[keyof typeof ApiConstEnum];

// =============================================================================
// Test inputs — every variant of enum field UnifiedField supports
// =============================================================================

/** Long form, optional. The exact shape that caused the imo bug. */
class LongFormOptionalInput {
  @UnifiedField({
    description: 'long-form optional',
    enum: { enum: ApiStringEnum },
    isOptional: true,
  })
  status?: ApiStringEnum;
}

/** Long form, required. */
class LongFormRequiredInput {
  @UnifiedField({
    description: 'long-form required',
    enum: { enum: ApiStringEnum },
  })
  status: ApiStringEnum = undefined;
}

/** Shortcut form, optional. */
class ShortcutOptionalInput {
  @UnifiedField({
    description: 'shortcut optional',
    enum: ApiStringEnum,
    isOptional: true,
  })
  status?: ApiStringEnum;
}

/** Shortcut form, required. */
class ShortcutRequiredInput {
  @UnifiedField({
    description: 'shortcut required',
    enum: ApiStringEnum,
  })
  status: ApiStringEnum = undefined;
}

/** Numeric enum, optional, shortcut form. */
class NumericEnumInput {
  @UnifiedField({
    description: 'numeric enum',
    enum: ApiNumericEnum,
    isOptional: true,
  })
  priority?: ApiNumericEnum;
}

/** Const-object enum, optional, shortcut form. */
class ConstEnumInput {
  @UnifiedField({
    description: 'const enum',
    enum: ApiConstEnum,
    isOptional: true,
  })
  direction?: ApiConstEnum;
}

/** Array field with per-element enum validation. */
class ArrayEnumInput {
  @UnifiedField({
    description: 'array of states',
    enum: { enum: ApiStringEnum, options: { each: true } },
    isArray: true,
    isOptional: true,
    type: () => ApiStringEnum,
  })
  states?: ApiStringEnum[];
}

/** isAny escape hatch — must accept anything. */
class IsAnyInput {
  @UnifiedField({
    description: 'any',
    enum: ApiStringEnum,
    isAny: true,
    isOptional: true,
  })
  status?: any;
}

/** Custom validator opt-out — built-ins (incl. IsEnum) must be replaced. */
class CustomValidatorInput {
  @UnifiedField({
    description: 'custom validator',
    enum: ApiStringEnum,
    isOptional: true,
    validator: () => [],
  })
  status?: any;
}

// =============================================================================
// Test controller — one POST endpoint per input
// =============================================================================

@Controller('enum-test')
class EnumTestController {
  @Post('long-form-optional')
  longFormOptional(@Body() body: LongFormOptionalInput) {
    return body;
  }

  @Post('long-form-required')
  longFormRequired(@Body() body: LongFormRequiredInput) {
    return body;
  }

  @Post('shortcut-optional')
  shortcutOptional(@Body() body: ShortcutOptionalInput) {
    return body;
  }

  @Post('shortcut-required')
  shortcutRequired(@Body() body: ShortcutRequiredInput) {
    return body;
  }

  @Post('numeric')
  numeric(@Body() body: NumericEnumInput) {
    return body;
  }

  @Post('const')
  constEnum(@Body() body: ConstEnumInput) {
    return body;
  }

  @Post('array')
  arrayEnum(@Body() body: ArrayEnumInput) {
    return body;
  }

  @Post('is-any')
  isAny(@Body() body: IsAnyInput) {
    return body;
  }

  @Post('custom-validator')
  customValidator(@Body() body: CustomValidatorInput) {
    return body;
  }
}

@Module({ controllers: [EnumTestController] })
class EnumTestApiModule {}

// =============================================================================
// Test suite
// =============================================================================

describe('UnifiedField enum — full HTTP pipeline', () => {
  let app: INestApplication;

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({ imports: [EnumTestApiModule] }).compile();
    app = moduleRef.createNestApplication({ logger: false });
    app.useGlobalPipes(new ValidationPipe({ forbidNonWhitelisted: false, transform: true, whitelist: true }));
    await app.init();
  });

  afterAll(async () => {
    if (app) await app.close();
  });

  // ---------------------------------------------------------------------------
  // Long form, optional — the imo regression scenario
  // ---------------------------------------------------------------------------
  describe('long form, optional field', () => {
    it('should accept a valid string-enum value', async () => {
      const res = await request(app.getHttpServer()).post('/enum-test/long-form-optional').send({ status: 'draft' });
      expect(res.status).toBe(201);
      expect(res.body.status).toBe('draft');
    });

    it('should accept omission', async () => {
      const res = await request(app.getHttpServer()).post('/enum-test/long-form-optional').send({});
      expect(res.status).toBe(201);
    });

    it('should reject an invalid string with isEnum (not isObject)', async () => {
      const res = await request(app.getHttpServer()).post('/enum-test/long-form-optional').send({ status: 'wat' });
      expect(res.status).toBe(400);
      const errorMsg = JSON.stringify(res.body);
      expect(errorMsg).toMatch(/status/);
      // Positive guard: the rejection must come from IsEnum, not IsObject.
      expect(errorMsg).toMatch(/must be one of the following values/);
      // Critical regression guard: must NOT be the spurious "must be an object" message.
      expect(errorMsg).not.toMatch(/must be an object/);
    });
  });

  // ---------------------------------------------------------------------------
  // Long form, required
  // ---------------------------------------------------------------------------
  describe('long form, required field', () => {
    it('should accept a valid value', async () => {
      const res = await request(app.getHttpServer())
        .post('/enum-test/long-form-required')
        .send({ status: 'published' });
      expect(res.status).toBe(201);
      expect(res.body.status).toBe('published');
    });

    it('should reject a missing value', async () => {
      const res = await request(app.getHttpServer()).post('/enum-test/long-form-required').send({});
      expect(res.status).toBe(400);
    });

    it('should reject an invalid value', async () => {
      const res = await request(app.getHttpServer())
        .post('/enum-test/long-form-required')
        .send({ status: 'archived' });
      expect(res.status).toBe(400);
      expect(JSON.stringify(res.body)).not.toMatch(/must be an object/);
    });
  });

  // ---------------------------------------------------------------------------
  // Shortcut form
  // ---------------------------------------------------------------------------
  describe('shortcut form (enum: MyEnum)', () => {
    it('should accept a valid value on optional shortcut field', async () => {
      const res = await request(app.getHttpServer()).post('/enum-test/shortcut-optional').send({ status: 'review' });
      expect(res.status).toBe(201);
      expect(res.body.status).toBe('review');
    });

    it('should accept a valid value on required shortcut field', async () => {
      const res = await request(app.getHttpServer()).post('/enum-test/shortcut-required').send({ status: 'draft' });
      expect(res.status).toBe(201);
    });

    it('should reject an invalid value on optional shortcut field with isEnum', async () => {
      const res = await request(app.getHttpServer()).post('/enum-test/shortcut-optional').send({ status: 'bogus' });
      expect(res.status).toBe(400);
      expect(JSON.stringify(res.body)).not.toMatch(/must be an object/);
    });

    it('should reject a missing value on required shortcut field', async () => {
      const res = await request(app.getHttpServer()).post('/enum-test/shortcut-required').send({});
      expect(res.status).toBe(400);
    });
  });

  // ---------------------------------------------------------------------------
  // Numeric enums
  // ---------------------------------------------------------------------------
  describe('numeric enum', () => {
    it('should accept a valid numeric value', async () => {
      const res = await request(app.getHttpServer()).post('/enum-test/numeric').send({ priority: 20 });
      expect(res.status).toBe(201);
      expect(res.body.priority).toBe(20);
    });

    it('should accept omission', async () => {
      const res = await request(app.getHttpServer()).post('/enum-test/numeric').send({});
      expect(res.status).toBe(201);
    });

    it('should reject an out-of-range numeric value', async () => {
      const res = await request(app.getHttpServer()).post('/enum-test/numeric').send({ priority: 999 });
      expect(res.status).toBe(400);
    });

    it('should reject a string when the enum is numeric', async () => {
      const res = await request(app.getHttpServer()).post('/enum-test/numeric').send({ priority: 'high' });
      expect(res.status).toBe(400);
    });
  });

  // ---------------------------------------------------------------------------
  // Const-object enums (REST-only style)
  // ---------------------------------------------------------------------------
  describe('const-object enum', () => {
    it('should accept a valid const-enum value', async () => {
      const res = await request(app.getHttpServer()).post('/enum-test/const').send({ direction: 'east' });
      expect(res.status).toBe(201);
      expect(res.body.direction).toBe('east');
    });

    it('should reject an unknown const-enum value', async () => {
      const res = await request(app.getHttpServer()).post('/enum-test/const').send({ direction: 'up' });
      expect(res.status).toBe(400);
      expect(JSON.stringify(res.body)).not.toMatch(/must be an object/);
    });
  });

  // ---------------------------------------------------------------------------
  // Array enum field with each: true
  // ---------------------------------------------------------------------------
  describe('array enum field', () => {
    it('should accept an array of valid enum members', async () => {
      const res = await request(app.getHttpServer()).post('/enum-test/array').send({ states: ['draft', 'review'] });
      expect(res.status).toBe(201);
      expect(res.body.states).toEqual(['draft', 'review']);
    });

    it('should accept an empty array', async () => {
      const res = await request(app.getHttpServer()).post('/enum-test/array').send({ states: [] });
      expect(res.status).toBe(201);
    });

    it('should reject an array with one invalid member', async () => {
      const res = await request(app.getHttpServer()).post('/enum-test/array').send({ states: ['draft', 'wat'] });
      expect(res.status).toBe(400);
    });

    it('should reject a non-array value', async () => {
      const res = await request(app.getHttpServer()).post('/enum-test/array').send({ states: 'draft' });
      expect(res.status).toBe(400);
    });
  });

  // ---------------------------------------------------------------------------
  // Escape hatches
  // ---------------------------------------------------------------------------
  describe('escape hatches', () => {
    it('isAny should accept any value', async () => {
      const res = await request(app.getHttpServer()).post('/enum-test/is-any').send({ status: 'totally-bogus' });
      expect(res.status).toBe(201);
      expect(res.body.status).toBe('totally-bogus');
    });

    it('custom validator (returns []) should accept any value (built-ins replaced)', async () => {
      const res = await request(app.getHttpServer())
        .post('/enum-test/custom-validator')
        .send({ status: 'whatever' });
      expect(res.status).toBe(201);
      expect(res.body.status).toBe('whatever');
    });
  });

  // ---------------------------------------------------------------------------
  // Original imo regression — explicit, named scenario
  // ---------------------------------------------------------------------------
  describe('regression: imo PartnerStatusEnum scenario', () => {
    it('POST payload with status?: PartnerStatusEnum must round-trip 201', async () => {
      // Reproduces the original imo bug: a UserInput with `status?: PartnerStatusEnum`
      // submitted via REST. Before the fix the request returned 400 with
      // "Validation failed for 1 field: status (isObject) — status must be an object".
      // After the fix it returns 201.
      const res = await request(app.getHttpServer())
        .post('/enum-test/long-form-optional')
        .send({ status: 'published' });

      expect(res.status).toBe(201);
      expect(res.body.status).toBe('published');
      // And the inverse: an invalid value reports IsEnum, not IsObject.
      const bad = await request(app.getHttpServer())
        .post('/enum-test/long-form-optional')
        .send({ status: 'archived' });
      expect(bad.status).toBe(400);
      expect(JSON.stringify(bad.body)).not.toContain('must be an object');
    });
  });
});
