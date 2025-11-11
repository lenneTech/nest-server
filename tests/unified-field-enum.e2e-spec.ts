import 'reflect-metadata';
import { registerEnumType } from '@nestjs/graphql';

import { enumNameRegistry, UnifiedField } from '../src/core/common/decorators/unified-field.decorator';

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
      const { registerEnum } = require('../src/core/common/helpers/register-enum.helper');
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
      const { registerEnum } = require('../src/core/common/helpers/register-enum.helper');
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
      const { registerEnum } = require('../src/core/common/helpers/register-enum.helper');
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
      const { registerEnum } = require('../src/core/common/helpers/register-enum.helper');
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
      const { registerEnum } = require('../src/core/common/helpers/register-enum.helper');
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
});
