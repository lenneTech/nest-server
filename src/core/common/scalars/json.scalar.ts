import { CustomScalar, Scalar } from '@nestjs/graphql';
import { Kind, ValueNode } from 'graphql';

/**
 * JSON scalar (is equivalent to the Any scalar)
 */
@Scalar('JSON', type => JSON)
export class JSON implements CustomScalar<string, any> {
  /**
   * Description of the scalar
   */
  description
    = 'JSON scalar type. Information on the exact schema of the JSON object is contained in the description of the field.';

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
      case Kind.STRING:
      case Kind.ENUM:
      case Kind.BOOLEAN:
        return ast.value;
      case Kind.INT:
      case Kind.FLOAT:
        return parseFloat(ast.value);
      case Kind.OBJECT: {
        const value = Object.create(null);
        ast.fields.forEach((field) => {
          value[field.name.value] = this.parseLiteral(field.value, variables);
        });
        return value;
      }
      case Kind.LIST:
        return ast.values.map(n => this.parseLiteral(n, variables));
      case Kind.NULL:
        return null;
      case Kind.VARIABLE: {
        const name = ast.name.value;
        return variables ? variables[name] : undefined;
      }
      default:
        return undefined;
    }
  }
}
