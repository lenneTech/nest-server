import {
  BooleanValueNode,
  DirectiveNode,
  EnumValueNode,
  FieldNode,
  FloatValueNode,
  GraphQLResolveInfo,
  IntValueNode,
  ListValueNode,
  SelectionNode,
  StringValueNode,
  ValueNode,
  VariableNode,
} from 'graphql';
import * as _ from 'lodash';

/**
 * Interface for GraphQLFieldsConfig
 */
export interface GraphQLFieldsConfig {
  processArguments: boolean;
  excludedFields: string[];
}

/**
 * Type ValueNodeWithValueField
 */
export type ValueNodeWithValueField =
  | VariableNode
  | IntValueNode
  | FloatValueNode
  | StringValueNode
  | BooleanValueNode
  | EnumValueNode;

export class GraphQLHelper {
  /**
   * Check if AST is a Field
   * @param ast
   */
  public static isFieldNode(ast: SelectionNode): ast is FieldNode {
    return ast.kind === 'Field';
  }

  /**
   * Check if ValueNode has a value field
   */
  public static isValueNodeWithValueField(value: ValueNode): value is ValueNodeWithValueField {
    return value.kind !== 'NullValue' && value.kind !== 'ListValue' && value.kind !== 'ObjectValue';
  }

  /**
   * Check ValueNode is a ListValue
   * @param value
   */
  public static isListValueNode(value: ValueNode): value is ListValueNode {
    return value.kind === 'ListValue';
  }

  /**
   * Get selections of AST
   */
  public static getSelections(ast: FieldNode) {
    if (ast && ast.selectionSet && ast.selectionSet.selections && ast.selectionSet.selections.length) {
      return ast.selectionSet.selections;
    }

    return [];
  }

  /**
   * Get AST
   */
  public static getAST(ast, info) {
    if (ast.kind === 'FragmentSpread') {
      const fragmentName = ast.name.value;
      return info.fragments[fragmentName];
    }
    return ast;
  }

  /**
   * Get arguments of AST
   */
  public static getArguments(ast: FieldNode) {
    return ast.arguments?.map((argument) => {
      const valueNode = argument.value;
      const argumentValue = !GraphQLHelper.isListValueNode(valueNode)
        ? (valueNode as any).value
        : (valueNode as any).values.map((value) => value.value);

      return {
        [argument.name.value]: {
          kind: argument.value.kind,
          value: argumentValue,
        },
      };
    });
  }

  /**
   * Get directive value from DirectiveNode for GraphQLResolveInfo
   */
  public static getDirectiveValue(directive: DirectiveNode, info: GraphQLResolveInfo) {
    const arg = directive.arguments?.[0]; // only arg on an include or skip directive is "if"
    if (!arg) {
      return;
    }
    if (arg.value.kind !== 'Variable') {
      const valueNode = arg.value;
      return GraphQLHelper.isValueNodeWithValueField(valueNode) ? !!valueNode.value : false;
    }
    return info.variableValues[arg.value.name.value];
  }

  /**
   * Get directive results from SelectionNode for GraphQLResolveInfo
   * @param ast
   * @param info
   */
  public static getDirectiveResults(ast: SelectionNode, info: GraphQLResolveInfo) {
    const directiveResult = {
      shouldInclude: true,
      shouldSkip: false,
    };
    return ast.directives?.reduce((result, directive) => {
      switch (directive.name.value) {
        case 'include':
          return {
            ...result,
            shouldInclude: GraphQLHelper.getDirectiveValue(directive, info),
          };
        case 'skip':
          return {
            ...result,
            shouldSkip: GraphQLHelper.getDirectiveValue(directive, info),
          };
        default:
          return result;
      }
    }, directiveResult);
  }

  /**
   * Create flatten AST from FieldNode for GraphQLResolveInfo
   */
  public static flattenAST(
    ast: FieldNode,
    info: GraphQLResolveInfo,
    obj: any = {},
    config: Partial<GraphQLFieldsConfig> = {}
  ) {
    // Process configuration
    config = Object.assign(
      {
        processArguments: false,
        excludedFields: [],
      },
      config
    );

    return GraphQLHelper.getSelections(ast).reduce((flattened, a) => {
      if (a.directives && a.directives.length) {
        const { shouldInclude, shouldSkip } = GraphQLHelper.getDirectiveResults(a, info);
        // Field/fragment is not included if either the @skip condition is true or the @include condition is false
        // https://facebook.github.io/graphql/draft/#sec--include
        if (shouldSkip || !shouldInclude) {
          return flattened;
        }
      }

      if (GraphQLHelper.isFieldNode(a)) {
        const name = a.name.value;
        if (config.excludedFields.indexOf(name) !== -1) {
          return flattened;
        }

        if (flattened[name] && flattened[name] !== '__arguments') {
          Object.assign(flattened[name], GraphQLHelper.flattenAST(a, info, flattened[name]));
        } else {
          flattened[name] = GraphQLHelper.flattenAST(a, info);
        }

        if (config.processArguments) {
          // check if the current field has arguments
          if (a.arguments && a.arguments.length) {
            Object.assign(flattened[name], {
              __arguments: GraphQLHelper.getArguments(a),
            });
          }
        }
      } else {
        flattened = GraphQLHelper.flattenAST(GraphQLHelper.getAST(a, info), info, flattened);
      }

      return flattened;
    }, obj);
  }

  /**
   * Get requested fields from GraphQLResolveInfo
   */
  public static getFields(
    info: GraphQLResolveInfo,
    obj: Record<string, any> = {},
    config: Partial<GraphQLFieldsConfig> = {}
  ) {
    // Check info
    if (!info || (!info.fieldNodes && !(info as any).fieldASTs)) {
      return {};
    }

    // Get fields from GraphQL
    const fields: ReadonlyArray<FieldNode> = info.fieldNodes || (info as any).fieldASTs;

    // Process and return fields
    return (
      fields.reduce((o, ast) => {
        return GraphQLHelper.flattenAST(ast, info, o, config);
      }, obj) || {}
    );
  }

  /**
   * Check if field is in GraphQLResolveInfo
   */
  public static isInGraphQLResolveInfo(path: any, info: GraphQLResolveInfo, config: Partial<GraphQLFieldsConfig> = {}) {
    return _.has(GraphQLHelper.getFields(info, config), path);
  }

  /**
   * Check if field is in GraphQL fields
   */
  public static isInFields(path: any, fields: any) {
    return _.has(fields, path);
  }
}
