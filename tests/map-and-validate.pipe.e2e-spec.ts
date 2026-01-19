import { BadRequestException } from '@nestjs/common';
import { Type } from 'class-transformer';
import {
  IsBoolean,
  IsDate,
  IsDefined,
  IsEmail,
  IsEnum,
  IsInt,
  IsNotEmpty,
  IsNumber,
  IsOptional,
  IsString,
  IsUrl,
  Max,
  MaxLength,
  Min,
  MinLength,
  ValidateIf,
  ValidateNested,
} from 'class-validator';

import { nestedTypeRegistry } from '../src/core/common/decorators/unified-field.decorator';
import { MapAndValidatePipe } from '../src/core/common/pipes/map-and-validate.pipe';

describe('MapAndValidatePipe (comprehensive tests)', () => {
  let pipe: MapAndValidatePipe;

  beforeEach(() => {
    pipe = new MapAndValidatePipe();
  });

  // ========================================
  // Test Classes
  // ========================================

  enum TestEnum {
    OPTION_A = 'OPTION_A',
    OPTION_B = 'OPTION_B',
    OPTION_C = 'OPTION_C',
  }

  // Basic validators test class
  class BasicValidatorsInput {
    @IsDefined()
    @IsString()
    name: string;

    @IsDefined()
    @IsNumber()
    age: number;

    @IsDefined()
    @IsEmail()
    email: string;

    @IsBoolean()
    @IsDefined()
    active: boolean;

    @IsDefined()
    @IsUrl()
    website: string;

    @IsDefined()
    @IsInt()
    count: number;

    @IsDefined()
    @IsEnum(TestEnum)
    status: TestEnum;

    @IsDate()
    @IsDefined()
    createdAt: Date;
  }

  // String constraints test class
  class StringConstraintsInput {
    @IsDefined()
    @IsString()
    @MaxLength(20)
    @MinLength(5)
    username: string;

    @IsDefined()
    @IsNotEmpty()
    @IsString()
    description: string;
  }

  // Number constraints test class
  class NumberConstraintsInput {
    @IsDefined()
    @IsNumber()
    @Max(100)
    @Min(0)
    percentage: number;

    @IsDefined()
    @IsInt()
    @Min(1)
    quantity: number;
  }

  // Optional fields test class
  class OptionalFieldsInput {
    @IsDefined()
    @IsString()
    requiredField: string;

    @IsOptional()
    @IsString()
    optionalField?: string;

    @IsNumber()
    @IsOptional()
    optionalNumber?: number;
  }

  // Parent class for override tests
  class ParentInput {
    @IsOptional()
    @IsString()
    field1?: string = undefined;

    @IsNumber()
    @IsOptional()
    field2?: number = undefined;
  }

  // Child class that overrides parent optionality
  class ChildInput extends ParentInput {
    @IsDefined()
    @IsNotEmpty()
    @IsString()
    override field1: string = undefined;

    @IsDefined()
    @IsNumber()
    override field2: number = undefined;
  }

  // Nested object classes
  class AddressInput {
    @IsDefined()
    @IsString()
    street: string = undefined;

    @IsDefined()
    @IsString()
    city: string = undefined;

    @IsDefined()
    @IsString()
    zip: string = undefined;
  }

  class PersonInput {
    @IsDefined()
    @IsString()
    name: string;

    @IsDefined()
    @Type(() => AddressInput)
    @ValidateNested()
    address: AddressInput;
  }

  // Nested array classes
  class TagInput {
    @IsDefined()
    @IsString()
    name: string = undefined;

    @IsDefined()
    @IsString()
    color: string = undefined;
  }

  class ArticleInput {
    @IsDefined()
    @IsString()
    title: string;

    @IsDefined()
    @Type(() => TagInput)
    @ValidateNested({ each: true })
    tags: TagInput[];
  }

  // Each-handling test class
  class ArrayValidationInput {
    @IsDefined()
    @IsString({ each: true })
    stringArray: string[];

    @IsDefined()
    @IsNumber({}, { each: true })
    numberArray: number[];

    @IsDefined()
    @IsEmail({}, { each: true })
    emailArray: string[];

    @IsDefined()
    @IsEnum(TestEnum, { each: true })
    enumArray: TestEnum[];

    @IsDefined()
    @IsInt({ each: true })
    intArray: number[];

    @IsBoolean({ each: true })
    @IsDefined()
    boolArray: boolean[];
  }

  // ValidateIf test class
  class ConditionalValidationInput {
    @IsDefined()
    @IsString()
    type: string;

    @IsEmail()
    @ValidateIf((o) => o.type === 'email')
    email?: string;

    @IsString()
    @MinLength(10)
    @ValidateIf((o) => o.type === 'phone')
    phone?: string;

    @IsUrl()
    @ValidateIf((o) => o.isPremium === true)
    website?: string;

    @IsBoolean()
    @IsOptional()
    isPremium?: boolean;
  }

  // Array with constraints
  class ArrayConstraintsInput {
    @IsDefined()
    @IsString({ each: true })
    @MaxLength(10, { each: true })
    @MinLength(3, { each: true })
    names: string[];

    @IsDefined()
    @IsNumber({}, { each: true })
    @Max(100, { each: true })
    @Min(0, { each: true })
    scores: number[];
  }

  // ========================================
  // Setup nested type registry for tests
  // ========================================

  beforeAll(() => {
    // Register nested types for validation
    nestedTypeRegistry.set('PersonInput.address', AddressInput);
    nestedTypeRegistry.set('ArticleInput.tags', TagInput);
  });

  // ========================================
  // Basic Validators Tests
  // ========================================

  describe('Basic Validators', () => {
    it('should pass with valid basic types', async () => {
      const input = {
        active: true,
        age: 30,
        count: 5,
        createdAt: new Date(),
        email: 'john@example.com',
        name: 'John Doe',
        status: TestEnum.OPTION_A,
        website: 'https://example.com',
      };

      const result = await pipe.transform(input, {
        metatype: BasicValidatorsInput,
        type: 'body',
      });

      expect(result).toBeDefined();
      expect(result.name).toBe('John Doe');
    });

    it('should fail with invalid string', async () => {
      const input = {
        active: true,
        age: 30,
        count: 5,
        createdAt: new Date(),
        email: 'john@example.com',
        name: 123, // Should be string
        status: TestEnum.OPTION_A,
        website: 'https://example.com',
      };

      await expect(
        pipe.transform(input, {
          metatype: BasicValidatorsInput,
          type: 'body',
        }),
      ).rejects.toThrow(BadRequestException);
    });

    it('should fail with invalid email', async () => {
      const input = {
        active: true,
        age: 30,
        count: 5,
        createdAt: new Date(),
        email: 'not-an-email', // Invalid email
        name: 'John Doe',
        status: TestEnum.OPTION_A,
        website: 'https://example.com',
      };

      await expect(
        pipe.transform(input, {
          metatype: BasicValidatorsInput,
          type: 'body',
        }),
      ).rejects.toThrow(BadRequestException);
    });

    it('should fail with invalid enum', async () => {
      const input = {
        active: true,
        age: 30,
        count: 5,
        createdAt: new Date(),
        email: 'john@example.com',
        name: 'John Doe',
        status: 'INVALID_OPTION', // Invalid enum
        website: 'https://example.com',
      };

      await expect(
        pipe.transform(input, {
          metatype: BasicValidatorsInput,
          type: 'body',
        }),
      ).rejects.toThrow(BadRequestException);
    });

    it('should fail with invalid boolean', async () => {
      const input = {
        active: 'yes', // Should be boolean
        age: 30,
        count: 5,
        createdAt: new Date(),
        email: 'john@example.com',
        name: 'John Doe',
        status: TestEnum.OPTION_A,
        website: 'https://example.com',
      };

      await expect(
        pipe.transform(input, {
          metatype: BasicValidatorsInput,
          type: 'body',
        }),
      ).rejects.toThrow(BadRequestException);
    });

    it('should fail with invalid URL', async () => {
      const input = {
        active: true,
        age: 30,
        count: 5,
        createdAt: new Date(),
        email: 'john@example.com',
        name: 'John Doe',
        status: TestEnum.OPTION_A,
        website: 'not-a-url', // Invalid URL
      };

      await expect(
        pipe.transform(input, {
          metatype: BasicValidatorsInput,
          type: 'body',
        }),
      ).rejects.toThrow(BadRequestException);
    });

    it('should fail with non-integer', async () => {
      const input = {
        active: true,
        age: 30,
        count: 5.5, // Should be integer
        createdAt: new Date(),
        email: 'john@example.com',
        name: 'John Doe',
        status: TestEnum.OPTION_A,
        website: 'https://example.com',
      };

      await expect(
        pipe.transform(input, {
          metatype: BasicValidatorsInput,
          type: 'body',
        }),
      ).rejects.toThrow(BadRequestException);
    });
  });

  // ========================================
  // String Constraints Tests
  // ========================================

  describe('String Constraints', () => {
    it('should pass with valid string constraints', async () => {
      const input = {
        description: 'A valid description',
        username: 'john_doe',
      };

      const result = await pipe.transform(input, {
        metatype: StringConstraintsInput,
        type: 'body',
      });

      expect(result).toBeDefined();
      expect(result.username).toBe('john_doe');
    });

    it('should fail with too short string', async () => {
      const input = {
        description: 'Valid',
        username: 'joe', // Too short (min 5)
      };

      await expect(
        pipe.transform(input, {
          metatype: StringConstraintsInput,
          type: 'body',
        }),
      ).rejects.toThrow(BadRequestException);
    });

    it('should fail with too long string', async () => {
      const input = {
        description: 'Valid',
        username: 'this_username_is_way_too_long', // Too long (max 20)
      };

      await expect(
        pipe.transform(input, {
          metatype: StringConstraintsInput,
          type: 'body',
        }),
      ).rejects.toThrow(BadRequestException);
    });

    it('should fail with empty string when IsNotEmpty', async () => {
      const input = {
        description: '', // Empty not allowed
        username: 'valid_name',
      };

      await expect(
        pipe.transform(input, {
          metatype: StringConstraintsInput,
          type: 'body',
        }),
      ).rejects.toThrow(BadRequestException);
    });
  });

  // ========================================
  // Number Constraints Tests
  // ========================================

  describe('Number Constraints', () => {
    it('should pass with valid number constraints', async () => {
      const input = {
        percentage: 50,
        quantity: 10,
      };

      const result = await pipe.transform(input, {
        metatype: NumberConstraintsInput,
        type: 'body',
      });

      expect(result).toBeDefined();
      expect(result.percentage).toBe(50);
    });

    it('should fail with number below minimum', async () => {
      const input = {
        percentage: -10, // Below min (0)
        quantity: 10,
      };

      await expect(
        pipe.transform(input, {
          metatype: NumberConstraintsInput,
          type: 'body',
        }),
      ).rejects.toThrow(BadRequestException);
    });

    it('should fail with number above maximum', async () => {
      const input = {
        percentage: 150, // Above max (100)
        quantity: 10,
      };

      await expect(
        pipe.transform(input, {
          metatype: NumberConstraintsInput,
          type: 'body',
        }),
      ).rejects.toThrow(BadRequestException);
    });

    it('should fail with zero when min is 1', async () => {
      const input = {
        percentage: 50,
        quantity: 0, // Below min (1)
      };

      await expect(
        pipe.transform(input, {
          metatype: NumberConstraintsInput,
          type: 'body',
        }),
      ).rejects.toThrow(BadRequestException);
    });
  });

  // ========================================
  // Optional Fields Tests
  // ========================================

  describe('Optional Fields', () => {
    it('should pass with all fields provided', async () => {
      const input = {
        optionalField: 'optional',
        optionalNumber: 42,
        requiredField: 'required',
      };

      const result = await pipe.transform(input, {
        metatype: OptionalFieldsInput,
        type: 'body',
      });

      expect(result).toBeDefined();
      expect(result.optionalField).toBe('optional');
    });

    it('should pass with only required fields', async () => {
      const input = {
        requiredField: 'required',
      };

      const result = await pipe.transform(input, {
        metatype: OptionalFieldsInput,
        type: 'body',
      });

      expect(result).toBeDefined();
      expect(result.optionalField).toBeUndefined();
    });

    it('should fail when required field is missing', async () => {
      const input = {
        optionalField: 'optional',
        optionalNumber: 42,
      };

      await expect(
        pipe.transform(input, {
          metatype: OptionalFieldsInput,
          type: 'body',
        }),
      ).rejects.toThrow(BadRequestException);
    });

    it('should fail when optional field has invalid type', async () => {
      const input = {
        optionalField: 123, // Should be string
        requiredField: 'required',
      };

      await expect(
        pipe.transform(input, {
          metatype: OptionalFieldsInput,
          type: 'body',
        }),
      ).rejects.toThrow(BadRequestException);
    });
  });

  // ========================================
  // Override Semantics Tests
  // ========================================

  describe('Override Semantics', () => {
    it('should allow optional fields in parent class', async () => {
      const input = {
        // Both fields optional in ParentInput
      };

      const result = await pipe.transform(input, {
        metatype: ParentInput,
        type: 'body',
      });

      expect(result).toBeDefined();
    });

    it('should require fields in child class even if optional in parent', async () => {
      const input = {
        // Missing required fields from ChildInput
      };

      await expect(
        pipe.transform(input, {
          metatype: ChildInput,
          type: 'body',
        }),
      ).rejects.toThrow(BadRequestException);
    });

    it('should validate child class with all required fields', async () => {
      const input = {
        field1: 'value1',
        field2: 42,
      };

      const result = await pipe.transform(input, {
        metatype: ChildInput,
        type: 'body',
      });

      expect(result).toBeDefined();
      expect(result.field1).toBe('value1');
      expect(result.field2).toBe(42);
    });

    it('should fail when child field is empty even though parent allows it', async () => {
      const input = {
        field1: '', // Empty not allowed in ChildInput
        field2: 42,
      };

      await expect(
        pipe.transform(input, {
          metatype: ChildInput,
          type: 'body',
        }),
      ).rejects.toThrow(BadRequestException);
    });
  });

  // ========================================
  // Nested Validation Tests
  // ========================================

  describe('Nested Validation', () => {
    it('should pass with valid nested object', async () => {
      const input = {
        address: {
          city: 'Springfield',
          street: '123 Main St',
          zip: '12345',
        },
        name: 'John Doe',
      };

      const result = await pipe.transform(input, {
        metatype: PersonInput,
        type: 'body',
      });

      expect(result).toBeDefined();
      expect(result.address.city).toBe('Springfield');
    });

    it('should fail with missing nested required field', async () => {
      const input = {
        address: {
          street: '123 Main St',
          // Missing city
          zip: '12345',
        },
        name: 'John Doe',
      };

      await expect(
        pipe.transform(input, {
          metatype: PersonInput,
          type: 'body',
        }),
      ).rejects.toThrow(BadRequestException);
    });

    it('should fail with invalid nested field type', async () => {
      const input = {
        address: {
          city: 'Springfield',
          street: 123, // Should be string
          zip: '12345',
        },
        name: 'John Doe',
      };

      await expect(
        pipe.transform(input, {
          metatype: PersonInput,
          type: 'body',
        }),
      ).rejects.toThrow(BadRequestException);
    });

    it('should pass with valid nested array', async () => {
      const input = {
        tags: [
          { color: 'yellow', name: 'javascript' },
          { color: 'blue', name: 'typescript' },
        ],
        title: 'Test Article',
      };

      const result = await pipe.transform(input, {
        metatype: ArticleInput,
        type: 'body',
      });

      expect(result).toBeDefined();
      expect(result.tags).toHaveLength(2);
    });

    it('should fail with missing field in nested array item', async () => {
      const input = {
        tags: [
          { color: 'yellow', name: 'javascript' },
          { name: 'typescript' }, // Missing color
        ],
        title: 'Test Article',
      };

      await expect(
        pipe.transform(input, {
          metatype: ArticleInput,
          type: 'body',
        }),
      ).rejects.toThrow(BadRequestException);
    });

    it('should fail with invalid type in nested array item', async () => {
      const input = {
        tags: [
          { color: 'yellow', name: 'javascript' },
          { color: 'blue', name: 123 }, // Invalid type
        ],
        title: 'Test Article',
      };

      await expect(
        pipe.transform(input, {
          metatype: ArticleInput,
          type: 'body',
        }),
      ).rejects.toThrow(BadRequestException);
    });
  });

  // ========================================
  // Each-Handling Tests
  // ========================================

  describe('Each-Handling (Array Validation)', () => {
    it('should pass with valid arrays', async () => {
      const input = {
        boolArray: [true, false, true],
        emailArray: ['test1@example.com', 'test2@example.com'],
        enumArray: [TestEnum.OPTION_A, TestEnum.OPTION_B],
        intArray: [1, 2, 3],
        numberArray: [1, 2, 3],
        stringArray: ['one', 'two', 'three'],
      };

      const result = await pipe.transform(input, {
        metatype: ArrayValidationInput,
        type: 'body',
      });

      expect(result).toBeDefined();
      expect(result.stringArray).toHaveLength(3);
    });

    it('should fail with invalid string in array', async () => {
      const input = {
        boolArray: [true, false, true],
        emailArray: ['test1@example.com', 'test2@example.com'],
        enumArray: [TestEnum.OPTION_A, TestEnum.OPTION_B],
        intArray: [1, 2, 3],
        numberArray: [1, 2, 3],
        stringArray: ['one', 123, 'three'], // Invalid item
      };

      await expect(
        pipe.transform(input, {
          metatype: ArrayValidationInput,
          type: 'body',
        }),
      ).rejects.toThrow(BadRequestException);
    });

    it('should fail with invalid email in array', async () => {
      const input = {
        boolArray: [true, false, true],
        emailArray: ['test1@example.com', 'not-an-email'], // Invalid email
        enumArray: [TestEnum.OPTION_A, TestEnum.OPTION_B],
        intArray: [1, 2, 3],
        numberArray: [1, 2, 3],
        stringArray: ['one', 'two', 'three'],
      };

      await expect(
        pipe.transform(input, {
          metatype: ArrayValidationInput,
          type: 'body',
        }),
      ).rejects.toThrow(BadRequestException);
    });

    it('should fail with invalid enum in array', async () => {
      const input = {
        boolArray: [true, false, true],
        emailArray: ['test1@example.com', 'test2@example.com'],
        enumArray: [TestEnum.OPTION_A, 'INVALID'], // Invalid enum
        intArray: [1, 2, 3],
        numberArray: [1, 2, 3],
        stringArray: ['one', 'two', 'three'],
      };

      await expect(
        pipe.transform(input, {
          metatype: ArrayValidationInput,
          type: 'body',
        }),
      ).rejects.toThrow(BadRequestException);
    });

    it('should fail with non-integer in int array', async () => {
      const input = {
        boolArray: [true, false, true],
        emailArray: ['test1@example.com', 'test2@example.com'],
        enumArray: [TestEnum.OPTION_A, TestEnum.OPTION_B],
        intArray: [1, 2.5, 3], // Invalid integer
        numberArray: [1, 2, 3],
        stringArray: ['one', 'two', 'three'],
      };

      await expect(
        pipe.transform(input, {
          metatype: ArrayValidationInput,
          type: 'body',
        }),
      ).rejects.toThrow(BadRequestException);
    });

    it('should fail with invalid boolean in array', async () => {
      const input = {
        boolArray: [true, 'false', true], // Invalid boolean
        emailArray: ['test1@example.com', 'test2@example.com'],
        enumArray: [TestEnum.OPTION_A, TestEnum.OPTION_B],
        intArray: [1, 2, 3],
        numberArray: [1, 2, 3],
        stringArray: ['one', 'two', 'three'],
      };

      await expect(
        pipe.transform(input, {
          metatype: ArrayValidationInput,
          type: 'body',
        }),
      ).rejects.toThrow(BadRequestException);
    });
  });

  // ========================================
  // Array Constraints Tests
  // ========================================

  describe('Array Constraints (Each with Min/Max)', () => {
    it('should pass with valid array constraints', async () => {
      const input = {
        names: ['alice', 'bob', 'charlie'],
        scores: [50, 75, 100],
      };

      const result = await pipe.transform(input, {
        metatype: ArrayConstraintsInput,
        type: 'body',
      });

      expect(result).toBeDefined();
      expect(result.names).toHaveLength(3);
    });

    it('should fail with too short string in array', async () => {
      const input = {
        names: ['alice', 'ab', 'charlie'], // 'ab' too short (min 3)
        scores: [50, 75, 100],
      };

      await expect(
        pipe.transform(input, {
          metatype: ArrayConstraintsInput,
          type: 'body',
        }),
      ).rejects.toThrow(BadRequestException);
    });

    it('should fail with too long string in array', async () => {
      const input = {
        names: ['alice', 'this_is_too_long_name', 'charlie'], // Too long (max 10)
        scores: [50, 75, 100],
      };

      await expect(
        pipe.transform(input, {
          metatype: ArrayConstraintsInput,
          type: 'body',
        }),
      ).rejects.toThrow(BadRequestException);
    });

    it('should fail with number below min in array', async () => {
      const input = {
        names: ['alice', 'bob', 'charlie'],
        scores: [50, -10, 100], // -10 below min (0)
      };

      await expect(
        pipe.transform(input, {
          metatype: ArrayConstraintsInput,
          type: 'body',
        }),
      ).rejects.toThrow(BadRequestException);
    });

    it('should fail with number above max in array', async () => {
      const input = {
        names: ['alice', 'bob', 'charlie'],
        scores: [50, 150, 100], // 150 above max (100)
      };

      await expect(
        pipe.transform(input, {
          metatype: ArrayConstraintsInput,
          type: 'body',
        }),
      ).rejects.toThrow(BadRequestException);
    });
  });

  // ========================================
  // ValidateIf (Conditional Validation) Tests
  // ========================================

  describe('ValidateIf (Conditional Validation)', () => {
    it('should validate email when type is email and all conditionals provided', async () => {
      const input = {
        email: 'test@example.com',
        isPremium: false,
        phone: '1234567890',
        type: 'email',
      };

      const result = await pipe.transform(input, {
        metatype: ConditionalValidationInput,
        type: 'body',
      });

      expect(result).toBeDefined();
      expect(result.email).toBe('test@example.com');
    });

    it('should skip email validation when type is phone', async () => {
      const input = {
        email: 'invalid-email', // Invalid but condition is false so should be skipped
        isPremium: false,
        phone: '1234567890',
        type: 'phone',
      };

      const result = await pipe.transform(input, {
        metatype: ConditionalValidationInput,
        type: 'body',
      });

      expect(result).toBeDefined();
      expect(result.phone).toBe('1234567890');
    });

    it('should fail when email invalid and type is email', async () => {
      const input = {
        email: 'not-an-email', // Invalid email
        type: 'email',
      };

      await expect(
        pipe.transform(input, {
          metatype: ConditionalValidationInput,
          type: 'body',
        }),
      ).rejects.toThrow(BadRequestException);
    });

    it('should validate phone when type is phone', async () => {
      const input = {
        email: 'test@example.com',
        isPremium: false,
        phone: '1234567890',
        type: 'phone',
      };

      const result = await pipe.transform(input, {
        metatype: ConditionalValidationInput,
        type: 'body',
      });

      expect(result).toBeDefined();
      expect(result.phone).toBe('1234567890');
    });

    it('should fail when phone too short and type is phone', async () => {
      const input = {
        phone: '12345', // Too short (min 10)
        type: 'phone',
      };

      await expect(
        pipe.transform(input, {
          metatype: ConditionalValidationInput,
          type: 'body',
        }),
      ).rejects.toThrow(BadRequestException);
    });

    it('should validate website when isPremium is true', async () => {
      const input = {
        email: 'test@example.com',
        isPremium: true,
        phone: '1234567890',
        type: 'email',
        website: 'https://example.com',
      };

      const result = await pipe.transform(input, {
        metatype: ConditionalValidationInput,
        type: 'body',
      });

      expect(result).toBeDefined();
      expect(result.website).toBe('https://example.com');
    });

    it('should skip website validation when isPremium is false', async () => {
      const input = {
        email: 'test@example.com',
        isPremium: false,
        phone: '1234567890',
        type: 'email',
        website: 'not-a-url', // Invalid but should be skipped
      };

      const result = await pipe.transform(input, {
        metatype: ConditionalValidationInput,
        type: 'body',
      });

      expect(result).toBeDefined();
      expect(result.email).toBe('test@example.com');
    });

    it('should fail when website invalid and isPremium is true', async () => {
      const input = {
        email: 'test@example.com',
        isPremium: true,
        type: 'email',
        website: 'not-a-url', // Invalid URL
      };

      await expect(
        pipe.transform(input, {
          metatype: ConditionalValidationInput,
          type: 'body',
        }),
      ).rejects.toThrow(BadRequestException);
    });
  });

  // ========================================
  // Error Message Tests
  // ========================================

  describe('Error Messages', () => {
    it('should provide meaningful error message for validation failure', async () => {
      const input = {
        name: 123, // Invalid type
      };

      try {
        await pipe.transform(input, {
          metatype: OptionalFieldsInput,
          type: 'body',
        });
        throw new Error('Should have thrown BadRequestException');
      } catch (error) {
        expect(error).toBeInstanceOf(BadRequestException);
        const response = error.getResponse();
        expect(response).toHaveProperty('message');
        expect(response.message).toContain('Validation failed');
      }
    });

    it('should include all failed fields in error', async () => {
      const input = {
        active: 'yes', // Invalid
        age: 'not-a-number', // Invalid
        count: 5.5, // Invalid
        createdAt: 'not-a-date', // Invalid
        email: 'not-an-email', // Invalid
        name: 123, // Invalid
        status: 'INVALID', // Invalid
        website: 'not-a-url', // Invalid
      };

      try {
        await pipe.transform(input, {
          metatype: BasicValidatorsInput,
          type: 'body',
        });
        throw new Error('Should have thrown BadRequestException');
      } catch (error) {
        expect(error).toBeInstanceOf(BadRequestException);
        const response = error.getResponse();

        // Should have errors for multiple fields
        expect(Object.keys(response).length).toBeGreaterThan(3);
      }
    });
  });

  // Date transformation test class
  class DateTransformInput {
    @IsDate()
    @IsDefined()
    @Type(() => Date)
    birthDate: Date;
  }

  // ========================================
  // Edge Cases
  // ========================================

  describe('Edge Cases', () => {
    it('should handle null value for optional field', async () => {
      const input = {
        optionalField: null,
        requiredField: 'required',
      };

      const result = await pipe.transform(input, {
        metatype: OptionalFieldsInput,
        type: 'body',
      });

      expect(result).toBeDefined();
    });

    it('should handle undefined value for optional field', async () => {
      const input = {
        optionalField: undefined,
        requiredField: 'required',
      };

      const result = await pipe.transform(input, {
        metatype: OptionalFieldsInput,
        type: 'body',
      });

      expect(result).toBeDefined();
    });

    it('should handle empty array', async () => {
      const input = {
        boolArray: [],
        emailArray: [],
        enumArray: [],
        intArray: [],
        numberArray: [],
        stringArray: [],
      };

      const result = await pipe.transform(input, {
        metatype: ArrayValidationInput,
        type: 'body',
      });

      expect(result).toBeDefined();
      expect(result.stringArray).toHaveLength(0);
    });

    it('should skip validation for basic types', async () => {
      const input = 'just a string';

      const result = await pipe.transform(input, {
        metatype: String,
        type: 'body',
      });

      expect(result).toBe('just a string');
    });

    it('should skip validation when no metatype', async () => {
      const input = { any: 'value' };

      const result = await pipe.transform(input, {
        metatype: undefined,
        type: 'body',
      });

      expect(result).toEqual({ any: 'value' });
    });

    it('should transform ISO date strings to Date objects', async () => {
      const input = {
        birthDate: '1990-01-15T00:00:00.000Z', // ISO string
      };

      const result = await pipe.transform(input, {
        metatype: DateTransformInput,
        type: 'body',
      });

      expect(result.birthDate).toBeInstanceOf(Date);
      expect(result.birthDate.getFullYear()).toBe(1990);
      expect(result.birthDate.getMonth()).toBe(0); // January = 0
      expect(result.birthDate.getDate()).toBe(15);
    });

    it('should fail validation for invalid date strings', async () => {
      const input = {
        birthDate: 'not-a-valid-date',
      };

      await expect(
        pipe.transform(input, {
          metatype: DateTransformInput,
          type: 'body',
        }),
      ).rejects.toThrow(BadRequestException);
    });
  });
});
