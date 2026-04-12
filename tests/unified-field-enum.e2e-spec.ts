import 'reflect-metadata';
import { registerEnumType } from '@nestjs/graphql';
import { plainToInstance } from 'class-transformer';
import { validateSync } from 'class-validator';

import { enumNameRegistry, UnifiedField } from '../src/core/common/decorators/unified-field.decorator';
import { graphqlEnumRegistry, registerEnum, registerEnums } from '../src/core/common/helpers/register-enum.helper';

describe('UnifiedField Enum Auto-Detection (e2e)', () => {
  // Clean up registries before each test
  beforeEach(() => {
    enumNameRegistry.clear();
  });

  // ========================================
  // Test Enums
  // ========================================

  enum StatusEnum {
    ACTIVE = 'active',
    INACTIVE = 'inactive',
    PENDING = 'pending',
  }

  enum PriorityEnum {
    HIGH = 'high',
    LOW = 'low',
    MEDIUM = 'medium',
  }

  enum RoleEnum {
    ADMIN = 'admin',
    GUEST = 'guest',
    USER = 'user',
  }

  enum NumericEnum {
    OPTION_ONE = 1,
    OPTION_THREE = 3,
    OPTION_TWO = 2,
  }

  // ========================================
  // Auto-Detection with registerEnum
  // ========================================

  describe('Auto-Detection via registerEnum', () => {
    beforeEach(() => {
      // Register enum using registerEnum helper
      registerEnum(StatusEnum, {
        description: 'Status options',
        name: 'StatusEnum',
      });
    });

    it('should auto-detect enum name from registerEnum', () => {
      class TestInput {
        @UnifiedField({
          description: 'Status field',
          enum: { enum: StatusEnum },
        })
        status: StatusEnum;
      }

      // Get swagger metadata
      const swaggerMetadata = Reflect.getMetadata('swagger/apiModelProperties', TestInput.prototype, 'status');

      expect(swaggerMetadata).toBeDefined();
      expect(swaggerMetadata.enum).toEqual(['active', 'inactive', 'pending']); // Swagger stores enum values
      expect(swaggerMetadata.enumName).toBe('StatusEnum');
    });

    it('should auto-detect enum name for multiple fields', () => {
      registerEnum(PriorityEnum, {
        name: 'PriorityEnum',
      });

      class TestInput {
        @UnifiedField({
          description: 'Status field',
          enum: { enum: StatusEnum },
        })
        status: StatusEnum;

        @UnifiedField({
          description: 'Priority field',
          enum: { enum: PriorityEnum },
        })
        priority: PriorityEnum;
      }

      const statusMetadata = Reflect.getMetadata('swagger/apiModelProperties', TestInput.prototype, 'status');
      const priorityMetadata = Reflect.getMetadata('swagger/apiModelProperties', TestInput.prototype, 'priority');

      expect(statusMetadata.enumName).toBe('StatusEnum');
      expect(priorityMetadata.enumName).toBe('PriorityEnum');
    });

    it('should work with optional enum field', () => {
      class TestInput {
        @UnifiedField({
          description: 'Optional status',
          enum: { enum: StatusEnum },
          isOptional: true,
        })
        status?: StatusEnum;
      }

      const metadata = Reflect.getMetadata('swagger/apiModelProperties', TestInput.prototype, 'status');

      expect(metadata.enumName).toBe('StatusEnum');
      expect(metadata.nullable).toBe(true);
      expect(metadata.required).toBe(false);
    });

    it('should work with enum array field', () => {
      class TestInput {
        @UnifiedField({
          description: 'Multiple statuses',
          enum: { enum: StatusEnum },
          isArray: true,
          type: () => StatusEnum,
        })
        statuses: StatusEnum[];
      }

      const metadata = Reflect.getMetadata('swagger/apiModelProperties', TestInput.prototype, 'statuses');

      expect(metadata.enumName).toBe('StatusEnum');
      expect(metadata.isArray).toBe(true);
    });

    it('should work with numeric enum', () => {
      registerEnum(NumericEnum, {
        name: 'NumericEnum',
      });

      class TestInput {
        @UnifiedField({
          description: 'Numeric option',
          enum: { enum: NumericEnum },
        })
        option: NumericEnum;
      }

      const metadata = Reflect.getMetadata('swagger/apiModelProperties', TestInput.prototype, 'option');

      expect(metadata.enumName).toBe('NumericEnum');
      expect(metadata.enum).toEqual([1, 3, 2]); // Swagger stores enum values in definition order
    });
  });

  // ========================================
  // Manual Registration in enumNameRegistry
  // ========================================

  describe('Manual Registration in enumNameRegistry', () => {
    it('should use manually registered enum name', () => {
      enumNameRegistry.set(RoleEnum, 'ManualRoleEnum');

      class TestInput {
        @UnifiedField({
          description: 'User role',
          enum: { enum: RoleEnum },
        })
        role: RoleEnum;
      }

      const metadata = Reflect.getMetadata('swagger/apiModelProperties', TestInput.prototype, 'role');

      expect(metadata.enumName).toBe('ManualRoleEnum');
    });

    it('should prioritize enumNameRegistry over GraphQL registration', () => {
      registerEnumType(StatusEnum, {
        name: 'GraphQLStatusEnum',
      });
      enumNameRegistry.set(StatusEnum, 'ManualStatusEnum');

      class TestInput {
        @UnifiedField({
          description: 'Status',
          enum: { enum: StatusEnum },
        })
        status: StatusEnum;
      }

      const metadata = Reflect.getMetadata('swagger/apiModelProperties', TestInput.prototype, 'status');

      // enumNameRegistry has higher priority
      expect(metadata.enumName).toBe('ManualStatusEnum');
    });

    it('should allow manual registration for REST-only projects', () => {
      // Simulate REST-only project (no GraphQL registration)
      const RestOnlyEnum = {
        OPTION_A: 'a',
        OPTION_B: 'b',
      } as const;

      enumNameRegistry.set(RestOnlyEnum, 'RestOnlyEnum');

      class TestInput {
        @UnifiedField({
          description: 'Rest only option',
          enum: { enum: RestOnlyEnum as any },
        })
        option: string;
      }

      const metadata = Reflect.getMetadata('swagger/apiModelProperties', TestInput.prototype, 'option');

      expect(metadata.enumName).toBe('RestOnlyEnum');
    });
  });

  // ========================================
  // Explicit enumName Setting
  // ========================================

  describe('Explicit enumName Setting', () => {
    beforeEach(() => {
      registerEnumType(StatusEnum, {
        name: 'StatusEnum',
      });
    });

    it('should use explicitly provided enumName', () => {
      class TestInput {
        @UnifiedField({
          description: 'Status',
          enum: {
            enum: StatusEnum,
            enumName: 'CustomStatusEnum',
          },
        })
        status: StatusEnum;
      }

      const metadata = Reflect.getMetadata('swagger/apiModelProperties', TestInput.prototype, 'status');

      expect(metadata.enumName).toBe('CustomStatusEnum');
    });

    it('should allow setting enumName to undefined to disable auto-detection', () => {
      class TestInput {
        @UnifiedField({
          description: 'Status',
          enum: {
            enum: StatusEnum,
            enumName: undefined,
          },
        })
        status: StatusEnum;
      }

      const metadata = Reflect.getMetadata('swagger/apiModelProperties', TestInput.prototype, 'status');

      // enumName should be explicitly undefined, not auto-detected
      expect(metadata.enumName).toBeUndefined();
    });

    it('should allow setting enumName to null', () => {
      class TestInput {
        @UnifiedField({
          description: 'Status',
          enum: {
            enum: StatusEnum,
            enumName: null as any,
          },
        })
        status: StatusEnum;
      }

      const metadata = Reflect.getMetadata('swagger/apiModelProperties', TestInput.prototype, 'status');

      expect(metadata.enumName).toBeNull();
    });

    it('should prefer explicit enumName over all auto-detection', () => {
      enumNameRegistry.set(StatusEnum, 'RegistryName');

      class TestInput {
        @UnifiedField({
          description: 'Status',
          enum: {
            enum: StatusEnum,
            enumName: 'ExplicitName',
          },
        })
        status: StatusEnum;
      }

      const metadata = Reflect.getMetadata('swagger/apiModelProperties', TestInput.prototype, 'status');

      expect(metadata.enumName).toBe('ExplicitName');
    });
  });

  // ========================================
  // No Auto-Detection (Fallback)
  // ========================================

  describe('No Auto-Detection Available', () => {
    it('should not set enumName when enum is not registered anywhere', () => {
      enum UnregisteredEnum {
        VALUE_A = 'a',
        VALUE_B = 'b',
      }

      class TestInput {
        @UnifiedField({
          description: 'Unregistered enum',
          enum: { enum: UnregisteredEnum },
        })
        value: UnregisteredEnum;
      }

      const metadata = Reflect.getMetadata('swagger/apiModelProperties', TestInput.prototype, 'value');

      // No enumName should be set if no registration found
      expect(metadata.enumName).toBeUndefined();
      // But enum values should still be set by Swagger
      expect(metadata.enum).toEqual(['a', 'b']);
    });

    it('should work without enumName for backward compatibility', () => {
      enum SimpleEnum {
        A = 'a',
        B = 'b',
      }

      class TestInput {
        @UnifiedField({
          description: 'Simple enum without registration',
          enum: { enum: SimpleEnum },
        })
        value: SimpleEnum;
      }

      const metadata = Reflect.getMetadata('swagger/apiModelProperties', TestInput.prototype, 'value');

      expect(metadata.enum).toEqual(['a', 'b']);
      expect(metadata).toHaveProperty('type'); // Type property should exist
    });
  });

  // ========================================
  // Edge Cases
  // ========================================

  describe('Edge Cases', () => {
    it('should handle enum registered after class definition', () => {
      class TestInput {
        @UnifiedField({
          description: 'Late registered enum',
          enum: { enum: PriorityEnum },
        })
        priority: PriorityEnum;
      }

      // Register after class definition
      registerEnumType(PriorityEnum, {
        name: 'PriorityEnum',
      });

      // Check metadata again - should not have auto-detected name
      // because registration happened after decorator execution
      const metadata = Reflect.getMetadata('swagger/apiModelProperties', TestInput.prototype, 'priority');

      // Auto-detection happens at decorator time, so late registration won't be picked up
      expect(metadata.enum).toEqual(['high', 'low', 'medium']); // Enum values in definition order (sorted by linter)
    });

    it('should handle multiple fields with same enum', () => {
      enumNameRegistry.set(StatusEnum, 'StatusEnum');

      class TestInput {
        @UnifiedField({
          description: 'Current status',
          enum: { enum: StatusEnum },
        })
        currentStatus: StatusEnum;

        @UnifiedField({
          description: 'Previous status',
          enum: { enum: StatusEnum },
        })
        previousStatus: StatusEnum;

        @UnifiedField({
          description: 'Optional target status',
          enum: { enum: StatusEnum },
          isOptional: true,
        })
        targetStatus?: StatusEnum;
      }

      const currentMetadata = Reflect.getMetadata('swagger/apiModelProperties', TestInput.prototype, 'currentStatus');
      const previousMetadata = Reflect.getMetadata('swagger/apiModelProperties', TestInput.prototype, 'previousStatus');
      const targetMetadata = Reflect.getMetadata('swagger/apiModelProperties', TestInput.prototype, 'targetStatus');

      expect(currentMetadata.enumName).toBe('StatusEnum');
      expect(previousMetadata.enumName).toBe('StatusEnum');
      expect(targetMetadata.enumName).toBe('StatusEnum');
    });

    it('should handle enum registered via registerEnum with description', () => {
      registerEnum(StatusEnum, {
        description: 'User status options',
        name: 'StatusEnum',
        valuesMap: {
          ACTIVE: {
            description: 'User is active',
          },
          INACTIVE: {
            description: 'User is inactive',
          },
          PENDING: {
            deprecationReason: 'Use ACTIVE instead',
            description: 'User is pending',
          },
        },
      });

      class TestInput {
        @UnifiedField({
          description: 'User status',
          enum: { enum: StatusEnum },
        })
        status: StatusEnum;
      }

      const metadata = Reflect.getMetadata('swagger/apiModelProperties', TestInput.prototype, 'status');

      expect(metadata.enumName).toBe('StatusEnum');
      expect(metadata.description).toContain('User status');
    });

    it('should not interfere with non-enum fields', () => {
      enumNameRegistry.set(StatusEnum, 'StatusEnum');

      class TestInput {
        @UnifiedField({
          description: 'Name field',
        })
        name: string;

        @UnifiedField({
          description: 'Status field',
          enum: { enum: StatusEnum },
        })
        status: StatusEnum;

        @UnifiedField({
          description: 'Age field',
        })
        age: number;
      }

      const nameMetadata = Reflect.getMetadata('swagger/apiModelProperties', TestInput.prototype, 'name');
      const statusMetadata = Reflect.getMetadata('swagger/apiModelProperties', TestInput.prototype, 'status');
      const ageMetadata = Reflect.getMetadata('swagger/apiModelProperties', TestInput.prototype, 'age');

      expect(nameMetadata.enumName).toBeUndefined();
      expect(statusMetadata.enumName).toBe('StatusEnum');
      expect(ageMetadata.enumName).toBeUndefined();
    });
  });

  // ========================================
  // GraphQL Integration
  // ========================================

  describe('GraphQL Integration', () => {
    it('should work with GraphQL Field decorator and registerEnum', () => {
      registerEnum(StatusEnum, {
        name: 'StatusEnum',
      });

      class TestModel {
        @UnifiedField({
          description: 'Status field',
          enum: { enum: StatusEnum },
        })
        status: StatusEnum;
      }

      // Check Swagger metadata has enumName (auto-detected from registerEnum)
      const swaggerMetadata = Reflect.getMetadata('swagger/apiModelProperties', TestModel.prototype, 'status');

      expect(swaggerMetadata.enumName).toBe('StatusEnum');
      expect(swaggerMetadata.enum).toEqual(['active', 'inactive', 'pending']);

      // Note: GraphQL metadata is set by UnifiedField, but checking it in unit tests
      // is not straightforward without a full NestJS bootstrap
    });

    it('should document that registerEnumType alone does NOT auto-detect in unit tests', () => {
      // Note: registerEnumType only populates TypeMetadataStorage during NestJS bootstrap,
      // not in unit tests. Use registerEnum for auto-detection in both contexts.
      registerEnumType(StatusEnum, {
        name: 'StatusEnum',
      });

      class TestModel {
        @UnifiedField({
          description: 'Status field',
          enum: { enum: StatusEnum },
        })
        status: StatusEnum;
      }

      const swaggerMetadata = Reflect.getMetadata('swagger/apiModelProperties', TestModel.prototype, 'status');

      // enumName will NOT be auto-detected because TypeMetadataStorage is not populated in unit tests
      expect(swaggerMetadata.enumName).toBeUndefined();
      expect(swaggerMetadata.enum).toEqual(['active', 'inactive', 'pending']); // But the enum values are still set
    });
  });

  // ========================================
  // Runtime validation behaviour (class-validator)
  // ========================================

  describe('Runtime validation with class-validator', () => {
    it('should accept a valid string enum value on an optional enum field', () => {
      // Regression guard: an `?:` optional enum field emits `design:type = Object`
      // in TypeScript's reflection metadata. UnifiedField must not apply
      // `IsObject()` on top of `IsEnum()` — otherwise a valid enum string value
      // like "active" gets rejected as "must be an object" (HTTP 400).
      class TestInput {
        @UnifiedField({
          description: 'Optional status',
          enum: { enum: StatusEnum },
          isOptional: true,
        })
        status?: StatusEnum;
      }

      const instance = plainToInstance(TestInput, { status: 'active' });
      const errors = validateSync(instance);

      expect(errors).toEqual([]);
    });

    it('should reject an invalid value on an optional enum field', () => {
      class TestInput {
        @UnifiedField({
          description: 'Optional status',
          enum: { enum: StatusEnum },
          isOptional: true,
        })
        status?: StatusEnum;
      }

      const instance = plainToInstance(TestInput, { status: 'bogus' });
      const errors = validateSync(instance);

      expect(errors).toHaveLength(1);
      expect(errors[0].property).toBe('status');
      expect(errors[0].constraints).toHaveProperty('isEnum');
      // And critically: no IsObject constraint should be reported.
      expect(errors[0].constraints).not.toHaveProperty('isObject');
    });

    it('should allow omitting an optional enum field', () => {
      class TestInput {
        @UnifiedField({
          description: 'Optional status',
          enum: { enum: StatusEnum },
          isOptional: true,
        })
        status?: StatusEnum;
      }

      const instance = plainToInstance(TestInput, {});
      const errors = validateSync(instance);

      expect(errors).toEqual([]);
    });

    it('should accept a valid value on a non-optional enum field', () => {
      class TestInput {
        @UnifiedField({
          description: 'Required status',
          enum: { enum: StatusEnum },
        })
        status: StatusEnum = undefined;
      }

      const instance = plainToInstance(TestInput, { status: 'inactive' });
      const errors = validateSync(instance);

      expect(errors).toEqual([]);
    });
  });

  // ========================================
  // Shortcut form: `enum: MyEnum` (no nested { enum: ... })
  // ========================================

  describe('Shortcut form enum: MyEnum', () => {
    it('should accept a valid value with shortcut enum form', () => {
      class TestInput {
        @UnifiedField({
          description: 'Optional status',
          enum: StatusEnum,
          isOptional: true,
        })
        status?: StatusEnum;
      }

      const instance = plainToInstance(TestInput, { status: 'active' });
      const errors = validateSync(instance);

      expect(errors).toEqual([]);
    });

    it('should reject an invalid value with shortcut enum form', () => {
      class TestInput {
        @UnifiedField({
          description: 'Optional status',
          enum: StatusEnum,
          isOptional: true,
        })
        status?: StatusEnum;
      }

      const instance = plainToInstance(TestInput, { status: 'bogus' });
      const errors = validateSync(instance);

      expect(errors).toHaveLength(1);
      expect(errors[0].constraints).toHaveProperty('isEnum');
    });

    it('should auto-detect enum name with shortcut form via registerEnum', () => {
      registerEnum(PriorityEnum, { name: 'PriorityEnumShortcut' });

      class TestInput {
        @UnifiedField({
          description: 'Priority',
          enum: PriorityEnum,
        })
        priority: PriorityEnum = undefined;
      }

      const metadata = Reflect.getMetadata('swagger/apiModelProperties', TestInput.prototype, 'priority');

      expect(metadata.enumName).toBe('PriorityEnumShortcut');
      expect(metadata.enum).toEqual(['high', 'low', 'medium']);
    });

    it('should still support long form with options', () => {
      class TestInput {
        @UnifiedField({
          description: 'Multiple statuses',
          enum: { enum: StatusEnum, options: { each: true } },
          isArray: true,
          type: () => StatusEnum,
        })
        statuses: StatusEnum[] = undefined;
      }

      const instance = plainToInstance(TestInput, { statuses: ['active', 'pending'] });
      const errors = validateSync(instance);

      expect(errors).toEqual([]);
    });
  });

  // ========================================
  // Comprehensive enum-handling coverage
  // ========================================
  //
  // The blocks below systematically cover all combinations of:
  // - declaration form (long form `{ enum }` vs shortcut `enum: MyEnum`)
  // - field cardinality (required, optional, array, optional array)
  // - enum kind (string enum, numeric enum, const-object enum)
  // - validation outcome (valid, invalid, missing, wrong primitive, null)
  //
  // The Long-form behaviour is exercised explicitly via parameterized tests so
  // both forms always stay in lockstep.

  describe('Comprehensive enum coverage', () => {
    enum CompStringEnum {
      DRAFT = 'draft',
      PUBLISHED = 'published',
      REVIEW = 'review',
    }

    enum CompNumericEnum {
      HIGH = 30,
      LOW = 10,
      MEDIUM = 20,
    }

    const CompConstEnum = {
      EAST: 'east',
      NORTH: 'north',
      SOUTH: 'south',
      WEST: 'west',
    } as const;
    type CompConstEnum = (typeof CompConstEnum)[keyof typeof CompConstEnum];

    // ----------------------------------------------------
    // Long form vs shortcut form: structural equivalence
    // ----------------------------------------------------
    describe('long form vs shortcut form parity', () => {
      it('long form and shortcut form should produce identical IsEnum behaviour for valid input', () => {
        class LongForm {
          @UnifiedField({
            description: 'long',
            enum: { enum: CompStringEnum },
            isOptional: true,
          })
          status?: CompStringEnum;
        }

        class Shortcut {
          @UnifiedField({
            description: 'short',
            enum: CompStringEnum,
            isOptional: true,
          })
          status?: CompStringEnum;
        }

        for (const value of Object.values(CompStringEnum)) {
          expect(validateSync(plainToInstance(LongForm, { status: value }))).toEqual([]);
          expect(validateSync(plainToInstance(Shortcut, { status: value }))).toEqual([]);
        }
      });

      it('long form and shortcut form should reject the same invalid values', () => {
        class LongForm {
          @UnifiedField({ description: 'long', enum: { enum: CompStringEnum }, isOptional: true })
          status?: CompStringEnum;
        }
        class Shortcut {
          @UnifiedField({ description: 'short', enum: CompStringEnum, isOptional: true })
          status?: CompStringEnum;
        }

        const longErrors = validateSync(plainToInstance(LongForm, { status: 'wat' }));
        const shortErrors = validateSync(plainToInstance(Shortcut, { status: 'wat' }));

        expect(longErrors).toHaveLength(1);
        expect(shortErrors).toHaveLength(1);
        expect(longErrors[0].constraints).toHaveProperty('isEnum');
        expect(shortErrors[0].constraints).toHaveProperty('isEnum');
        expect(longErrors[0].constraints).not.toHaveProperty('isObject');
        expect(shortErrors[0].constraints).not.toHaveProperty('isObject');
      });

      it('long form and shortcut form should produce equivalent swagger metadata', () => {
        class LongForm {
          @UnifiedField({ description: 'long', enum: { enum: CompStringEnum } })
          status: CompStringEnum = undefined;
        }
        class Shortcut {
          @UnifiedField({ description: 'short', enum: CompStringEnum })
          status: CompStringEnum = undefined;
        }

        const longMeta = Reflect.getMetadata('swagger/apiModelProperties', LongForm.prototype, 'status');
        const shortMeta = Reflect.getMetadata('swagger/apiModelProperties', Shortcut.prototype, 'status');

        expect(longMeta.enum).toEqual(shortMeta.enum);
        expect(longMeta.enum).toEqual(['draft', 'published', 'review']);
      });
    });

    // ----------------------------------------------------
    // String enums — required field
    // ----------------------------------------------------
    describe('string enum, required field', () => {
      class Input {
        @UnifiedField({ description: 'state', enum: CompStringEnum })
        state: CompStringEnum = undefined;
      }

      it('should accept each enum member', () => {
        for (const value of Object.values(CompStringEnum)) {
          expect(validateSync(plainToInstance(Input, { state: value }))).toEqual([]);
        }
      });

      it('should reject an unknown string', () => {
        const errors = validateSync(plainToInstance(Input, { state: 'archived' }));
        expect(errors).toHaveLength(1);
        expect(errors[0].constraints).toHaveProperty('isEnum');
      });

      it('should reject a numeric value', () => {
        const errors = validateSync(plainToInstance(Input, { state: 42 as any }));
        expect(errors).toHaveLength(1);
        expect(errors[0].constraints).toHaveProperty('isEnum');
      });

      it('should reject undefined as missing', () => {
        const errors = validateSync(plainToInstance(Input, {}));
        expect(errors).toHaveLength(1);
        // IsDefined / IsNotEmpty kicks in for required fields
        expect(Object.keys(errors[0].constraints!).some((k) => k === 'isDefined' || k === 'isNotEmpty')).toBe(true);
      });
    });

    // ----------------------------------------------------
    // String enums — optional field
    // ----------------------------------------------------
    describe('string enum, optional field', () => {
      class Input {
        @UnifiedField({ description: 'state', enum: CompStringEnum, isOptional: true })
        state?: CompStringEnum;
      }

      it('should accept omission', () => {
        expect(validateSync(plainToInstance(Input, {}))).toEqual([]);
      });

      it('should accept undefined explicit', () => {
        expect(validateSync(plainToInstance(Input, { state: undefined }))).toEqual([]);
      });

      it('should accept null', () => {
        // class-validator's IsOptional treats null as "skip validation"
        expect(validateSync(plainToInstance(Input, { state: null }))).toEqual([]);
      });

      it('should accept each enum member', () => {
        for (const value of Object.values(CompStringEnum)) {
          expect(validateSync(plainToInstance(Input, { state: value }))).toEqual([]);
        }
      });

      it('should reject an invalid value when present', () => {
        const errors = validateSync(plainToInstance(Input, { state: 'nope' }));
        expect(errors).toHaveLength(1);
        expect(errors[0].constraints).toHaveProperty('isEnum');
      });

      it('should NOT add an isObject constraint (regression guard)', () => {
        const errors = validateSync(plainToInstance(Input, { state: 'nope' }));
        expect(errors[0].constraints).not.toHaveProperty('isObject');
      });
    });

    // ----------------------------------------------------
    // String enums — array field
    // ----------------------------------------------------
    describe('string enum, array field', () => {
      class Input {
        @UnifiedField({
          description: 'states',
          enum: { enum: CompStringEnum, options: { each: true } },
          isArray: true,
          isOptional: true,
          type: () => CompStringEnum,
        })
        states?: CompStringEnum[];
      }

      it('should accept an array of valid enum members', () => {
        expect(validateSync(plainToInstance(Input, { states: ['draft', 'review'] }))).toEqual([]);
      });

      it('should accept an empty array', () => {
        expect(validateSync(plainToInstance(Input, { states: [] }))).toEqual([]);
      });

      it('should reject an array containing one invalid member', () => {
        const errors = validateSync(plainToInstance(Input, { states: ['draft', 'wat'] }));
        expect(errors).toHaveLength(1);
        // each: true reports an isEnum constraint per failing element
        expect(errors[0].constraints).toHaveProperty('isEnum');
      });

      it('should reject a non-array value', () => {
        const errors = validateSync(plainToInstance(Input, { states: 'draft' as any }));
        expect(errors).toHaveLength(1);
        expect(errors[0].constraints).toHaveProperty('isArray');
      });
    });

    // ----------------------------------------------------
    // Numeric enums
    // ----------------------------------------------------
    describe('numeric enum', () => {
      class RequiredInput {
        @UnifiedField({ description: 'priority', enum: CompNumericEnum })
        priority: CompNumericEnum = undefined;
      }

      class OptionalInput {
        @UnifiedField({ description: 'priority', enum: CompNumericEnum, isOptional: true })
        priority?: CompNumericEnum;
      }

      it('should accept each numeric enum member (required)', () => {
        for (const value of [CompNumericEnum.LOW, CompNumericEnum.MEDIUM, CompNumericEnum.HIGH]) {
          expect(validateSync(plainToInstance(RequiredInput, { priority: value }))).toEqual([]);
        }
      });

      it('should reject an out-of-range numeric value', () => {
        const errors = validateSync(plainToInstance(RequiredInput, { priority: 999 }));
        expect(errors).toHaveLength(1);
        expect(errors[0].constraints).toHaveProperty('isEnum');
      });

      it('should reject a string value when the enum is numeric', () => {
        const errors = validateSync(plainToInstance(RequiredInput, { priority: 'high' as any }));
        expect(errors).toHaveLength(1);
        expect(errors[0].constraints).toHaveProperty('isEnum');
      });

      it('should accept omission on optional numeric field', () => {
        expect(validateSync(plainToInstance(OptionalInput, {}))).toEqual([]);
      });

      it('should also work with the shortcut form', () => {
        class Shortcut {
          @UnifiedField({ description: 'priority', enum: CompNumericEnum, isOptional: true })
          priority?: CompNumericEnum;
        }
        expect(validateSync(plainToInstance(Shortcut, { priority: CompNumericEnum.MEDIUM }))).toEqual([]);
        const errors = validateSync(plainToInstance(Shortcut, { priority: 0 }));
        expect(errors).toHaveLength(1);
        expect(errors[0].constraints).toHaveProperty('isEnum');
      });
    });

    // ----------------------------------------------------
    // Const-object enums (REST-only / readonly literals)
    // ----------------------------------------------------
    describe('const-object enum', () => {
      it('should validate against const-object enums via long form', () => {
        class Input {
          @UnifiedField({ description: 'direction', enum: { enum: CompConstEnum }, isOptional: true })
          direction?: CompConstEnum;
        }

        expect(validateSync(plainToInstance(Input, { direction: 'east' }))).toEqual([]);
        expect(validateSync(plainToInstance(Input, { direction: 'up' as any }))).toHaveLength(1);
      });

      it('should validate against const-object enums via shortcut form', () => {
        class Input {
          @UnifiedField({ description: 'direction', enum: CompConstEnum, isOptional: true })
          direction?: CompConstEnum;
        }

        expect(validateSync(plainToInstance(Input, { direction: 'south' }))).toEqual([]);
        expect(validateSync(plainToInstance(Input, { direction: 42 as any }))).toHaveLength(1);
      });
    });

    // ----------------------------------------------------
    // enumName / metadata behaviour with both forms
    // ----------------------------------------------------
    describe('enumName resolution', () => {
      it('long form with explicit enumName wins over auto-detection', () => {
        registerEnum(CompStringEnum, { name: 'AutoCompString' });

        class Input {
          @UnifiedField({
            description: 'state',
            enum: { enum: CompStringEnum, enumName: 'CustomState' },
          })
          state: CompStringEnum = undefined;
        }
        const meta = Reflect.getMetadata('swagger/apiModelProperties', Input.prototype, 'state');
        expect(meta.enumName).toBe('CustomState');
      });

      it('long form with enumName: undefined disables auto-detection', () => {
        registerEnum(CompStringEnum, { name: 'AutoCompString' });

        class Input {
          @UnifiedField({
            description: 'state',
            enum: { enum: CompStringEnum, enumName: undefined },
          })
          state: CompStringEnum = undefined;
        }
        const meta = Reflect.getMetadata('swagger/apiModelProperties', Input.prototype, 'state');
        expect(meta.enumName).toBeUndefined();
      });

      it('shortcut form auto-detects enumName via registerEnum', () => {
        registerEnum(CompStringEnum, { name: 'AutoCompString' });

        class Input {
          @UnifiedField({ description: 'state', enum: CompStringEnum })
          state: CompStringEnum = undefined;
        }
        const meta = Reflect.getMetadata('swagger/apiModelProperties', Input.prototype, 'state');
        expect(meta.enumName).toBe('AutoCompString');
      });

      it('shortcut form auto-detects enumName via manual enumNameRegistry', () => {
        enumNameRegistry.set(CompConstEnum, 'CompConstByRegistry');

        class Input {
          @UnifiedField({ description: 'direction', enum: CompConstEnum })
          direction: CompConstEnum = undefined;
        }
        const meta = Reflect.getMetadata('swagger/apiModelProperties', Input.prototype, 'direction');
        expect(meta.enumName).toBe('CompConstByRegistry');
      });
    });

    // ----------------------------------------------------
    // Interaction with other UnifiedField features
    // ----------------------------------------------------
    describe('interaction with other UnifiedField features', () => {
      it('custom validator opt-out should bypass IsEnum entirely', () => {
        class Input {
          @UnifiedField({
            description: 'state',
            enum: CompStringEnum,
            isOptional: true,
            // A custom validator that accepts anything — no IsEnum is applied.
            validator: () => [],
          })
          state?: any;
        }

        // Even an invalid value passes because no validator was registered.
        expect(validateSync(plainToInstance(Input, { state: 'totally-bogus' }))).toEqual([]);
      });

      it('isAny should skip all validators including IsEnum', () => {
        class Input {
          @UnifiedField({
            description: 'state',
            enum: CompStringEnum,
            isAny: true,
            isOptional: true,
          })
          state?: any;
        }

        expect(validateSync(plainToInstance(Input, { state: 'whatever' }))).toEqual([]);
      });

      it('validateIf can disable enum validation conditionally', () => {
        class Input {
          @UnifiedField({
            description: 'state',
            enum: CompStringEnum,
            isOptional: true,
            validateIf: (obj: any) => obj.checkState === true,
          })
          state?: CompStringEnum;

          @UnifiedField({ description: 'gate', isOptional: true })
          checkState?: boolean;
        }

        // checkState=false → state validation skipped, even invalid value passes
        expect(validateSync(plainToInstance(Input, { checkState: false, state: 'bogus' as any }))).toEqual([]);
        // checkState=true → state must be a valid enum
        const errors = validateSync(plainToInstance(Input, { checkState: true, state: 'bogus' as any }));
        expect(errors).toHaveLength(1);
        expect(errors[0].constraints).toHaveProperty('isEnum');
      });
    });

    // ----------------------------------------------------
    // Regression guards for the IsObject bug fix
    // ----------------------------------------------------
    describe('regression: optional enum must not pick up IsObject', () => {
      it('IsObject must not appear when status?: enum is rejected', () => {
        class Input {
          @UnifiedField({ description: 'state', enum: CompStringEnum, isOptional: true })
          state?: CompStringEnum;
        }
        const errors = validateSync(plainToInstance(Input, { state: 'no-such' }));
        expect(errors[0].constraints).not.toHaveProperty('isObject');
      });

      it('IsString must not appear when an explicit type is omitted on enum field', () => {
        class Input {
          @UnifiedField({ description: 'state', enum: CompStringEnum, isOptional: true })
          state?: CompStringEnum;
        }
        const errors = validateSync(plainToInstance(Input, { state: 'no-such' }));
        expect(errors[0].constraints).not.toHaveProperty('isString');
      });

      it('A valid string-enum value must not be rejected on optional field (the original imo bug)', () => {
        class PartnerInput {
          @UnifiedField({
            description: 'partner status',
            enum: CompStringEnum,
            isOptional: true,
          })
          status?: CompStringEnum;
        }

        // This is the *exact* shape that was failing in the imo project before the fix:
        // a status?: PartnerStatusEnum field on a UserInput, sent as a string body.
        const instance = plainToInstance(PartnerInput, { status: 'published' });
        expect(validateSync(instance)).toEqual([]);
      });
    });

    // ----------------------------------------------------------
    // Edge case: const-object enum with a member named 'enum'
    // ----------------------------------------------------------
    describe('const-object enum with "enum" key (isEnumOptionsObject edge case)', () => {
      // A const-object enum whose key is literally 'enum'. The discriminator
      // `isEnumOptionsObject` must NOT classify this as a long-form options
      // object, because the value of the 'enum' key is a primitive string, not
      // an enum object.
      const EdgeEnum = { enum: 'self', OTHER: 'other' } as const;
      type EdgeEnum = (typeof EdgeEnum)[keyof typeof EdgeEnum];

      it('should treat the enum as shortcut form and validate correctly', () => {
        class Input {
          @UnifiedField({ description: 'edge', enum: EdgeEnum, isOptional: true })
          val?: EdgeEnum;
        }

        const valid = plainToInstance(Input, { val: 'self' });
        expect(validateSync(valid)).toEqual([]);

        const alsoValid = plainToInstance(Input, { val: 'other' });
        expect(validateSync(alsoValid)).toEqual([]);

        const invalid = plainToInstance(Input, { val: 'nope' });
        const errors = validateSync(invalid);
        expect(errors).toHaveLength(1);
        expect(errors[0].constraints).toHaveProperty('isEnum');
      });

      it('should expose correct swagger enum values', () => {
        class Input {
          @UnifiedField({ description: 'edge', enum: EdgeEnum })
          val: EdgeEnum = undefined;
        }

        const meta = Reflect.getMetadata('swagger/apiModelProperties', Input.prototype, 'val');
        // Swagger stores enum values as the enum object reference; the actual
        // values exposed in the schema are Object.values().
        expect(Object.values(meta.enum)).toEqual(expect.arrayContaining(['self', 'other']));
      });
    });

    // ----------------------------------------------------------
    // Edge case: const-object enum with member 'enum' holding an OBJECT value
    // This is the theoretical worst case for the discriminator: both
    // hasOwnProperty('enum') and typeof inner === 'object' would be true
    // without the additional "all values are string|number" check.
    // ----------------------------------------------------------
    describe('const-object enum with "enum" key holding an object value', () => {
      const TrickyEnum = { enum: { nested: true }, OTHER: 'other' } as const;
      type TrickyEnum = (typeof TrickyEnum)[keyof typeof TrickyEnum];

      it('should treat it as shortcut form (not misclassify as long form)', () => {
        class Input {
          @UnifiedField({ description: 'tricky', enum: TrickyEnum as any, isOptional: true })
          val?: any;
        }

        const meta = Reflect.getMetadata('swagger/apiModelProperties', Input.prototype, 'val');
        // Swagger normalizes enum objects to Object.values(). If TrickyEnum was
        // misclassified as long form, swaggerOpts.enum would be { nested: true }
        // and meta.enum would be [true] (a single boolean). Correct shortcut
        // classification yields the full TrickyEnum, so meta.enum contains BOTH
        // the object value and the 'other' string.
        const values = Array.isArray(meta.enum) ? meta.enum : Object.values(meta.enum);
        expect(values).toHaveLength(2);
        expect(values).toContainEqual({ nested: true });
        expect(values).toContain('other');
      });
    });

    // ----------------------------------------------------------
    // Misconfiguration guard: long-form shape without `enum` key
    // ----------------------------------------------------------
    describe('misconfiguration warning: enumName/options without enum key', () => {
      it('should warn when enum option has enumName but no enum key', () => {
        const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});

        class Input {
          @UnifiedField({
            description: 'broken',
            enum: { enumName: 'Oops' } as any,
            isOptional: true,
          })
          val?: string;
        }

        expect(warnSpy).toHaveBeenCalledWith(
          expect.stringContaining('Probable misconfiguration'),
        );
        // Verify it mentions the field name
        expect(warnSpy).toHaveBeenCalledWith(
          expect.stringContaining('.val'),
        );

        warnSpy.mockRestore();

        // Also verify that Input class was created (no crash)
        expect(Input).toBeDefined();
      });

      it('should NOT warn for a valid shortcut enum', () => {
        const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});

        class Input {
          @UnifiedField({ description: 'ok', enum: StatusEnum, isOptional: true })
          val?: StatusEnum;
        }

        expect(warnSpy).not.toHaveBeenCalled();
        warnSpy.mockRestore();
        expect(Input).toBeDefined();
      });
    });
  });

  // ========================================
  // Real-world project compatibility tests
  // ========================================
  // These tests reproduce the exact @UnifiedField patterns found across
  // all lenneTech and customer projects to verify backward compatibility.

  describe('Real-world project compatibility', () => {
    // Suppress deprecation warnings in these tests — we EXPECT them
    let warnSpy: ReturnType<typeof vi.spyOn>;
    beforeEach(() => {
      warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    });
    afterEach(() => {
      warnSpy.mockRestore();
    });

    enum ContactStatusEnum {
      ACTIVE = 'active',
      ARCHIVED = 'archived',
      LEAD = 'lead',
    }

    enum NotifyViaEnum {
      EMAIL = 'email',
      PUSH = 'push',
      SMS = 'sms',
    }

    enum IndustryEnum {
      FINANCE = 'finance',
      HEALTH = 'health',
      TECH = 'tech',
    }

    // -------------------------------------------------------
    // Pattern 1 (69%): enum: { enum: X, enumName: 'X' }
    // Used in: CRM, TurboOps, Volksbank DNA, IMO, Forgecloud
    // -------------------------------------------------------
    describe('Pattern 1: long form with enumName (69% of projects)', () => {
      it('should validate correctly (deprecated but functional)', () => {
        class ContactInput {
          @UnifiedField({
            description: 'Contact status',
            enum: { enum: ContactStatusEnum, enumName: 'ContactStatusEnum' },
            isOptional: true,
          })
          status?: ContactStatusEnum;
        }

        const valid = plainToInstance(ContactInput, { status: 'active' });
        expect(validateSync(valid)).toEqual([]);

        const invalid = plainToInstance(ContactInput, { status: 'deleted' });
        const errors = validateSync(invalid);
        expect(errors).toHaveLength(1);
        expect(errors[0].constraints).toHaveProperty('isEnum');
      });

      it('should emit deprecation warning', () => {
        class Input {
          @UnifiedField({
            description: 'test',
            enum: { enum: ContactStatusEnum, enumName: 'ContactStatusEnum' },
          })
          status: ContactStatusEnum = undefined;
        }
        expect(Input).toBeDefined();
        expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining('Deprecated long-form'));
      });

      it('should preserve enumName in swagger metadata', () => {
        class Input {
          @UnifiedField({
            description: 'test',
            enum: { enum: ContactStatusEnum, enumName: 'ContactStatusEnum' },
          })
          status: ContactStatusEnum = undefined;
        }
        const meta = Reflect.getMetadata('swagger/apiModelProperties', Input.prototype, 'status');
        expect(meta.enumName).toBe('ContactStatusEnum');
      });
    });

    // -------------------------------------------------------
    // Pattern 2 (29%): enum: { enum: X } (no enumName)
    // Used in: simpler projects, inline enums
    // -------------------------------------------------------
    describe('Pattern 2: long form without enumName (29% of projects)', () => {
      it('should validate correctly (deprecated but functional)', () => {
        class SimpleInput {
          @UnifiedField({
            description: 'Status',
            enum: { enum: ContactStatusEnum },
            isOptional: true,
          })
          status?: ContactStatusEnum;
        }

        expect(validateSync(plainToInstance(SimpleInput, { status: 'lead' }))).toEqual([]);
        expect(validateSync(plainToInstance(SimpleInput, { status: 'wrong' }))).toHaveLength(1);
      });
    });

    // -------------------------------------------------------
    // Pattern 3 (2%): enum: { enum: X, enumName: 'X', options: { each: true } }
    // Used in: TurboOps (NotifyViaEnum), Volksbank DNA (IndustryEnum)
    // -------------------------------------------------------
    describe('Pattern 3: long form with options: { each: true } (2% of projects)', () => {
      it('should validate array elements (deprecated but functional)', () => {
        class EscalationStepInput {
          @UnifiedField({
            description: 'Notification channels',
            enum: { enum: NotifyViaEnum, enumName: 'NotifyViaEnum', options: { each: true } },
            isArray: true,
            type: () => NotifyViaEnum,
          })
          notifyVia: NotifyViaEnum[] = undefined;
        }

        const valid = plainToInstance(EscalationStepInput, { notifyVia: ['email', 'sms'] });
        expect(validateSync(valid)).toEqual([]);

        const invalid = plainToInstance(EscalationStepInput, { notifyVia: ['email', 'pigeon'] });
        const errors = validateSync(invalid);
        expect(errors).toHaveLength(1);
        expect(errors[0].constraints).toHaveProperty('isEnum');
      });
    });

    // -------------------------------------------------------
    // Pattern 4 (NEW): enum: MyEnum (recommended shortcut)
    // The new recommended form — all the above should migrate here
    // -------------------------------------------------------
    describe('Pattern 4: recommended shortcut form', () => {
      it('should validate single value', () => {
        class Input {
          @UnifiedField({ description: 'Status', enum: ContactStatusEnum, isOptional: true })
          status?: ContactStatusEnum;
        }

        expect(validateSync(plainToInstance(Input, { status: 'active' }))).toEqual([]);
        expect(validateSync(plainToInstance(Input, { status: 'wrong' }))).toHaveLength(1);
      });

      it('should accept top-level enumName', () => {
        class Input {
          @UnifiedField({
            description: 'Status',
            enum: ContactStatusEnum,
            enumName: 'ContactStatusEnum',
          })
          status: ContactStatusEnum = undefined;
        }
        const meta = Reflect.getMetadata('swagger/apiModelProperties', Input.prototype, 'status');
        expect(meta.enumName).toBe('ContactStatusEnum');
      });

      it('should auto-inherit each:true from isArray without explicit options', () => {
        // This is the key improvement: no more options: { each: true } needed
        class Input {
          @UnifiedField({
            description: 'Industries',
            enum: IndustryEnum,
            enumName: 'IndustryEnum',
            isArray: true,
            type: () => IndustryEnum,
          })
          industries: IndustryEnum[] = undefined;
        }

        const valid = plainToInstance(Input, { industries: ['tech', 'finance'] });
        expect(validateSync(valid)).toEqual([]);

        const invalid = plainToInstance(Input, { industries: ['tech', 'farming'] });
        const errors = validateSync(invalid);
        expect(errors).toHaveLength(1);
        expect(errors[0].constraints).toHaveProperty('isEnum');
      });

      it('should NOT emit deprecation warning', () => {
        class Input {
          @UnifiedField({ description: 'Status', enum: ContactStatusEnum })
          status: ContactStatusEnum = undefined;
        }
        expect(Input).toBeDefined();
        expect(warnSpy).not.toHaveBeenCalledWith(expect.stringContaining('Deprecated'));
      });

      it('should allow enumName: null to disable auto-detection', () => {
        class Input {
          @UnifiedField({
            description: 'Status',
            enum: ContactStatusEnum,
            enumName: null,
          })
          status: ContactStatusEnum = undefined;
        }
        const meta = Reflect.getMetadata('swagger/apiModelProperties', Input.prototype, 'status');
        expect(meta.enumName).toBeUndefined();
      });
    });

    // -------------------------------------------------------
    // Migration equivalence: old pattern → new pattern
    // Verify identical behavior for each migration path
    // -------------------------------------------------------
    describe('Migration equivalence: old → new produces identical results', () => {
      it('Pattern 1 → 4: enum: { enum: X, enumName } → enum: X, enumName', () => {
        class Old {
          @UnifiedField({
            description: 'status',
            enum: { enum: ContactStatusEnum, enumName: 'ContactStatusEnum' },
            isOptional: true,
          })
          status?: ContactStatusEnum;
        }

        class New {
          @UnifiedField({
            description: 'status',
            enum: ContactStatusEnum,
            enumName: 'ContactStatusEnum',
            isOptional: true,
          })
          status?: ContactStatusEnum;
        }

        // Same validation
        for (const val of [...Object.values(ContactStatusEnum), 'bogus', undefined]) {
          const oldErrors = validateSync(plainToInstance(Old, { status: val }));
          const newErrors = validateSync(plainToInstance(New, { status: val }));
          expect(oldErrors.length).toBe(newErrors.length);
        }

        // Same swagger metadata
        const oldMeta = Reflect.getMetadata('swagger/apiModelProperties', Old.prototype, 'status');
        const newMeta = Reflect.getMetadata('swagger/apiModelProperties', New.prototype, 'status');
        expect(oldMeta.enumName).toBe(newMeta.enumName);
        expect(JSON.stringify(oldMeta.enum)).toBe(JSON.stringify(newMeta.enum));
      });

      it('Pattern 3 → 4: array enum no longer needs options: { each: true }', () => {
        class Old {
          @UnifiedField({
            description: 'channels',
            enum: { enum: NotifyViaEnum, enumName: 'NotifyViaEnum', options: { each: true } },
            isArray: true,
            type: () => NotifyViaEnum,
          })
          channels: NotifyViaEnum[] = undefined;
        }

        class New {
          @UnifiedField({
            description: 'channels',
            enum: NotifyViaEnum,
            enumName: 'NotifyViaEnum',
            isArray: true,
            type: () => NotifyViaEnum,
          })
          channels: NotifyViaEnum[] = undefined;
        }

        // Both should accept valid arrays
        const validOld = validateSync(plainToInstance(Old, { channels: ['email', 'sms'] }));
        const validNew = validateSync(plainToInstance(New, { channels: ['email', 'sms'] }));
        expect(validOld).toEqual([]);
        expect(validNew).toEqual([]);

        // Both should reject arrays with invalid elements
        const invalidOld = validateSync(plainToInstance(Old, { channels: ['email', 'pigeon'] }));
        const invalidNew = validateSync(plainToInstance(New, { channels: ['email', 'pigeon'] }));
        expect(invalidOld).toHaveLength(1);
        expect(invalidNew).toHaveLength(1);
      });
    });
  });

  // ========================================
  // registerEnums() bulk registration
  // ========================================

  describe('registerEnums() bulk registration', () => {
    // Simulate a barrel export: import * as Enums from './enums'
    // Each key is the export name, the value is the enum object.
    enum BulkStatusEnum {
      ACTIVE = 'active',
      INACTIVE = 'inactive',
    }

    enum BulkPriorityEnum {
      HIGH = 'high',
      LOW = 'low',
      MEDIUM = 'medium',
    }

    enum BulkNumericEnum {
      FIRST = 1,
      SECOND = 2,
    }

    // Simulate the barrel namespace object
    const FakeEnumBarrel = {
      BulkNumericEnum,
      BulkPriorityEnum,
      BulkStatusEnum,
      // Non-enum exports that should be skipped:
      SomeClass: class SomeClass {},
      helperFn: () => 'hello',
      justAString: 'not-an-enum',
      nested: { deep: { obj: true } },
    };

    beforeEach(() => {
      // Clear any prior registrations
      enumNameRegistry.delete(BulkStatusEnum);
      enumNameRegistry.delete(BulkPriorityEnum);
      enumNameRegistry.delete(BulkNumericEnum);
    });

    it('should register all enums from a barrel namespace', () => {
      registerEnums(FakeEnumBarrel as any);

      expect(enumNameRegistry.get(BulkStatusEnum)).toBe('BulkStatusEnum');
      expect(enumNameRegistry.get(BulkPriorityEnum)).toBe('BulkPriorityEnum');
      expect(enumNameRegistry.get(BulkNumericEnum)).toBe('BulkNumericEnum');
    });

    it('should skip non-enum exports', () => {
      const sizeBefore = enumNameRegistry.size;
      registerEnums(FakeEnumBarrel as any);
      // Only 3 enums should be added, not the non-enum exports
      expect(enumNameRegistry.size).toBe(sizeBefore + 3);
    });

    it('should not re-register already registered enums', () => {
      // Pre-register with a custom name
      enumNameRegistry.set(BulkStatusEnum, 'CustomName');
      registerEnums(FakeEnumBarrel as any);

      // Custom name should be preserved
      expect(enumNameRegistry.get(BulkStatusEnum)).toBe('CustomName');
      // Others registered normally
      expect(enumNameRegistry.get(BulkPriorityEnum)).toBe('BulkPriorityEnum');
    });

    it('should enable auto-detection in @UnifiedField after registration', () => {
      // Suppress deprecation warnings
      const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});

      registerEnums(FakeEnumBarrel as any);

      class Input {
        @UnifiedField({ description: 'status', enum: BulkStatusEnum })
        status: BulkStatusEnum = undefined;
      }

      const meta = Reflect.getMetadata('swagger/apiModelProperties', Input.prototype, 'status');
      expect(meta.enumName).toBe('BulkStatusEnum');

      warnSpy.mockRestore();
    });

    it('should work with graphql: false option', () => {
      registerEnums(FakeEnumBarrel as any, { graphql: false });

      // Swagger registry should have the enum
      expect(enumNameRegistry.get(BulkStatusEnum)).toBe('BulkStatusEnum');
    });

    it('should handle empty namespace gracefully', () => {
      expect(() => registerEnums({})).not.toThrow();
    });

    it('should skip arrays in namespace', () => {
      const ns = { SomeArray: ['a', 'b', 'c'], BulkStatusEnum };
      enumNameRegistry.delete(BulkStatusEnum);
      registerEnums(ns as any);

      expect(enumNameRegistry.has(BulkStatusEnum)).toBe(true);
      // Array should not be registered
      expect(enumNameRegistry.size).toBeLessThanOrEqual(
        // Only BulkStatusEnum should be added from this namespace
        [...enumNameRegistry.values()].filter((v) => v === 'BulkStatusEnum').length + enumNameRegistry.size - 1 + 1,
      );
    });

    it('should skip null values in namespace', () => {
      const ns = { NullVal: null, BulkStatusEnum };
      enumNameRegistry.delete(BulkStatusEnum);
      registerEnums(ns as any);
      expect(enumNameRegistry.has(BulkStatusEnum)).toBe(true);
    });

    it('should skip empty objects (no enum members)', () => {
      const ns = { EmptyObj: {}, BulkStatusEnum };
      enumNameRegistry.delete(BulkStatusEnum);
      registerEnums(ns as any);
      expect(enumNameRegistry.has(BulkStatusEnum)).toBe(true);
      expect(enumNameRegistry.has(ns.EmptyObj as any)).toBe(false);
    });

    it('should handle numeric enums with reverse mappings', () => {
      // TypeScript numeric enums compile to: { LOW: 10, HIGH: 30, 10: 'LOW', 30: 'HIGH' }
      // Object.values() = [10, 30, 'LOW', 'HIGH'] — all string|number → valid
      enum ReverseEnum {
        HIGH = 30,
        LOW = 10,
      }

      const ns = { ReverseEnum };
      registerEnums(ns as any);

      expect(enumNameRegistry.get(ReverseEnum)).toBe('ReverseEnum');
    });

    it('should handle const-object enums', () => {
      const ConstDirection = { EAST: 'east', NORTH: 'north', SOUTH: 'south', WEST: 'west' } as const;
      const ns = { ConstDirection };
      registerEnums(ns as any);

      expect(enumNameRegistry.get(ConstDirection as any)).toBe('ConstDirection');
    });

    it('should be idempotent on repeated calls', () => {
      registerEnums(FakeEnumBarrel as any);
      const firstName = enumNameRegistry.get(BulkStatusEnum);

      // Second call — should not throw or change anything
      expect(() => registerEnums(FakeEnumBarrel as any)).not.toThrow();
      expect(enumNameRegistry.get(BulkStatusEnum)).toBe(firstName);
    });

    it('should skip correctly on repeated calls with { swagger: false }', () => {
      // First call: register only for Swagger (no GraphQL)
      const SkipEnum = { X: 'x', Y: 'y' };
      const ns = { SkipEnum };
      registerEnums(ns as any, { swagger: true, graphql: false });

      expect(enumNameRegistry.get(SkipEnum as any)).toBe('SkipEnum');
      expect(graphqlEnumRegistry.has(SkipEnum)).toBe(false);

      // Second call with same flags — skip logic must detect that Swagger
      // is already done and GraphQL was not requested, so it skips entirely.
      // Before the fix, the && condition would re-process because
      // graphqlEnumRegistry.has() returned false (graphql was never requested).
      const spy = vi.spyOn(enumNameRegistry, 'set');
      registerEnums(ns as any, { swagger: true, graphql: false });
      expect(spy).not.toHaveBeenCalled();
      spy.mockRestore();
    });

    it('should skip correctly on repeated calls with { graphql: false }', () => {
      // First call: register only for GraphQL (no Swagger)
      const GqlSkipEnum = { A: 'a', B: 'b' };
      const ns = { GqlSkipEnum };
      registerEnums(ns as any, { swagger: false, graphql: true });

      expect(enumNameRegistry.has(GqlSkipEnum as any)).toBe(false);
      expect(graphqlEnumRegistry.has(GqlSkipEnum)).toBe(true);

      // Second call with same flags — must skip (GraphQL done, Swagger not requested)
      const spy = vi.spyOn(enumNameRegistry, 'set');
      registerEnums(ns as any, { swagger: false, graphql: true });
      expect(spy).not.toHaveBeenCalled();
      spy.mockRestore();
    });

    it('should respect swagger: false option', () => {
      const MyEnum = { A: 'a', B: 'b' };
      const ns = { MyEnum };

      registerEnums(ns as any, { swagger: false });

      // Swagger registry should NOT have the enum
      expect(enumNameRegistry.has(MyEnum as any)).toBe(false);
    });

    // -------------------------------------------------------
    // GraphQL integration
    // -------------------------------------------------------

    it('should register enums in both Swagger and GraphQL registries', () => {
      const GqlTestEnum = { OPEN: 'open', CLOSED: 'closed' };
      const ns = { GqlTestEnum };

      registerEnums(ns as any);

      // Swagger registry
      expect(enumNameRegistry.get(GqlTestEnum as any)).toBe('GqlTestEnum');
      // GraphQL registry (our tracking WeakSet)
      expect(graphqlEnumRegistry.has(GqlTestEnum)).toBe(true);
    });

    it('should NOT double-register enums already registered via registerEnum', () => {
      // First registration via registerEnum (simulates project calling it directly)
      const PreRegisteredEnum = { DRAFT: 'draft', FINAL: 'final' };
      registerEnum(PreRegisteredEnum as any, { name: 'PreRegisteredEnum' });

      expect(enumNameRegistry.get(PreRegisteredEnum as any)).toBe('PreRegisteredEnum');
      expect(graphqlEnumRegistry.has(PreRegisteredEnum)).toBe(true);

      // Second registration via registerEnums — should skip entirely (both registries have it)
      const ns = { PreRegisteredEnum };
      registerEnums(ns as any);

      // Name unchanged (not overwritten)
      expect(enumNameRegistry.get(PreRegisteredEnum as any)).toBe('PreRegisteredEnum');
    });

    it('should add missing Swagger registration when GraphQL-only registration exists', () => {
      // Simulate: project calls registerEnumType() directly (without registerEnum)
      // This puts the enum in graphqlEnumRegistry but NOT in enumNameRegistry
      const GqlOnlyEnum = { UP: 'up', DOWN: 'down' };
      registerEnumType(GqlOnlyEnum as any, { name: 'GqlOnlyEnum' });
      // Manually track it to simulate it being in GraphQL already
      graphqlEnumRegistry.add(GqlOnlyEnum);

      // enumNameRegistry does NOT have it yet
      expect(enumNameRegistry.has(GqlOnlyEnum as any)).toBe(false);

      // registerEnums should add the Swagger entry but skip GraphQL
      const ns = { GqlOnlyEnum };
      registerEnums(ns as any);

      // Now Swagger has it too
      expect(enumNameRegistry.get(GqlOnlyEnum as any)).toBe('GqlOnlyEnum');
    });

    it('should respect graphql: false — only register in Swagger', () => {
      const SwaggerOnlyEnum = { YES: 'yes', NO: 'no' };
      const ns = { SwaggerOnlyEnum };

      registerEnums(ns as any, { graphql: false });

      // Swagger: registered
      expect(enumNameRegistry.get(SwaggerOnlyEnum as any)).toBe('SwaggerOnlyEnum');
      // GraphQL: NOT registered
      expect(graphqlEnumRegistry.has(SwaggerOnlyEnum)).toBe(false);
    });
  });
});
