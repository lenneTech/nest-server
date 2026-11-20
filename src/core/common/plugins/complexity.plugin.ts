import { Plugin } from '@nestjs/apollo';
import { GraphQLSchemaHost } from '@nestjs/graphql';
import type { ApolloServerPlugin, BaseContext, GraphQLRequestListener } from '@apollo/server';
import { getVariableValues, GraphQLError, Kind, TypeInfo, ValidationContext, visit, visitWithTypeInfo } from 'graphql';
import type {
  ASTVisitor,
  DefinitionNode,
  DocumentNode,
  FragmentDefinitionNode,
  GraphQLSchema,
  OperationDefinitionNode,
  SelectionSetNode,
} from 'graphql';
import { createComplexityRule, fieldExtensionsEstimator, simpleEstimator } from 'graphql-query-complexity';

import { ConfigService } from '../services/config.service.js';

/**
 * Most variable coercion errors the pre-check collects before it stops. It only needs to know WHETHER the variables
 * coerce, and one error answers that. Every error graphql creates for a variable computes its line and column by
 * scanning the query up to the variable's definition: with execution's cap of 50 the pre-check cost 550 ms for a
 * 959 KiB multipart request whose definitions stood after 490,000 line breaks (12.10.1).
 */
const VARIABLE_COERCION_MAX_ERRORS = 1;

/**
 * Most visits × declared variables the complexity analysis may cost (12.10.1, SEC-4). graphql-query-complexity runs
 * `Object.keys()` over the operation's variables at every field and every `@skip` / `@include` it visits — measured on
 * Node 24 at 12–90 ns per variable and visit, so the limit is reached after at most about 23 ms. 38,000 declared
 * variables and 4,900 visits blocked the event loop for 17 s before. With the default cost of 1 per field, a query
 * `maxComplexity: 1000` accepts has at most 1,000 fields; with 30 variables that is at most 30,000.
 */
const COMPLEXITY_ANALYSIS_MAX_VARIABLE_WORK = 250_000;

/** The visitor graphql-query-complexity builds (the class itself is not exported). */
type ComplexityVisitor = ReturnType<ReturnType<typeof createComplexityRule>>;

/** Fields and `@skip` / `@include` directives in the selection sets — each one a visit with the variables walked. */
function variableVisits(definitions: readonly (FragmentDefinitionNode | OperationDefinitionNode)[]): number {
  let visits = 0;
  const pending: SelectionSetNode[] = definitions.map((definition) => definition.selectionSet);
  while (pending.length) {
    const selectionSet = pending.pop()!;
    for (const selection of selectionSet.selections) {
      for (const directive of selection.directives ?? []) {
        if (directive.name.value === 'include' || directive.name.value === 'skip') {
          visits++;
        }
      }
      if (selection.kind === Kind.FIELD) {
        visits++;
      }
      if (selection.kind !== Kind.FRAGMENT_SPREAD && selection.selectionSet) {
        pending.push(selection.selectionSet);
      }
    }
  }
  return visits;
}

/**
 * The complexity graphql-query-complexity's `getComplexity()` computes, with each fragment evaluated once (12.10.1,
 * SEC-4).
 *
 * The library evaluates a fragment again at EVERY spread, without caching, and at every visit coerces the field's
 * literal arguments again. Its node cap (10,000 visits) bounds the visits, not their cost:
 * `{...F ×3300} fragment F on Query { findUsers(filter: { … value: [0,0,…41,667 items] }) }` blocked the event loop
 * for 2.2 s from a 100 KB JSON POST and for 22.5 s from a 990 KB multipart request — before any guard, with variables
 * that coerce.
 *
 * A fragment's complexity depends on the fragment alone: its type is its type condition, and the variables and the
 * estimators are the same for every spread. So the first spread evaluates it, every further spread reuses the result
 * and adds the nodes the evaluation visited to the library's node count, so a query over 10,000 nodes is refused as
 * before. The number this returns is the one `getComplexity()` returns; the work is that of the document, each
 * fragment once. A field's `complexity` extension (read by `fieldExtensionsEstimator`) must therefore depend only on its
 * arguments and `childComplexity` — as a function it runs once per fragment, not once per spread.
 *
 * The analysis stops at the first error it reports. The library catches the coercion error of every field's arguments
 * and goes on, and `getComplexity()` throws the last one at the end — but every error with a node computes its line and
 * column by scanning the query up to it. `query($x: String = "a") { a: getUser(id: $x) { id } b: … }` with
 * `{"x": null}` is valid, passes the variable check and fails at every one of up to 9,999 fields: 1.4 s from a 98 KiB
 * JSON POST, 86 s from a 993 KiB multipart request with the fields after 395,000 line breaks (12.10.1). The request is
 * refused either way; now with the first error instead of the last.
 *
 * Built like `getComplexity()` (graphql-query-complexity 2.0.0, `QueryComplexity.js`), through the public
 * `createComplexityRule()`; the cache wraps `nodeComplexity` of this one visitor, which the library calls through
 * `this` for every fragment spread.
 */
function computeComplexity(schema: GraphQLSchema, query: DocumentNode, variables: Record<string, unknown>): number {
  const typeInfo = new TypeInfo(schema);
  const context = new ValidationContext(schema, query, typeInfo, (error) => {
    throw error;
  });
  const visitor: ComplexityVisitor = createComplexityRule({
    estimators: [fieldExtensionsEstimator(), simpleEstimator({ defaultComplexity: 1 })],
    // The maximum is checked by the plugin; the visitor only computes.
    maximumComplexity: Infinity,
    variables,
  })(context);

  const evaluate = visitor.nodeComplexity.bind(visitor);
  const fragments = new Map<string, { complexity: number; nodes: number }>();
  visitor.nodeComplexity = (node, typeDef, activeFragments) => {
    if (node.kind !== Kind.FRAGMENT_DEFINITION) {
      return evaluate(node, typeDef, activeFragments);
    }
    const known = fragments.get(node.name.value);
    if (known) {
      visitor.evaluatedNodes += known.nodes;
      if (visitor.evaluatedNodes >= visitor.maxQueryNodes) {
        throw new GraphQLError('Query exceeds the maximum allowed number of nodes.');
      }
      return known.complexity;
    }
    const before = visitor.evaluatedNodes;
    const complexity = evaluate(node, typeDef, activeFragments);
    fragments.set(node.name.value, { complexity, nodes: visitor.evaluatedNodes - before });
    return complexity;
  };

  visit(query, visitWithTypeInfo(typeInfo, visitor as unknown as ASTVisitor));
  return visitor.complexity;
}

@Plugin()
export class ComplexityPlugin implements ApolloServerPlugin {
  constructor(
    private gqlSchemaHost: GraphQLSchemaHost,
    private configService: ConfigService,
  ) {}

  async requestDidStart(): Promise<GraphQLRequestListener<BaseContext>> {
    const maxComplexity: number = this.configService.getFastButReadOnly('graphQl.maxComplexity');
    const { schema } = this.gqlSchemaHost;

    return {
      async didResolveOperation({ document, operation, request }) {
        // No operation resolved: several operations and no `operationName` naming one of them. Apollo still calls this
        // hook, and graphql's `execute()` refuses the request afterwards, before it coerces a single variable.
        // getComplexity() instead evaluated EVERY operation of such a document and coerced the variables for each
        // (12.10.1, SEC-3): 860 operations sharing one 16,000-item variable blocked the event loop for 5.9 s from a
        // 100 KB JSON POST, 1,720 operations for 25.5 s from 200 KB.
        if (!operation) {
          return;
        }

        // Invalid variables (12.10.1, SEC-2): getComplexity() coerces without an error cap, so a list of invalid items
        // created one error per item — 1.5 s and 300 MB for 100 KB, 15 s and 2 GB for 1 MB. Execution refuses such
        // variables itself, with graphql's cap of 50, before any resolver runs, so there is no complexity to compute.
        const { errors } = getVariableValues(schema, operation.variableDefinitions ?? [], request.variables ?? {}, {
          maxErrors: VARIABLE_COERCION_MAX_ERRORS,
        });
        if (errors?.length) {
          return;
        }

        // The resolved operation alone, with the fragments it may spread: the analysis evaluates exactly the operation
        // execution runs, and coerces its variables once.
        const fragments = document.definitions.filter(
          (definition: DefinitionNode): definition is FragmentDefinitionNode =>
            definition.kind === Kind.FRAGMENT_DEFINITION,
        );
        const variableCount = operation.variableDefinitions?.length ?? 0;
        if (variableVisits([operation, ...fragments]) * variableCount > COMPLEXITY_ANALYSIS_MAX_VARIABLE_WORK) {
          throw new GraphQLError('Query is too complex: too many fields for its number of variables');
        }

        const query: DocumentNode = { definitions: [operation, ...fragments], kind: Kind.DOCUMENT };
        const complexity = computeComplexity(schema, query, request.variables ?? {});
        if (maxComplexity !== undefined && complexity > maxComplexity) {
          throw new GraphQLError(`Query is too complex: ${complexity}. Maximum allowed complexity: ${maxComplexity}`);
        }
      },
    };
  }
}
