import { CustomScalar, Scalar } from '@nestjs/graphql';
import { Kind } from 'graphql';

/**
 * Date scalar to convert string into date
 */
@Scalar('Date', (type) => Date)
export class DateScalar implements CustomScalar<number, Date> {
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
  serialize(value: Date): number {
    return value.getTime(); // value sent to the client
  }

  /**
   * Parse value from the client query
   */
  parseLiteral(ast: any): Date {
    if (ast.kind === Kind.INT) {
      return new Date(ast.value);
    }
    return null;
  }
}
