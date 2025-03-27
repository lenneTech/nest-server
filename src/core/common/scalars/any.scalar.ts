import { CustomScalar, Scalar } from '@nestjs/graphql';
import { Kind, ValueNode } from 'graphql';

/**
 * Any scalar (is equivalent to the JSON scalar)
 */
@Scalar('Any', type => Any)
export class Any implements CustomScalar<string, any> {
  /**
   * Description of the scalar
   */
  description = 'Any scalar type';

  /**
   * Parse value from the client input variables
   */
  parseValue(value: string) {
    return value;
  }

  /**
   * Serialize value to send to the client
   */
  serialize(value: any) {
    return value;
  }

  /**
   * Parse value from the client query
   */
  parseLiteral(ast: ValueNode, variables?: Record<string, any>) {
    switch (ast.kind) {
      case Kind.BOOLEAN:
      case Kind.ENUM:
      case Kind.STRING:
        return ast.value;
      case Kind.FLOAT:
      case Kind.INT:
        return parseFloat(ast.value);
      case Kind.LIST:
        return ast.values.map(n => this.parseLiteral(n, variables));
      case Kind.NULL:
        return null;
      case Kind.OBJECT: {
        const value = Object.create(null);
        ast.fields.forEach((field) => {
          value[field.name.value] = this.parseLiteral(field.value, variables);
        });
        return value;
      }
      case Kind.VARIABLE: {
        const name = ast.name.value;
        return variables ? variables[name] : undefined;
      }
      default:
        return undefined;
    }
  }
}
