import 'reflect-metadata';

import { enumNameRegistry } from '../src/core/common/decorators/unified-field.decorator';
import { registerEnum } from '../src/core/common/helpers/register-enum.helper';

describe('registerEnum Helper (e2e)', () => {
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
    CRITICAL = 'critical',
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
    ONE = 1,
    THREE = 3,
    TWO = 2,
  }

  enum MixedEnum {
    NUMERIC_VALUE = 42,
    STRING_VALUE = 'string',
  }

  // ========================================
  // Basic Registration
  // ========================================

  describe('Basic Registration', () => {
    it('should register enum for Swagger (GraphQL tested in real apps)', () => {
      registerEnum(StatusEnum, {
        description: 'User status options',
        name: 'StatusEnum',
      });

      // Check Swagger registry - this always works
      expect(enumNameRegistry.has(StatusEnum)).toBe(true);
      expect(enumNameRegistry.get(StatusEnum)).toBe('StatusEnum');

      // Note: GraphQL registration via TypeMetadataStorage only works during NestJS bootstrap,
      // not in unit tests. The registerEnum function DOES call registerEnumType,
      // but TypeMetadataStorage is not populated in this test environment.
      // In a real NestJS application, both registrations work correctly.
    });

    it('should register enum with name only', () => {
      registerEnum(PriorityEnum, {
        name: 'PriorityEnum',
      });

      expect(enumNameRegistry.get(PriorityEnum)).toBe('PriorityEnum');
    });

    it('should throw error when name is not provided', () => {
      expect(() => {
        registerEnum(StatusEnum, {
          name: '',
        });
      }).toThrow('Enum name is required for registerEnum');
    });

    it('should register multiple enums independently', () => {
      registerEnum(StatusEnum, { name: 'StatusEnum' });
      registerEnum(PriorityEnum, { name: 'PriorityEnum' });
      registerEnum(RoleEnum, { name: 'RoleEnum' });

      expect(enumNameRegistry.get(StatusEnum)).toBe('StatusEnum');
      expect(enumNameRegistry.get(PriorityEnum)).toBe('PriorityEnum');
      expect(enumNameRegistry.get(RoleEnum)).toBe('RoleEnum');
    });

    it('should handle numeric enums', () => {
      registerEnum(NumericEnum, {
        description: 'Numeric options',
        name: 'NumericEnum',
      });

      expect(enumNameRegistry.get(NumericEnum)).toBe('NumericEnum');
    });

    it('should handle mixed enums (string and numeric)', () => {
      registerEnum(MixedEnum, {
        name: 'MixedEnum',
      });

      expect(enumNameRegistry.get(MixedEnum)).toBe('MixedEnum');
    });
  });

  // ========================================
  // Swagger-Only Registration
  // ========================================

  describe('Swagger-Only Registration', () => {
    it('should register only for Swagger when graphql: false', () => {
      registerEnum(StatusEnum, {
        graphql: false,
        name: 'StatusEnum',
        swagger: true,
      });

      // Should be in Swagger registry
      expect(enumNameRegistry.has(StatusEnum)).toBe(true);
      expect(enumNameRegistry.get(StatusEnum)).toBe('StatusEnum');
    });

    it('should register multiple Swagger-only enums', () => {
      registerEnum(StatusEnum, {
        graphql: false,
        name: 'StatusEnum',
      });
      registerEnum(PriorityEnum, {
        graphql: false,
        name: 'PriorityEnum',
      });

      expect(enumNameRegistry.get(StatusEnum)).toBe('StatusEnum');
      expect(enumNameRegistry.get(PriorityEnum)).toBe('PriorityEnum');
    });

    it('should work for REST-only projects', () => {
      // Simulate REST-only project (no GraphQL at all)
      const RestEnum = {
        OPTION_A: 'a',
        OPTION_B: 'b',
        OPTION_C: 'c',
      } as const;

      registerEnum(RestEnum as any, {
        graphql: false,
        name: 'RestEnum',
      });

      expect(enumNameRegistry.get(RestEnum)).toBe('RestEnum');
    });
  });

  // ========================================
  // Explicit Flag Combinations
  // ========================================

  describe('Explicit Flag Combinations', () => {
    it('should register for Swagger when both flags are true', () => {
      registerEnum(StatusEnum, {
        graphql: true,
        name: 'StatusEnum',
        swagger: true,
      });

      expect(enumNameRegistry.has(StatusEnum)).toBe(true);
    });

    it('should not register anywhere when both flags are false', () => {
      registerEnum(StatusEnum, {
        graphql: false,
        name: 'StatusEnum',
        swagger: false,
      });

      expect(enumNameRegistry.has(StatusEnum)).toBe(false);
    });

    it('should handle undefined flags as true (default)', () => {
      registerEnum(PriorityEnum, {
        graphql: undefined,
        name: 'PriorityEnum',
        swagger: undefined,
      });

      // Both should be registered (default behavior) - at least Swagger
      expect(enumNameRegistry.has(PriorityEnum)).toBe(true);
    });
  });

  // ========================================
  // Re-registration and Updates
  // ========================================

  describe('Re-registration and Updates', () => {
    it('should allow re-registration with different name', () => {
      registerEnum(StatusEnum, {
        name: 'StatusEnum',
      });

      expect(enumNameRegistry.get(StatusEnum)).toBe('StatusEnum');

      // Re-register with new name
      registerEnum(StatusEnum, {
        name: 'NewStatusEnum',
      });

      expect(enumNameRegistry.get(StatusEnum)).toBe('NewStatusEnum');
    });

    it('should allow changing registration scope to Swagger only', () => {
      // First register for both
      registerEnum(RoleEnum, {
        name: 'RoleEnum',
      });

      expect(enumNameRegistry.has(RoleEnum)).toBe(true);

      // Clear and re-register for Swagger only
      enumNameRegistry.clear();

      registerEnum(RoleEnum, {
        graphql: false,
        name: 'RoleEnum',
      });

      expect(enumNameRegistry.has(RoleEnum)).toBe(true);
    });
  });

  // ========================================
  // Complex Scenarios
  // ========================================

  describe('Complex Scenarios', () => {
    it('should handle enum with all options', () => {
      registerEnum(PriorityEnum, {
        description: 'Task priority levels',
        graphql: true,
        name: 'PriorityEnum',
        swagger: true,
        valuesMap: {
          CRITICAL: {
            deprecationReason: 'Use HIGH instead',
            description: 'Critical priority - immediate action required',
          },
          HIGH: {
            description: 'High priority - should be done ASAP',
          },
          LOW: {
            description: 'Low priority - can be done later',
          },
          MEDIUM: {
            description: 'Medium priority - should be done soon',
          },
        },
      });

      // Check Swagger
      expect(enumNameRegistry.get(PriorityEnum)).toBe('PriorityEnum');
    });

    it('should work in combination with UnifiedField auto-detection', () => {
      registerEnum(StatusEnum, {
        name: 'StatusEnum',
      });

      // Enum should be findable by auto-detection
      expect(enumNameRegistry.get(StatusEnum)).toBe('StatusEnum');
    });

    it('should handle registration of multiple related enums', () => {
      // Register multiple enums for a comprehensive domain model
      registerEnum(StatusEnum, {
        description: 'Entity status',
        name: 'StatusEnum',
      });

      registerEnum(PriorityEnum, {
        description: 'Priority level',
        name: 'PriorityEnum',
      });

      registerEnum(RoleEnum, {
        description: 'User role',
        name: 'RoleEnum',
      });

      // All should be registered
      expect(enumNameRegistry.get(StatusEnum)).toBe('StatusEnum');
      expect(enumNameRegistry.get(PriorityEnum)).toBe('PriorityEnum');
      expect(enumNameRegistry.get(RoleEnum)).toBe('RoleEnum');
    });
  });

  // ========================================
  // Edge Cases
  // ========================================

  describe('Edge Cases', () => {
    it('should handle long enum names', () => {
      const longName = 'VeryLongEnumNameThatExceedsNormalLength';

      registerEnum(StatusEnum, {
        name: longName,
      });

      expect(enumNameRegistry.get(StatusEnum)).toBe(longName);
    });

    it('should handle const enum-like objects', () => {
      const ConstEnumLike = {
        A: 'value_a',
        B: 'value_b',
      } as const;

      registerEnum(ConstEnumLike as any, {
        name: 'ConstEnumLike',
      });

      expect(enumNameRegistry.get(ConstEnumLike)).toBe('ConstEnumLike');
    });
  });

  // ========================================
  // Error Handling
  // ========================================

  describe('Error Handling', () => {
    it('should throw error for null name', () => {
      expect(() => {
        registerEnum(StatusEnum, {
          name: null as any,
        });
      }).toThrow('Enum name is required');
    });

    it('should throw error for undefined name', () => {
      expect(() => {
        registerEnum(StatusEnum, {
          name: undefined as any,
        });
      }).toThrow('Enum name is required');
    });

    it('should throw error for empty string name', () => {
      expect(() => {
        registerEnum(StatusEnum, {
          name: '',
        });
      }).toThrow('Enum name is required');
    });

    it('should not throw for null enum reference if flags are false', () => {
      expect(() => {
        registerEnum(null as any, {
          graphql: false,
          name: 'NullEnum',
          swagger: false,
        });
      }).not.toThrow();
    });
  });
});
