import type { Comparator } from "../types/scim-comparator.type";
import type { LogicalOperator } from "../types/scim-logical-operator.type";
import { ScimNode } from "../types/scim-node.type";


export function scimToMongo(scim: string): any {
  const tokens = tokenize(scim); 
  const ast = parseTokens(tokens); 
  return transformAstToMongo(ast); 
}

/** Escapes Regex Chars */
function escapeRegex(input: string): string {
  return input.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
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
    if (tokens[pos] === '(') { // Start of a nested filter
      pos++; // skip '('
      const expr = parseExpression();
      if (tokens[pos] !== ')') {
        throw new Error(`Expected ')' at position ${pos}`);
      } 
      pos++; // skip ')'
      return expr;
    }
    if (tokens[pos + 1] === '[') { // Start of an array Filter
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
    if (!['co', 'eq', 'ge', 'gt', 'le', 'lt', 'pr', 'sw', 'ew', 'aco'].includes(op)) {
      throw new Error(`Unsupported comparator: ${op}`);
    }    

    let value: null | string;

    if (op !== 'pr') { // "Is Present" doesnt require a value
      value = tokens[pos++]; // Third token is the value
      if (!attr || !op || value === undefined) {
        throw new Error(`Invalid condition syntax at token ${pos}`);
      } 
      if (value?.startsWith('"')) {
        value = value.slice(1, -1);
      } 
    }

    return { attributePath: attr, comparator: op, type: 'condition', value };
  }

  return parseExpression();
}


  /**
   * Tokenizes a SCIM filter string into meaningful parts.
   * e.g., 'userName eq "john"' → ['userName', 'eq', '"john"']
   */
function tokenize(input: string): string[] {
  return input
    .replace(/([()[\]])/g, ' $1 ')                                  // Space out brackets (e.g. "emails[type" → "emails [ type")
    .replace(/\s+/g, ' ')                                           // Normalise whitespaces
    .trim()
    .match(/\[|\]|\(|\)|[a-zA-Z0-9_.]+|"(?:[^"\\]|\\.)*"/g) || [];  // Match tokens: brackets, identifiers, quoted strings
}

/** Converts the parsed SCIM AST to an equivalent MongoDB query object */
function transformAstToMongo(node: ScimNode): any {
  if (!node) {
    return {};
  } 

  if ('operator' in node) {
    return {
      [`$${node.operator}`]: [
        transformAstToMongo(node.left),
        transformAstToMongo(node.right),
      ],
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
    case 'co': // CONTAINS
      return { [attributePath]: { $options: 'i', $regex: escapeRegex(value) } };
    case 'eq': // EQUALS
      return { [attributePath]: { $eq: value } };
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
    case 'ew': // ENDSWITH
      return { [attributePath]: { $regex: `${escapeRegex(value)}$`, $options: 'i' } };
    case 'aco': // ARRAY-CONTAINS (Not case sensitive)
      return { [attributePath]: value };
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