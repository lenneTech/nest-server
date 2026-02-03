import type { Comparator } from '../types/scim-comparator.type';
import type { LogicalOperator } from '../types/scim-logical-operator.type';

import { ScimNode } from '../types/scim-node.type';

export function scimToMongo(scim: string): any {
  if (!scim) {
    return {};
  }
  const tokens = tokenize(scim);
  const ast = parseTokens(tokens);
  return transformAstToMongo(ast);
}

/** Escapes Regex Chars */
function escapeRegex(input: string): string {
  return input.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/** Flattens consecutive logical operators of the same type to avoid nested structures */
function flattenLogicalOperator(node: ScimNode, targetOperator: LogicalOperator): ScimNode[] {
  if (!('operator' in node)) {
    return [node];
  }

  if (node.operator !== targetOperator) {
    return [node];
  }

  const leftConditions = flattenLogicalOperator(node.left, targetOperator);
  const rightConditions = flattenLogicalOperator(node.right, targetOperator);

  return [...leftConditions, ...rightConditions];
}

/** Parses tokenized SCIM filter into an Abstract Syntax Tree (AST) */
function parseTokens(tokens: string[]): ScimNode {
  let pos = 0;

  /** Parses a full logical expression (e.g., A and B or C) */
  function parseExpression(): ScimNode {
    let left = parseTerm();
    while (tokens[pos] && /^(and|or)$/i.test(tokens[pos])) {
      const op: LogicalOperator = tokens[pos++].toLowerCase() as LogicalOperator;
      const right = parseTerm();
      left = { left, operator: op, right };
    }
    return left;
  }

  /** Parses a single term: either a nested expression, array filter, or condition */
  function parseTerm(): ScimNode {
    if (tokens[pos] === '(') {
      // Start of a nested filter
      pos++; // skip '('
      const expr = parseExpression();
      if (tokens[pos] !== ')') {
        throw new Error(`Expected ')' at position ${pos}`);
      }
      pos++; // skip ')'
      return expr;
    }
    if (tokens[pos + 1] === '[') {
      // Start of an array Filter
      const path = tokens[pos++];
      pos++; // skip '['
      const expr = parseExpression();
      if (tokens[pos] !== ']') {
        throw new Error(`Expected ']' at position ${pos}`);
      }
      pos++; // skip ']'
      return { expr, path, type: 'array' };
    }
    return parseCondition(); // If its neither a nested nor array filter its a simple "propertyKey eq Value"
  }

  /** Parses a basic SCIM condition (e.g., userName eq "Joe") */
  function parseCondition(): ScimNode {
    const attr = tokens[pos++]; // First token is the attribute
    const op: Comparator = tokens[pos++].toLowerCase() as Comparator; // Second token is the operator
    if (!['aco', 'co', 'eq', 'ew', 'ge', 'gt', 'le', 'lt', 'pr', 'sw'].includes(op)) {
      throw new Error(`Unsupported comparator: ${op}`);
    }

    let value: any = null;

    if (op !== 'pr') {
      // "Is Present" doesnt require a value
      let rawValue = tokens[pos++]; // Third token is the value
      if (!attr || !op || rawValue === undefined) {
        throw new Error(`Invalid condition syntax at token ${pos}`);
      }

      // Handle quoted strings
      if (rawValue?.startsWith('"')) {
        rawValue = rawValue.slice(1, -1);
        // For quoted strings, keep as string (don't parse to number/boolean)
        value = rawValue;
      } else {
        // For unquoted values, parse to appropriate type (number, boolean, or string)
        value = parseValue(rawValue);
      }
    }

    return { attributePath: attr, comparator: op, type: 'condition', value };
  }

  return parseExpression();
}

/** Converts string values to appropriate types (number, boolean, or string) */
function parseValue(value: string): any {
  if (value === null || value === undefined) {
    return value;
  }

  // Check if it's a number (integer or float)
  if (/^-?\d+(\.\d+)?$/.test(value)) {
    const numValue = Number(value);
    return isNaN(numValue) ? value : numValue;
  }

  // Check if it's a boolean
  if (value.toLowerCase() === 'true') {
    return true;
  }
  if (value.toLowerCase() === 'false') {
    return false;
  }

  // Return as string for everything else
  return value;
}

/**
 * Tokenizes a SCIM filter string into meaningful parts.
 * e.g., 'userName eq "john"' → ['userName', 'eq', '"john"']
 */
function tokenize(input: string): string[] {
  // Space out brackets, but not inside quoted strings
  let result = '';
  let insideQuotes = false;

  for (let i = 0; i < input.length; i++) {
    const char = input[i];

    if (char === '"' && (i === 0 || input[i - 1] !== '\\')) {
      insideQuotes = !insideQuotes;
      result += char;
    } else if (!insideQuotes && /[()[\]]/.test(char)) {
      result += ` ${char} `;
    } else {
      result += char;
    }
  }

  return (
    result
      .replace(/\s+/g, ' ') // Normalise whitespaces
      .trim()
      .match(/\[|]|\(|\)|[a-zA-Z0-9_.]+|"(?:[^"\\]|\\.)*"/g) || []
  ); // Match tokens: brackets, identifiers, quoted strings
}

/** Converts the parsed SCIM AST to an equivalent MongoDB query object */
function transformAstToMongo(node: ScimNode): any {
  if (!node) {
    return {};
  }

  if ('operator' in node) {
    const operator = node.operator;
    const conditions = flattenLogicalOperator(node, operator);

    return {
      [`$${operator}`]: conditions.map(transformAstToMongo),
    };
  }

  if (node.type === 'array') {
    return {
      [node.path]: {
        $elemMatch: transformAstToMongo(node.expr),
      },
    };
  }

  const { attributePath, comparator, value } = node;
  switch (comparator) {
    case 'aco': // ARRAY-CONTAINS (Not case sensitive)
      return { [attributePath]: value };
    case 'co': // CONTAINS
      return { [attributePath]: { $options: 'i', $regex: escapeRegex(value) } };
    case 'eq': // EQUALS
      return { [attributePath]: { $eq: value } };
    case 'ew': // ENDSWITH
      return { [attributePath]: { $options: 'i', $regex: `${escapeRegex(value)}$` } };
    case 'ge': // GREATER THAN OR EQUAL
      return { [attributePath]: { $gte: value } };
    case 'gt': // GREATER THAN
      return { [attributePath]: { $gt: value } };
    case 'le': // LESS THAN OR EQUAL
      return { [attributePath]: { $lte: value } };
    case 'lt': // LESS THAN
      return { [attributePath]: { $lt: value } };
    case 'pr': // PRESENT (exists)
      return { [attributePath]: { $exists: true } };
    case 'sw': // STARTSWITH
      return { [attributePath]: { $options: 'i', $regex: `^${escapeRegex(value)}` } };
    default:
      throw new Error(`Unsupported comparator: ${comparator}`);
  }
}

/*
================ EXAMPLES ================

Simple condition:
  SCIM: 'userName eq "Joe"'
  → Tokens: ['userName', 'eq', '"Joe"']
  → AST: { attributePath: 'userName', comparator: 'eq', value: 'Joe' }
  → Mongo: { userName: { $eq: 'Joe' } }

Logical combination:
  SCIM: 'userName eq "Joe" and drinksCoffee eq true'
  → Tokens: ['userName', 'eq', '"Joe"', 'and', 'drinksCoffee', 'eq', 'true']
  → AST:
    {
      operator: 'and',
      left: { attributePath: 'userName', comparator: 'eq', value: 'Joe' },
      right: { attributePath: 'drinksCoffee', comparator: 'eq', value: 'true' }
    }
  → Mongo:
    {
      $and: [
        { userName: { $eq: 'Joe' } },
        { drinksCoffee: { $eq: 'true' } }
      ]
    }

Array filter:
  SCIM: 'emails[type eq "work"]'
  → Tokens: ['emails', '[', 'type', 'eq', '"work"', ']']
  → AST:
    {
      type: 'array',
      path: 'emails',
      expr: { attributePath: 'type', comparator: 'eq', value: 'work' }
    }
  → Mongo:
    {
      emails: {
        $elemMatch: { type: { $eq: 'work' } }
      }
    }

*/
