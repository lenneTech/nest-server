/**
 * Unit Tests: @UnifiedField Input Whitelist
 *
 * Tests the decorator-based input filtering that handles properties
 * not decorated with @UnifiedField via MapAndValidatePipe.
 */

import 'reflect-metadata';

import { BadRequestException } from '@nestjs/common';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  EXCLUDED_FIELD_KEYS,
  FORCE_INCLUDED_FIELD_KEYS,
  getUnifiedFieldKeys,
  UNIFIED_FIELD_KEYS,
  UnifiedField,
} from '../../src/core/common/decorators/unified-field.decorator';

// ─── Test Classes ───

class BaseInput {
  @UnifiedField({ description: 'Name', isOptional: true })
  name?: string;

  @UnifiedField({ description: 'Email', isOptional: true })
  email?: string;
}

class ChildInput extends BaseInput {
  @UnifiedField({ description: 'Age', isOptional: true })
  age?: number;
}

class ChildWithExclude extends BaseInput {
  @UnifiedField({ exclude: true })
  override email?: string;

  @UnifiedField({ description: 'Phone', isOptional: true })
  phone?: string;
}

class GrandchildReEnable extends ChildWithExclude {
  @UnifiedField({ exclude: false, description: 'Email re-enabled', isOptional: true })
  override email?: string;
}

class ChildImplicitOverrideAttempt extends ChildWithExclude {
  @UnifiedField({ description: 'Email implicit', isOptional: true })
  override email?: string;
}

class NoUnifiedFieldClass {
  someProp?: string;
  anotherProp?: number;
}

class RequiredFieldInput {
  @UnifiedField({ description: 'Required name' })
  name: string;

  @UnifiedField({ description: 'Optional note', isOptional: true })
  note?: string;
}

class InputWithPlainNested {
  @UnifiedField({ description: 'Label', isOptional: true })
  label?: string;

  // Plain object without type — no nestedTypeRegistry entry
  @UnifiedField({ description: 'Metadata', isOptional: true })
  metadata?: Record<string, any>;
}

class NestedAddress {
  @UnifiedField({ description: 'Street', isOptional: true })
  street?: string;

  @UnifiedField({ description: 'City', isOptional: true })
  city?: string;
}

class InputWithNested {
  @UnifiedField({ description: 'Name', isOptional: true })
  name?: string;

  @UnifiedField({ description: 'Address', isOptional: true, type: () => NestedAddress })
  address?: NestedAddress;
}

class NestedItem {
  @UnifiedField({ description: 'Item name', isOptional: true })
  itemName?: string;
}

class InputWithNestedArray {
  @UnifiedField({ description: 'Title', isOptional: true })
  title?: string;

  @UnifiedField({ description: 'Items', isOptional: true, isArray: true, type: () => NestedItem })
  items?: NestedItem[];
}

// ─── getUnifiedFieldKeys Tests ───

describe('getUnifiedFieldKeys', () => {
  it('should return all @UnifiedField keys from a class', () => {
    const keys = getUnifiedFieldKeys(BaseInput);
    expect(keys.has('name')).toBe(true);
    expect(keys.has('email')).toBe(true);
    expect(keys.size).toBe(2);
  });

  it('should include inherited keys from parent class', () => {
    const keys = getUnifiedFieldKeys(ChildInput);
    expect(keys.has('name')).toBe(true);
    expect(keys.has('email')).toBe(true);
    expect(keys.has('age')).toBe(true);
    expect(keys.size).toBe(3);
  });

  it('should exclude keys with exclude: true', () => {
    const keys = getUnifiedFieldKeys(ChildWithExclude);
    expect(keys.has('name')).toBe(true);
    expect(keys.has('email')).toBe(false);
    expect(keys.has('phone')).toBe(true);
    expect(keys.size).toBe(2);
  });

  it('should re-enable keys with exclude: false', () => {
    const keys = getUnifiedFieldKeys(GrandchildReEnable);
    expect(keys.has('name')).toBe(true);
    expect(keys.has('email')).toBe(true);
    expect(keys.has('phone')).toBe(true);
    expect(keys.size).toBe(3);
  });

  it('should NOT allow implicit @UnifiedField to override parent exclude: true', () => {
    const keys = getUnifiedFieldKeys(ChildImplicitOverrideAttempt);
    expect(keys.has('name')).toBe(true);
    expect(keys.has('email')).toBe(false);
    expect(keys.has('phone')).toBe(true);
    expect(keys.size).toBe(2);
  });

  it('should return empty set for class without @UnifiedField', () => {
    const keys = getUnifiedFieldKeys(NoUnifiedFieldClass);
    expect(keys.size).toBe(0);
  });
});

// ─── Metadata Registration Tests ───

describe('UnifiedField metadata registration', () => {
  it('should register keys in UNIFIED_FIELD_KEYS', () => {
    const keys: string[] = Reflect.getOwnMetadata(UNIFIED_FIELD_KEYS, BaseInput.prototype) || [];
    expect(keys).toContain('name');
    expect(keys).toContain('email');
  });

  it('should register excluded keys in EXCLUDED_FIELD_KEYS', () => {
    const keys: string[] = Reflect.getOwnMetadata(EXCLUDED_FIELD_KEYS, ChildWithExclude.prototype) || [];
    expect(keys).toContain('email');
  });

  it('should register force-included keys in FORCE_INCLUDED_FIELD_KEYS', () => {
    const keys: string[] = Reflect.getOwnMetadata(FORCE_INCLUDED_FIELD_KEYS, GrandchildReEnable.prototype) || [];
    expect(keys).toContain('email');
  });
});

// ─── MapAndValidatePipe Tests ───

describe('MapAndValidatePipe - strip mode (default)', () => {
  let pipe: any;

  beforeEach(async () => {
    const { ConfigService } = await import('../../src/core/common/services/config.service');
    vi.spyOn(ConfigService, 'getFastButReadOnly').mockReturnValue(true);

    const { MapAndValidatePipe } = await import('../../src/core/common/pipes/map-and-validate.pipe');
    pipe = new MapAndValidatePipe();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('should accept whitelisted properties', async () => {
    const result = await pipe.transform(
      { name: 'John', email: 'john@test.com' },
      { metatype: BaseInput, type: 'body', data: undefined },
    );
    expect(result).toBeDefined();
    expect(result.name).toBe('John');
    expect(result.email).toBe('john@test.com');
  });

  it('should strip non-whitelisted properties silently', async () => {
    const result = await pipe.transform(
      { name: 'John', evilProp: 'hack' },
      { metatype: BaseInput, type: 'body', data: undefined },
    );
    expect(result).toBeDefined();
    expect(result.name).toBe('John');
    expect(result.evilProp).toBeUndefined();
  });

  it('should strip multiple non-whitelisted properties', async () => {
    const result = await pipe.transform(
      { name: 'John', evil1: 'a', evil2: 'b' },
      { metatype: BaseInput, type: 'body', data: undefined },
    );
    expect(result).toBeDefined();
    expect(result.name).toBe('John');
    expect(result.evil1).toBeUndefined();
    expect(result.evil2).toBeUndefined();
  });

  it('should accept inherited properties from parent class', async () => {
    const result = await pipe.transform(
      { name: 'John', email: 'john@test.com', age: 25 },
      { metatype: ChildInput, type: 'body', data: undefined },
    );
    expect(result).toBeDefined();
    expect(result.name).toBe('John');
    expect(result.age).toBe(25);
  });

  it('should strip excluded properties (exclude: true)', async () => {
    const result = await pipe.transform(
      { name: 'John', email: 'john@test.com' },
      { metatype: ChildWithExclude, type: 'body', data: undefined },
    );
    expect(result).toBeDefined();
    expect(result.name).toBe('John');
    expect(result.email).toBeUndefined();
  });

  it('should accept re-enabled properties (exclude: false)', async () => {
    const result = await pipe.transform(
      { name: 'John', email: 'john@test.com', phone: '123' },
      { metatype: GrandchildReEnable, type: 'body', data: undefined },
    );
    expect(result).toBeDefined();
    expect(result.name).toBe('John');
    expect(result.email).toBe('john@test.com');
  });

  it('should skip check for classes without @UnifiedField', async () => {
    const result = await pipe.transform(
      { someProp: 'value', anotherProp: 42, extraProp: 'anything' },
      { metatype: NoUnifiedFieldClass, type: 'body', data: undefined },
    );
    expect(result).toBeDefined();
    expect(result.extraProp).toBe('anything');
  });

  it('should strip non-whitelisted nested properties', async () => {
    const result = await pipe.transform(
      { name: 'John', address: { street: '123 Main', evilNested: 'hack' } },
      { metatype: InputWithNested, type: 'body', data: undefined },
    );
    expect(result).toBeDefined();
    expect(result.address.street).toBe('123 Main');
    expect(result.address.evilNested).toBeUndefined();
  });

  it('should accept valid nested properties', async () => {
    const result = await pipe.transform(
      { name: 'John', address: { street: '123 Main', city: 'Berlin' } },
      { metatype: InputWithNested, type: 'body', data: undefined },
    );
    expect(result).toBeDefined();
    expect(result.address.street).toBe('123 Main');
    expect(result.address.city).toBe('Berlin');
  });

  it('should strip non-whitelisted properties in nested array elements', async () => {
    const result = await pipe.transform(
      { title: 'Test', items: [{ itemName: 'ok' }, { itemName: 'ok', evil: 'hack' }] },
      { metatype: InputWithNestedArray, type: 'body', data: undefined },
    );
    expect(result).toBeDefined();
    expect(result.items[0].itemName).toBe('ok');
    expect(result.items[1].itemName).toBe('ok');
    expect(result.items[1].evil).toBeUndefined();
  });
});

describe('MapAndValidatePipe - error mode', () => {
  let pipe: any;

  beforeEach(async () => {
    const { ConfigService } = await import('../../src/core/common/services/config.service');
    vi.spyOn(ConfigService, 'getFastButReadOnly').mockReturnValue({ nonWhitelistedFields: 'error' });

    const { MapAndValidatePipe } = await import('../../src/core/common/pipes/map-and-validate.pipe');
    pipe = new MapAndValidatePipe();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('should accept whitelisted properties', async () => {
    const result = await pipe.transform(
      { name: 'John', email: 'john@test.com' },
      { metatype: BaseInput, type: 'body', data: undefined },
    );
    expect(result).toBeDefined();
  });

  it('should throw BadRequestException for non-whitelisted properties', async () => {
    await expect(
      pipe.transform(
        { name: 'John', evilProp: 'hack' },
        { metatype: BaseInput, type: 'body', data: undefined },
      ),
    ).rejects.toThrow(BadRequestException);
  });

  it('should include property names in error message', async () => {
    try {
      await pipe.transform(
        { name: 'John', evilProp: 'hack' },
        { metatype: BaseInput, type: 'body', data: undefined },
      );
      expect.fail('Should have thrown');
    } catch (e: any) {
      expect(e).toBeInstanceOf(BadRequestException);
      expect(e.message).toContain('evilProp');
    }
  });

  it('should throw for excluded properties', async () => {
    await expect(
      pipe.transform(
        { name: 'John', email: 'john@test.com' },
        { metatype: ChildWithExclude, type: 'body', data: undefined },
      ),
    ).rejects.toThrow(BadRequestException);
  });

  it('should throw for non-whitelisted nested properties', async () => {
    await expect(
      pipe.transform(
        { name: 'John', address: { street: '123 Main', evilNested: 'hack' } },
        { metatype: InputWithNested, type: 'body', data: undefined },
      ),
    ).rejects.toThrow(BadRequestException);
  });
});

describe('MapAndValidatePipe - disabled mode', () => {
  let pipe: any;

  beforeEach(async () => {
    const { ConfigService } = await import('../../src/core/common/services/config.service');
    vi.spyOn(ConfigService, 'getFastButReadOnly').mockReturnValue({ nonWhitelistedFields: false });

    const { MapAndValidatePipe } = await import('../../src/core/common/pipes/map-and-validate.pipe');
    pipe = new MapAndValidatePipe();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('should allow non-whitelisted properties when disabled', async () => {
    const result = await pipe.transform(
      { name: 'John', evilProp: 'allowed' },
      { metatype: BaseInput, type: 'body', data: undefined },
    );
    expect(result).toBeDefined();
    expect(result.evilProp).toBe('allowed');
  });
});

// ─── Additional Coverage: Edge Cases & Config Variants ───

describe('MapAndValidatePipe - implicit override attempt through pipe', () => {
  let pipe: any;

  beforeEach(async () => {
    const { ConfigService } = await import('../../src/core/common/services/config.service');
    vi.spyOn(ConfigService, 'getFastButReadOnly').mockReturnValue(true);
    const { MapAndValidatePipe } = await import('../../src/core/common/pipes/map-and-validate.pipe');
    pipe = new MapAndValidatePipe();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('should strip email when implicit @UnifiedField cannot override parent exclude: true', async () => {
    const result = await pipe.transform(
      { name: 'John', email: 'john@test.com', phone: '123' },
      { metatype: ChildImplicitOverrideAttempt, type: 'body', data: undefined },
    );
    expect(result).toBeDefined();
    expect(result.name).toBe('John');
    expect(result.phone).toBe('123');
    expect(result.email).toBeUndefined();
  });
});

describe('MapAndValidatePipe - config variants', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('should use strip mode when config is empty object {}', async () => {
    const { ConfigService } = await import('../../src/core/common/services/config.service');
    vi.spyOn(ConfigService, 'getFastButReadOnly').mockReturnValue({});
    const { MapAndValidatePipe } = await import('../../src/core/common/pipes/map-and-validate.pipe');
    const pipe = new MapAndValidatePipe();

    const result = await pipe.transform(
      { name: 'John', evilProp: 'hack' },
      { metatype: BaseInput, type: 'body', data: undefined },
    );
    expect(result).toBeDefined();
    expect(result.name).toBe('John');
    expect(result.evilProp).toBeUndefined();
  });

  it('should use strip mode when config is boolean true', async () => {
    const { ConfigService } = await import('../../src/core/common/services/config.service');
    vi.spyOn(ConfigService, 'getFastButReadOnly').mockReturnValue(true);
    const { MapAndValidatePipe } = await import('../../src/core/common/pipes/map-and-validate.pipe');
    const pipe = new MapAndValidatePipe();

    const result = await pipe.transform(
      { name: 'John', evilProp: 'hack' },
      { metatype: BaseInput, type: 'body', data: undefined },
    );
    expect(result).toBeDefined();
    expect(result.name).toBe('John');
    expect(result.evilProp).toBeUndefined();
  });
});

describe('MapAndValidatePipe - error mode details', () => {
  let pipe: any;

  beforeEach(async () => {
    const { ConfigService } = await import('../../src/core/common/services/config.service');
    vi.spyOn(ConfigService, 'getFastButReadOnly').mockReturnValue({ nonWhitelistedFields: 'error' });
    const { MapAndValidatePipe } = await import('../../src/core/common/pipes/map-and-validate.pipe');
    pipe = new MapAndValidatePipe();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('should include LTNS_0303 ErrorCode in error message', async () => {
    try {
      await pipe.transform(
        { name: 'John', evilProp: 'hack' },
        { metatype: BaseInput, type: 'body', data: undefined },
      );
      expect.fail('Should have thrown');
    } catch (e: any) {
      expect(e).toBeInstanceOf(BadRequestException);
      expect(e.message).toContain('LTNS_0303');
    }
  });

  it('should include nested array path in error message (items[1].evil)', async () => {
    try {
      await pipe.transform(
        { title: 'Test', items: [{ itemName: 'ok' }, { itemName: 'ok', evil: 'hack' }] },
        { metatype: InputWithNestedArray, type: 'body', data: undefined },
      );
      expect.fail('Should have thrown');
    } catch (e: any) {
      expect(e).toBeInstanceOf(BadRequestException);
      expect(e.message).toContain('items[1].evil');
    }
  });
});

describe('MapAndValidatePipe - validation after strip', () => {
  let pipe: any;

  beforeEach(async () => {
    const { ConfigService } = await import('../../src/core/common/services/config.service');
    vi.spyOn(ConfigService, 'getFastButReadOnly').mockReturnValue(true);
    const { MapAndValidatePipe } = await import('../../src/core/common/pipes/map-and-validate.pipe');
    pipe = new MapAndValidatePipe();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('should still validate required fields after stripping extras', async () => {
    // RequiredFieldInput.name is required (no isOptional)
    // Sending only an extra prop without the required field should fail validation
    await expect(
      pipe.transform(
        { evilProp: 'hack' },
        { metatype: RequiredFieldInput, type: 'body', data: undefined },
      ),
    ).rejects.toThrow();
  });

  it('should pass validation when required field is present and extras are stripped', async () => {
    const result = await pipe.transform(
      { name: 'John', evilProp: 'hack' },
      { metatype: RequiredFieldInput, type: 'body', data: undefined },
    );
    expect(result).toBeDefined();
    expect(result.name).toBe('John');
    expect(result.evilProp).toBeUndefined();
  });
});

describe('MapAndValidatePipe - nested without registry entry', () => {
  let pipe: any;

  beforeEach(async () => {
    const { ConfigService } = await import('../../src/core/common/services/config.service');
    vi.spyOn(ConfigService, 'getFastButReadOnly').mockReturnValue(true);
    const { MapAndValidatePipe } = await import('../../src/core/common/pipes/map-and-validate.pipe');
    pipe = new MapAndValidatePipe();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('should not recurse into nested objects without registry entry', async () => {
    // metadata is Record<string, any> — no nestedTypeRegistry entry
    // Inner properties should NOT be checked/stripped
    const result = await pipe.transform(
      { label: 'Test', metadata: { anyKey: 'anyValue', deep: { nested: true } } },
      { metatype: InputWithPlainNested, type: 'body', data: undefined },
    );
    expect(result).toBeDefined();
    expect(result.label).toBe('Test');
    expect(result.metadata.anyKey).toBe('anyValue');
    expect(result.metadata.deep.nested).toBe(true);
  });
});

describe('MapAndValidatePipe - empty body & identity cases', () => {
  let pipe: any;

  beforeEach(async () => {
    const { ConfigService } = await import('../../src/core/common/services/config.service');
    vi.spyOn(ConfigService, 'getFastButReadOnly').mockReturnValue(true);
    const { MapAndValidatePipe } = await import('../../src/core/common/pipes/map-and-validate.pipe');
    pipe = new MapAndValidatePipe();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('should handle empty body without crash', async () => {
    const result = await pipe.transform(
      {},
      { metatype: BaseInput, type: 'body', data: undefined },
    );
    expect(result).toBeDefined();
  });

  it('should not strip when value is already instance of metatype', async () => {
    const instance = new BaseInput();
    instance.name = 'John';
    (instance as any).evilProp = 'attached';

    const result = await pipe.transform(
      instance,
      { metatype: BaseInput, type: 'body', data: undefined },
    );
    expect(result).toBeDefined();
    // When value is already an instance, originalPlainKeys is empty → no strip
    expect((result as any).evilProp).toBe('attached');
  });

  it('should preserve all whitelisted properties and strip only extras', async () => {
    const result = await pipe.transform(
      { name: 'John', email: 'john@test.com', evil1: 'a', evil2: 'b' },
      { metatype: BaseInput, type: 'body', data: undefined },
    );
    expect(result.name).toBe('John');
    expect(result.email).toBe('john@test.com');
    expect(result.evil1).toBeUndefined();
    expect(result.evil2).toBeUndefined();
    // Ensure only whitelisted keys remain
    const keys = Object.keys(result).filter(k => result[k] !== undefined);
    expect(keys).toContain('name');
    expect(keys).toContain('email');
    expect(keys).not.toContain('evil1');
    expect(keys).not.toContain('evil2');
  });
});

// ─── Custom Decorator Parameter Tests (metadata.type === 'custom') ───
// These tests ensure the pipe skips parameters injected by custom decorators
// like @CurrentUser(), which are NOT user input and must not be mutated.

describe('MapAndValidatePipe - custom decorator parameters (e.g. @CurrentUser)', () => {
  let pipe: any;

  beforeEach(async () => {
    const { ConfigService } = await import('../../src/core/common/services/config.service');
    vi.spyOn(ConfigService, 'getFastButReadOnly').mockReturnValue(true);
    const { MapAndValidatePipe } = await import('../../src/core/common/pipes/map-and-validate.pipe');
    pipe = new MapAndValidatePipe();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('should pass through custom parameters without any modification', async () => {
    const customValue = { id: '123', name: 'Test User', extraProp: 'should-remain' };

    const result = await pipe.transform(customValue, {
      metatype: BaseInput,
      type: 'custom',
      data: undefined,
    });

    expect(result).toBe(customValue);
    expect(result.id).toBe('123');
    expect(result.name).toBe('Test User');
    expect(result.extraProp).toBe('should-remain');
  });

  it('should not strip function properties from custom parameters', async () => {
    // This simulates BetterAuthTokenService.createUserWithHasRole() output
    const userWithHasRole = {
      id: '507f1f77bcf86cd799439011',
      email: 'test@example.com',
      roles: ['admin'],
      hasRole: (role: string) => ['admin'].includes(role),
    };

    const result = await pipe.transform(userWithHasRole, {
      metatype: BaseInput,
      type: 'custom',
      data: undefined,
    });

    expect(result).toBe(userWithHasRole);
    expect(typeof result.hasRole).toBe('function');
    expect(result.hasRole('admin')).toBe(true);
    expect(result.hasRole('user')).toBe(false);
  });

  it('should not mutate the original custom parameter object', async () => {
    const original = { id: '123', name: 'Test', nonWhitelisted: 'value' };
    const keysBefore = Object.keys(original);

    await pipe.transform(original, {
      metatype: BaseInput,
      type: 'custom',
      data: undefined,
    });

    const keysAfter = Object.keys(original);
    expect(keysAfter).toEqual(keysBefore);
    expect(original.nonWhitelisted).toBe('value');
  });

  it('should return the exact same reference for custom parameters', async () => {
    const customObj = { id: '123' };

    const result = await pipe.transform(customObj, {
      metatype: BaseInput,
      type: 'custom',
      data: undefined,
    });

    expect(result).toBe(customObj);
  });

  it('should still strip non-whitelisted properties for body parameters', async () => {
    // @Body() with Input DTOs is the primary use case for whitelist stripping
    const result = await pipe.transform(
      { name: 'John', evilProp: 'hack' },
      { metatype: BaseInput, type: 'body', data: undefined },
    );
    expect(result.name).toBe('John');
    expect(result.evilProp).toBeUndefined();
  });

  it('should still strip non-whitelisted properties for query DTOs', async () => {
    // @Query() with DTO classes that use @UnifiedField
    const result = await pipe.transform(
      { name: 'John', evilProp: 'hack' },
      { metatype: BaseInput, type: 'query', data: undefined },
    );
    expect(result.name).toBe('John');
    expect(result.evilProp).toBeUndefined();
  });

  it('should still strip non-whitelisted properties for param DTOs', async () => {
    // @Param() with DTO classes that use @UnifiedField
    const result = await pipe.transform(
      { name: 'John', evilProp: 'hack' },
      { metatype: BaseInput, type: 'param', data: undefined },
    );
    expect(result.name).toBe('John');
    expect(result.evilProp).toBeUndefined();
  });

  it('should skip basic types like string for param parameters', async () => {
    // @Param('id') id: string — pipe returns early for basic types
    const result = await pipe.transform('507f1f77bcf86cd799439011', {
      metatype: String,
      type: 'param',
      data: 'id',
    });
    expect(result).toBe('507f1f77bcf86cd799439011');
  });

  it('should skip basic types like number for query parameters', async () => {
    // @Query('limit') limit: number — pipe returns early for basic types
    const result = await pipe.transform(10, {
      metatype: Number,
      type: 'query',
      data: 'limit',
    });
    expect(result).toBe(10);
  });

  it('should skip Object metatype and pass through all properties', async () => {
    // @Body() body: object — Object is a basic type, pipe returns early
    const input = { anything: 'goes', nested: { deep: true }, fn: () => 42 };

    const result = await pipe.transform(input, {
      metatype: Object,
      type: 'body',
      data: undefined,
    });

    expect(result).toBe(input);
    expect(result.anything).toBe('goes');
    expect(result.nested.deep).toBe(true);
    expect(typeof result.fn).toBe('function');
  });

  it('should process custom and body parameters independently in sequence', async () => {
    // Simulates a real controller: @CurrentUser() user + @Body() input
    // The custom parameter must survive even after body is processed
    const currentUser = {
      id: '507f1f77bcf86cd799439011',
      email: 'admin@test.com',
      hasRole: (role: string) => role === 'admin',
    };

    // First: pipe processes @CurrentUser() (type: 'custom')
    const userResult = await pipe.transform(currentUser, {
      metatype: BaseInput,
      type: 'custom',
      data: undefined,
    });

    // Second: pipe processes @Body() (type: 'body')
    const bodyResult = await pipe.transform(
      { name: 'New User', evilProp: 'hack' },
      { metatype: BaseInput, type: 'body', data: undefined },
    );

    // Custom parameter unchanged
    expect(userResult).toBe(currentUser);
    expect(typeof userResult.hasRole).toBe('function');
    expect(userResult.hasRole('admin')).toBe(true);

    // Body correctly stripped
    expect(bodyResult.name).toBe('New User');
    expect(bodyResult.evilProp).toBeUndefined();
  });
});

describe('MapAndValidatePipe - custom parameters in error mode', () => {
  let pipe: any;

  beforeEach(async () => {
    const { ConfigService } = await import('../../src/core/common/services/config.service');
    vi.spyOn(ConfigService, 'getFastButReadOnly').mockReturnValue({ nonWhitelistedFields: 'error' });
    const { MapAndValidatePipe } = await import('../../src/core/common/pipes/map-and-validate.pipe');
    pipe = new MapAndValidatePipe();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('should not throw for custom parameters even with non-whitelisted properties', async () => {
    const customValue = { id: '123', nonWhitelisted: 'value', hasRole: () => true };

    const result = await pipe.transform(customValue, {
      metatype: BaseInput,
      type: 'custom',
      data: undefined,
    });

    expect(result).toBe(customValue);
    expect(typeof result.hasRole).toBe('function');
  });

  it('should still throw for body parameters with non-whitelisted properties', async () => {
    await expect(
      pipe.transform(
        { name: 'John', evilProp: 'hack' },
        { metatype: BaseInput, type: 'body', data: undefined },
      ),
    ).rejects.toThrow();
  });
});
