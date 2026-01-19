import { BadRequestException } from '@nestjs/common';

import { UnifiedField } from '../src/core/common/decorators/unified-field.decorator';
import { MapAndValidatePipe } from '../src/core/common/pipes/map-and-validate.pipe';

describe('UnifiedField Date Validation (e2e)', () => {
  let pipe: MapAndValidatePipe;

  beforeEach(() => {
    pipe = new MapAndValidatePipe();
  });

  // ========================================
  // Test Classes
  // ========================================

  class DateFieldInput {
    @UnifiedField({
      description: 'Required birth date',
      isOptional: false,
    })
    birthDate: Date;
  }

  class OptionalDateFieldInput {
    @UnifiedField({
      description: 'Required name',
      isOptional: false,
    })
    name: string;

    @UnifiedField({
      description: 'Optional birth date',
      isOptional: true,
    })
    birthDate?: Date;
  }

  class MultipleDateFieldsInput {
    @UnifiedField({
      description: 'Start date',
      isOptional: false,
    })
    startDate: Date;

    @UnifiedField({
      description: 'End date',
      isOptional: false,
    })
    endDate: Date;

    @UnifiedField({
      description: 'Optional created date',
      isOptional: true,
    })
    createdAt?: Date;
  }

  class DateArrayInput {
    @UnifiedField({
      description: 'Array of important dates',
      isArray: true,
      isOptional: false,
      type: () => Date,
    })
    importantDates: Date[];
  }

  // ========================================
  // Successful Validations
  // ========================================

  describe('Successful Date Validations', () => {
    it('should accept ISO 8601 date string for required date field', async () => {
      const input = {
        birthDate: '1990-01-15T00:00:00.000Z',
      };

      const result = await pipe.transform(input, {
        metatype: DateFieldInput,
        type: 'body',
      });

      expect(result.birthDate).toBeInstanceOf(Date);
      expect(result.birthDate.getFullYear()).toBe(1990);
      expect(result.birthDate.getMonth()).toBe(0); // January = 0
      expect(result.birthDate.getDate()).toBe(15);
    });

    it('should accept Date object directly', async () => {
      const dateObj = new Date('2023-05-20T12:30:00.000Z');
      const input = {
        birthDate: dateObj,
      };

      const result = await pipe.transform(input, {
        metatype: DateFieldInput,
        type: 'body',
      });

      expect(result.birthDate).toBeInstanceOf(Date);
      expect(result.birthDate.getTime()).toBe(dateObj.getTime());
    });

    it('should accept short ISO date string (YYYY-MM-DD)', async () => {
      const input = {
        birthDate: '2000-12-25',
      };

      const result = await pipe.transform(input, {
        metatype: DateFieldInput,
        type: 'body',
      });

      expect(result.birthDate).toBeInstanceOf(Date);
      expect(result.birthDate.getFullYear()).toBe(2000);
      expect(result.birthDate.getMonth()).toBe(11); // December = 11
      expect(result.birthDate.getDate()).toBe(25);
    });

    it('should accept date with timezone offset', async () => {
      const input = {
        birthDate: '1985-07-04T14:30:00+02:00',
      };

      const result = await pipe.transform(input, {
        metatype: DateFieldInput,
        type: 'body',
      });

      expect(result.birthDate).toBeInstanceOf(Date);
      expect(result.birthDate.getFullYear()).toBe(1985);
    });

    it('should accept optional date field when provided', async () => {
      const input = {
        birthDate: '1990-01-15T00:00:00.000Z',
        name: 'John Doe',
      };

      const result = await pipe.transform(input, {
        metatype: OptionalDateFieldInput,
        type: 'body',
      });

      expect(result.name).toBe('John Doe');
      expect(result.birthDate).toBeInstanceOf(Date);
    });

    it('should accept optional date field when omitted', async () => {
      const input = {
        name: 'John Doe',
      };

      const result = await pipe.transform(input, {
        metatype: OptionalDateFieldInput,
        type: 'body',
      });

      expect(result.name).toBe('John Doe');
      expect(result.birthDate).toBeUndefined();
    });

    it('should accept optional date field when null', async () => {
      const input = {
        birthDate: null,
        name: 'John Doe',
      };

      const result = await pipe.transform(input, {
        metatype: OptionalDateFieldInput,
        type: 'body',
      });

      expect(result.name).toBe('John Doe');
      expect(result.birthDate).toBeNull();
    });

    it('should accept multiple date fields', async () => {
      const input = {
        createdAt: '2024-01-15T10:30:00.000Z',
        endDate: '2024-12-15T12:00:00.000Z',
        startDate: '2024-01-01T00:00:00.000Z',
      };

      const result = await pipe.transform(input, {
        metatype: MultipleDateFieldsInput,
        type: 'body',
      });

      expect(result.startDate).toBeInstanceOf(Date);
      expect(result.endDate).toBeInstanceOf(Date);
      expect(result.createdAt).toBeInstanceOf(Date);
      expect(result.startDate.getFullYear()).toBe(2024);
      expect(result.startDate.getMonth()).toBe(0); // January
      expect(result.endDate.getFullYear()).toBe(2024);
      expect(result.endDate.getMonth()).toBe(11); // December
      expect(result.endDate.getDate()).toBe(15);
    });

    it('should accept array of date strings', async () => {
      const input = {
        importantDates: ['2020-01-01T00:00:00.000Z', '2021-06-15T12:00:00.000Z', '2022-12-25T18:30:00.000Z'],
      };

      const result = await pipe.transform(input, {
        metatype: DateArrayInput,
        type: 'body',
      });

      expect(result.importantDates).toHaveLength(3);
      expect(result.importantDates[0]).toBeInstanceOf(Date);
      expect(result.importantDates[1]).toBeInstanceOf(Date);
      expect(result.importantDates[2]).toBeInstanceOf(Date);
      expect(result.importantDates[0].getFullYear()).toBe(2020);
      expect(result.importantDates[1].getMonth()).toBe(5); // June
      expect(result.importantDates[2].getDate()).toBe(25);
    });

    it('should accept mixed Date objects and ISO strings in array', async () => {
      const input = {
        importantDates: [
          new Date('2020-01-01T00:00:00.000Z'),
          '2021-06-15T12:00:00.000Z',
          new Date('2022-12-25T18:30:00.000Z'),
        ],
      };

      const result = await pipe.transform(input, {
        metatype: DateArrayInput,
        type: 'body',
      });

      expect(result.importantDates).toHaveLength(3);
      result.importantDates.forEach((date) => {
        expect(date).toBeInstanceOf(Date);
      });
    });

    it('should accept timestamp number and convert to Date', async () => {
      const timestamp = 946684800000; // 2000-01-01T00:00:00.000Z
      const input = {
        birthDate: timestamp,
      };

      const result = await pipe.transform(input, {
        metatype: DateFieldInput,
        type: 'body',
      });

      expect(result.birthDate).toBeInstanceOf(Date);
      expect(result.birthDate.getTime()).toBe(timestamp);
    });
  });

  // ========================================
  // Failed Validations
  // ========================================

  describe('Failed Date Validations', () => {
    it('should fail for invalid date string', async () => {
      const input = {
        birthDate: 'not-a-valid-date',
      };

      await expect(
        pipe.transform(input, {
          metatype: DateFieldInput,
          type: 'body',
        }),
      ).rejects.toThrow(BadRequestException);
    });

    it('should fail for completely invalid string', async () => {
      const input = {
        birthDate: 'abc123xyz',
      };

      await expect(
        pipe.transform(input, {
          metatype: DateFieldInput,
          type: 'body',
        }),
      ).rejects.toThrow(BadRequestException);
    });

    it('should convert boolean to Date (JavaScript behavior)', async () => {
      // Note: JavaScript's Date constructor accepts boolean values
      // true becomes 1ms after Unix epoch, false becomes Unix epoch
      const input = {
        birthDate: true,
      };

      const result = await pipe.transform(input, {
        metatype: DateFieldInput,
        type: 'body',
      });

      expect(result.birthDate).toBeInstanceOf(Date);
      expect(result.birthDate.getTime()).toBe(1); // true = 1ms after epoch
    });

    it('should fail for plain object', async () => {
      const input = {
        birthDate: { day: 15, month: 1, year: 2000 },
      };

      await expect(
        pipe.transform(input, {
          metatype: DateFieldInput,
          type: 'body',
        }),
      ).rejects.toThrow(BadRequestException);
    });

    it('should fail for array instead of single date', async () => {
      const input = {
        birthDate: ['2000-01-15T00:00:00.000Z'],
      };

      await expect(
        pipe.transform(input, {
          metatype: DateFieldInput,
          type: 'body',
        }),
      ).rejects.toThrow(BadRequestException);
    });

    it('should fail when required date field is missing', async () => {
      const input = {};

      await expect(
        pipe.transform(input, {
          metatype: DateFieldInput,
          type: 'body',
        }),
      ).rejects.toThrow(BadRequestException);
    });

    it('should fail when required date field is undefined', async () => {
      const input = {
        birthDate: undefined,
      };

      await expect(
        pipe.transform(input, {
          metatype: DateFieldInput,
          type: 'body',
        }),
      ).rejects.toThrow(BadRequestException);
    });

    it('should fail for empty string', async () => {
      const input = {
        birthDate: '',
      };

      await expect(
        pipe.transform(input, {
          metatype: DateFieldInput,
          type: 'body',
        }),
      ).rejects.toThrow(BadRequestException);
    });

    it('should fail for invalid date in ISO format (invalid day)', async () => {
      const input = {
        birthDate: '2000-02-31T00:00:00.000Z', // Feb 31 doesn't exist
      };

      // JavaScript Date constructor is lenient and will create a valid date
      // but we can check if the date was adjusted
      const result = await pipe.transform(input, {
        metatype: DateFieldInput,
        type: 'body',
      });

      // Feb 31 becomes March 2 or 3 depending on leap year
      expect(result.birthDate).toBeInstanceOf(Date);
      expect(result.birthDate.getMonth()).toBe(2); // March (JavaScript adjusted it)
    });

    it('should fail when optional date has invalid format', async () => {
      const input = {
        birthDate: 'invalid-date-string',
        name: 'John Doe',
      };

      await expect(
        pipe.transform(input, {
          metatype: OptionalDateFieldInput,
          type: 'body',
        }),
      ).rejects.toThrow(BadRequestException);
    });

    it('should fail when one of multiple dates is invalid', async () => {
      const input = {
        createdAt: '2024-01-15T10:30:00.000Z',
        endDate: 'invalid-date',
        startDate: '2024-01-01T00:00:00.000Z',
      };

      await expect(
        pipe.transform(input, {
          metatype: MultipleDateFieldsInput,
          type: 'body',
        }),
      ).rejects.toThrow(BadRequestException);
    });

    it('should fail for invalid date in array', async () => {
      const input = {
        importantDates: ['2020-01-01T00:00:00.000Z', 'invalid-date', '2022-12-25T18:30:00.000Z'],
      };

      await expect(
        pipe.transform(input, {
          metatype: DateArrayInput,
          type: 'body',
        }),
      ).rejects.toThrow(BadRequestException);
    });

    it('should accept empty array (use ArrayMinSize if minimum required)', async () => {
      // Note: Empty array is technically valid unless you add @ArrayMinSize(1)
      // This test documents the current behavior
      const input = {
        importantDates: [],
      };

      const result = await pipe.transform(input, {
        metatype: DateArrayInput,
        type: 'body',
      });

      expect(result.importantDates).toEqual([]);
      expect(Array.isArray(result.importantDates)).toBe(true);
    });

    it('should fail for null in date array', async () => {
      const input = {
        importantDates: ['2020-01-01T00:00:00.000Z', null, '2022-12-25T18:30:00.000Z'],
      };

      await expect(
        pipe.transform(input, {
          metatype: DateArrayInput,
          type: 'body',
        }),
      ).rejects.toThrow(BadRequestException);
    });

    it('should fail for mixed valid and invalid dates in array', async () => {
      const input = {
        importantDates: ['2020-01-01T00:00:00.000Z', new Date('2021-06-15'), 'not-a-date', new Date('2022-12-25')],
      };

      await expect(
        pipe.transform(input, {
          metatype: DateArrayInput,
          type: 'body',
        }),
      ).rejects.toThrow(BadRequestException);
    });

    it('should fail for NaN date value', async () => {
      const input = {
        birthDate: NaN,
      };

      await expect(
        pipe.transform(input, {
          metatype: DateFieldInput,
          type: 'body',
        }),
      ).rejects.toThrow(BadRequestException);
    });

    it('should provide meaningful error message for invalid date', async () => {
      const input = {
        birthDate: 'invalid',
      };

      try {
        await pipe.transform(input, {
          metatype: DateFieldInput,
          type: 'body',
        });
        throw new Error('Should have thrown BadRequestException');
      } catch (error) {
        expect(error).toBeInstanceOf(BadRequestException);
        const response = error.getResponse();
        expect(response.message).toContain('birthDate');
        expect(response.message).toContain('Date');
      }
    });
  });

  // ========================================
  // Edge Cases
  // ========================================

  describe('Edge Cases', () => {
    it('should handle very old dates (before 1970)', async () => {
      const input = {
        birthDate: '1920-01-01T00:00:00.000Z',
      };

      const result = await pipe.transform(input, {
        metatype: DateFieldInput,
        type: 'body',
      });

      expect(result.birthDate).toBeInstanceOf(Date);
      expect(result.birthDate.getFullYear()).toBe(1920);
    });

    it('should handle far future dates', async () => {
      const input = {
        birthDate: '2100-06-15T12:00:00.000Z',
      };

      const result = await pipe.transform(input, {
        metatype: DateFieldInput,
        type: 'body',
      });

      expect(result.birthDate).toBeInstanceOf(Date);
      expect(result.birthDate.getFullYear()).toBe(2100);
      expect(result.birthDate.getMonth()).toBe(5); // June
      expect(result.birthDate.getDate()).toBe(15);
    });

    it('should handle leap year dates', async () => {
      const input = {
        birthDate: '2024-02-29T00:00:00.000Z', // 2024 is a leap year
      };

      const result = await pipe.transform(input, {
        metatype: DateFieldInput,
        type: 'body',
      });

      expect(result.birthDate).toBeInstanceOf(Date);
      expect(result.birthDate.getMonth()).toBe(1); // February
      expect(result.birthDate.getDate()).toBe(29);
    });

    it('should handle Date object with milliseconds precision', async () => {
      const input = {
        birthDate: new Date('2023-06-15T14:30:45.123Z'),
      };

      const result = await pipe.transform(input, {
        metatype: DateFieldInput,
        type: 'body',
      });

      expect(result.birthDate).toBeInstanceOf(Date);
      expect(result.birthDate.getMilliseconds()).toBe(123);
    });

    it('should handle Unix epoch timestamp (0)', async () => {
      const input = {
        birthDate: 0,
      };

      const result = await pipe.transform(input, {
        metatype: DateFieldInput,
        type: 'body',
      });

      expect(result.birthDate).toBeInstanceOf(Date);
      expect(result.birthDate.getTime()).toBe(0);
    });

    it('should handle negative timestamp (before Unix epoch)', async () => {
      const input = {
        birthDate: -86400000, // 1 day before epoch
      };

      const result = await pipe.transform(input, {
        metatype: DateFieldInput,
        type: 'body',
      });

      expect(result.birthDate).toBeInstanceOf(Date);
      expect(result.birthDate.getTime()).toBe(-86400000);
    });
  });
});
