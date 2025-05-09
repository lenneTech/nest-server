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
import _ = require('lodash');

/**
 * Interface for GraphQLFieldsConfig
 */
export interface GraphQLFieldsConfig {
  excludedFields: string[];
  processArguments: boolean;
}

/**
 * Type ValueNodeWithValueField
 */
export type ValueNodeWithValueField =
  | BooleanValueNode
  | EnumValueNode
  | FloatValueNode
  | IntValueNode
  | StringValueNode
  | VariableNode;

/**
 * GraphQLHelper
 * @deprecated use functions directly
 */
export default class GraphQLHelper {
  /**
   * Check if AST is a Field
   * @param ast
   */
  public static isFieldNode(ast: SelectionNode): ast is FieldNode {
    return isFieldNode(ast);
  }

  /**
   * Check if ValueNode has a value field
   */
  public static isValueNodeWithValueField(value: ValueNode): value is ValueNodeWithValueField {
    return isValueNodeWithValueField(value);
  }

  /**
   * Check ValueNode is a ListValue
   * @param value
   */
  public static isListValueNode(value: ValueNode): value is ListValueNode {
    return isListValueNode(value);
  }

  /**
   * Get selections of AST
   * @deprecated use getASTSelections function
   */
  public static getSelections(ast: FieldNode) {
    return getASTSelections(ast);
  }

  /**
   * Get AST
   */
  public static getAST(ast, info) {
    return getAST(ast, info);
  }

  /**
   * Get arguments of AST
   */
  public static getArguments(ast: FieldNode) {
    return getArguments(ast);
  }

  /**
   * Get directive value from DirectiveNode for GraphQLResolveInfo
   */
  public static getDirectiveValue(directive: DirectiveNode, info: GraphQLResolveInfo) {
    return getDirectiveValue(directive, info);
  }

  /**
   * Get directive results from SelectionNode for GraphQLResolveInfo
   * @param ast
   * @param info
   */
  public static getDirectiveResults(ast: SelectionNode, info: GraphQLResolveInfo) {
    return getDirectiveResults(ast, info);
  }

  /**
   * Create flatten AST from FieldNode for GraphQLResolveInfo
   */
  public static flattenAST(
    ast: FieldNode,
    info: GraphQLResolveInfo,
    obj: any = {},
    config: Partial<GraphQLFieldsConfig> = {},
  ) {
    return flattenAST(ast, info, obj, config);
  }

  /**
   * Get requested fields from GraphQLResolveInfo
   */
  public static getFields(
    info: GraphQLResolveInfo,
    obj: Record<string, any> = {},
    config: Partial<GraphQLFieldsConfig> = {},
  ) {
    return getFields(info, obj, config);
  }

  /**
   * Check if field is in GraphQLResolveInfo
   */
  public static isInGraphQLResolveInfo(path: any, info: GraphQLResolveInfo, config: Partial<GraphQLFieldsConfig> = {}) {
    return isInGraphQLResolveInfo(path, info, config);
  }

  /**
   * Check if field is in GraphQL fields
   */
  public static isInFields(path: any, fields: any) {
    return isInFields(path, fields);
  }
}

/**
 * Create flatten AST from FieldNode for GraphQLResolveInfo
 */
export function flattenAST(
  ast: FieldNode,
  info: GraphQLResolveInfo,
  obj: any = {},
  config: Partial<GraphQLFieldsConfig> = {},
) {
  // Process configuration
  config = Object.assign(
    {
      excludedFields: [],
      processArguments: false,
    },
    config,
  );

  return getASTSelections(ast).reduce((flattened, a) => {
    if (a.directives && a.directives.length) {
      const { shouldInclude, shouldSkip } = getDirectiveResults(a, info);
      // Field/fragment is not included if either the @skip condition is true or the @include condition is false
      // https://facebook.github.io/graphql/draft/#sec--include
      if (shouldSkip || !shouldInclude) {
        return flattened;
      }
    }

    if (isFieldNode(a)) {
      const name = a.name.value;
      if (config.excludedFields.indexOf(name) !== -1) {
        return flattened;
      }

      if (flattened[name] && flattened[name] !== '__arguments') {
        Object.assign(flattened[name], flattenAST(a, info, flattened[name]));
      } else {
        flattened[name] = flattenAST(a, info);
      }

      if (config.processArguments) {
        // check if the current field has arguments
        if (a.arguments && a.arguments.length) {
          Object.assign(flattened[name], {
            __arguments: getArguments(a),
          });
        }
      }
    } else {
      flattened = flattenAST(getAST(a, info), info, flattened);
    }

    return flattened;
  }, obj);
}

/**
 * Get arguments of AST
 */
export function getArguments(ast: FieldNode) {
  return ast.arguments?.map((argument) => {
    const valueNode = argument.value;
    const argumentValue = !isListValueNode(valueNode)
      ? (valueNode as any).value
      : (valueNode as any).values.map(value => value.value);

    return {
      [argument.name.value]: {
        kind: argument.value.kind,
        value: argumentValue,
      },
    };
  });
}

/**
 * Get AST
 */
export function getAST(ast, info) {
  if (ast.kind === 'FragmentSpread') {
    const fragmentName = ast.name.value;
    return info.fragments[fragmentName];
  }
  return ast;
}

/**
 * Get selections of AST
 */
export function getASTSelections(ast: FieldNode) {
  if (ast && ast.selectionSet && ast.selectionSet.selections && ast.selectionSet.selections.length) {
    return ast.selectionSet.selections;
  }

  return [];
}

/**
 * Get directive results from SelectionNode for GraphQLResolveInfo
 * @param ast
 * @param info
 */
export function getDirectiveResults(ast: SelectionNode, info: GraphQLResolveInfo) {
  const directiveResult = {
    shouldInclude: true,
    shouldSkip: false,
  };
  return ast.directives?.reduce((result, directive) => {
    switch (directive.name.value) {
      case 'include':
        return {
          ...result,
          shouldInclude: getDirectiveValue(directive, info),
        };
      case 'skip':
        return {
          ...result,
          shouldSkip: getDirectiveValue(directive, info),
        };
      default:
        return result;
    }
  }, directiveResult);
}

/**
 * Get directive value from DirectiveNode for GraphQLResolveInfo
 */
export function getDirectiveValue(directive: DirectiveNode, info: GraphQLResolveInfo) {
  const arg = directive.arguments?.[0]; // only arg on an include or skip directive is "if"
  if (!arg) {
    return;
  }
  if (arg.value.kind !== 'Variable') {
    const valueNode = arg.value;
    return isValueNodeWithValueField(valueNode) ? !!valueNode.value : false;
  }
  return info.variableValues[arg.value.name.value];
}

/**
 * Get requested fields from GraphQLResolveInfo
 */
export function getFields(
  info: GraphQLResolveInfo,
  obj: Record<string, any> = {},
  config: Partial<GraphQLFieldsConfig> = {},
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
      return flattenAST(ast, info, o, config);
    }, obj) || {}
  );
}

/**
 * Check if AST is a Field
 * @param ast
 */
export function isFieldNode(ast: SelectionNode): ast is FieldNode {
  return ast.kind === 'Field';
}

/**
 * Check if field is in GraphQL fields
 */
export function isInFields(path: any, fields: any) {
  return _.has(fields, path);
}

/**
 * Check if field is in GraphQLResolveInfo
 */
export function isInGraphQLResolveInfo(path: any, info: GraphQLResolveInfo, config: Partial<GraphQLFieldsConfig> = {}) {
  return _.has(getFields(info, config), path);
}

/**
 * Check ValueNode is a ListValue
 * @param value
 */
export function isListValueNode(value: ValueNode): value is ListValueNode {
  return value.kind === 'ListValue';
}

/**
 * Check if ValueNode has a value field
 */
export function isValueNodeWithValueField(value: ValueNode): value is ValueNodeWithValueField {
  return value.kind !== 'NullValue' && value.kind !== 'ListValue' && value.kind !== 'ObjectValue';
}
