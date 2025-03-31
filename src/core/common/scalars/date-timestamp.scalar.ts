import { CustomScalar, Scalar } from '@nestjs/graphql';

import { checkAndGetDate, getDateFromGraphQL } from '../helpers/input.helper';

/**
 * Date-Timestamp-Scalar to convert timestamp to date and vice versa
 */
@Scalar('Date', () => Date)
export class DateTimestampScalar implements CustomScalar<number, Date> {
  description = 'Date (by Timestamp) custom scalar type';

  /**
   * Parse value from the client input variables
   */
  parseValue(value: number): Date {
    return checkAndGetDate(value); // value from the client
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
    return getDateFromGraphQL(ast);
  }
}
