import { CustomScalar, Scalar } from '@nestjs/graphql';
import { Kind } from 'graphql';

/**
 * Date scalar to convert string into date
 */
@Scalar('Date', (type) => Date)
export class DateScalar implements CustomScalar<string, Date> {
  description = 'Date custom scalar type';

  /**
   * Parse value from the client input variables
   */
  parseValue(value: number): Date {
    return new Date(value); // value from the client
  }

  /**
   * Serialize value to send to the client
   */
  serialize(value: Date): string {
    return value.toISOString(); // value sent to the client
  }

  /**
   * Parse value from the client query
   */
  parseLiteral(ast: any): Date {
    // Check value
    if (ast.value === undefined || ast.value === null) {
      return ast.value;
    }

    // Check nullable
    if (!ast.value) {
      throw new Error('Invalid value for date');
    }

    // Check value type
    if (ast.kind !== Kind.INT && ast.kind !== Kind.STRING) {
      throw new Error('Invalid value type for date');
    }

    // Check format if value is a string
    if (ast.kind === Kind.STRING && isNaN(Date.parse(ast.value))) {
      throw new Error('Invalid ISO 8601 format for date');
    }

    // Create date from value
    const date = new Date(ast.value);

    // Check value
    if (date.toString() === 'Invalid Date') {
      throw new Error('Invalid value for date');
    }

    // Check if range is valid
    date.toISOString();

    // Return date if everything is fine
    return date;
  }
}
