import { CustomScalar, Scalar } from '@nestjs/graphql';
import { checkAndGetDate, getDateFromGraphQL } from '../helpers/input.helper';

/**
 * Date scalar to convert string into date
 */
@Scalar('Date', type => Date)
export class DateScalar implements CustomScalar<string, Date> {
  description = 'Date custom scalar type';

  /**
   * Parse value from the client input variables
   */
  parseValue(value: number): Date {
    return checkAndGetDate(value); // value from the client
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
    return getDateFromGraphQL(ast);
  }
}
