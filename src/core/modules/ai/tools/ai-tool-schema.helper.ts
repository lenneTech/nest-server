import type { AiToolAuthorization, AiToolContext, IAiTool } from '../interfaces/ai-tool.interface.js';

/**
 * Standard Schema support for `IAiTool.parameters` (12.10.0, nestjs-ai plan §3): a tool may declare its parameters
 * with Zod 4.2+, ArkType, Valibot (`toStandardJsonSchema()`) or any other schema that implements Standard Schema WITH
 * JSON Schema (`~standard.jsonSchema`) — the shape `@nestjs/ai` and `@nestjs/mcp` accept too, so one schema serves all
 * three. Duck-typed: the core imports no schema library.
 */

/** A Standard Schema that also produces JSON Schema (https://standardschema.dev). */
export interface AiStandardSchema {
  readonly '~standard': {
    readonly jsonSchema?: { readonly input: (options: { target: string }) => Record<string, unknown> };
    readonly validate: (
      value: unknown,
    ) =>
      | { readonly issues?: undefined; readonly value: unknown }
      | { readonly issues: ReadonlyArray<{ readonly message: string; readonly path?: ReadonlyArray<unknown> }> }
      | Promise<
          | { readonly issues?: undefined; readonly value: unknown }
          | { readonly issues: ReadonlyArray<{ readonly message: string; readonly path?: ReadonlyArray<unknown> }> }
        >;
    readonly vendor: string;
    readonly version: 1;
  };
}

/** Whether `value` is a Standard Schema (with or without JSON Schema). */
export function isStandardSchema(value: unknown): value is AiStandardSchema {
  const standard = (value as AiStandardSchema | undefined)?.['~standard'];
  return !!standard && typeof standard === 'object' && typeof standard.validate === 'function';
}

/** JSON Schema drafts in order of preference: what model providers read, then what MCP uses. */
const JSON_SCHEMA_TARGETS = ['draft-07', 'draft-2020-12'];

/**
 * The JSON Schema of a Standard Schema's INPUT side (what the model writes). Throws when the schema cannot produce one
 * or describes something other than an object — a tool's arguments are an object, and a schema the model cannot be
 * sent is a configuration error, not something to guess around.
 */
export function standardSchemaToJsonSchema(schema: AiStandardSchema, where: string): Record<string, any> {
  const standard = schema['~standard'];
  if (typeof standard.jsonSchema?.input !== 'function') {
    throw new Error(
      `${where}: the "${standard.vendor}" schema cannot produce JSON Schema (no ~standard.jsonSchema), which the model ` +
        'needs. Zod needs 4.2 or later; Valibot needs toStandardJsonSchema() from @valibot/to-json-schema.',
    );
  }
  let failure: unknown;
  for (const target of JSON_SCHEMA_TARGETS) {
    try {
      const root = standard.jsonSchema.input({ target });
      if (root && typeof root === 'object') {
        if (root.type !== undefined && root.type !== 'object') {
          throw new Error(
            `${where}: tool arguments are an object, and this schema describes ${JSON.stringify(root.type)}`,
          );
        }
        return root as Record<string, any>;
      }
    } catch (error) {
      failure = error;
      if ((error as Error)?.message?.startsWith(where)) {
        throw error;
      }
    }
  }
  throw new Error(`${where}: the schema cannot be converted to JSON Schema: ${(failure as Error)?.message ?? failure}`);
}

/** Validation issues as one line each, with their path — what the model reads to correct itself. */
export function formatSchemaIssues(issues: ReadonlyArray<{ message: string; path?: ReadonlyArray<unknown> }>): string {
  return issues
    .map((issue) => {
      const path = (issue.path ?? [])
        .map((segment) =>
          String(
            segment && typeof segment === 'object' && 'key' in segment ? (segment as { key: unknown }).key : segment,
          ),
        )
        .join('.');
      return path ? `${path}: ${issue.message}` : issue.message;
    })
    .join('; ');
}

/**
 * A tool whose `parameters` is a Standard Schema, as the registry stores it: `parameters` becomes the JSON Schema (what
 * the model, the prompt catalog and MCP `tools/list` read), and `authorize()` and `execute()` receive the VALIDATED
 * arguments — invalid ones never reach either: `authorize()` refuses with the issues, `execute()` reports them as a
 * failed call the model can correct. Any other tool is returned unchanged.
 */
export function withStandardSchemaParameters(tool: IAiTool): IAiTool {
  const schema: unknown = tool.parameters;
  if (!isStandardSchema(schema)) {
    return tool;
  }
  const where = `AI tool "${tool.name}" parameters`;
  const jsonSchema = standardSchemaToJsonSchema(schema, where);

  const validate = async (args: Record<string, any>) => {
    const outcome = await schema['~standard'].validate(args ?? {});
    if ('issues' in outcome && outcome.issues) {
      return { error: `Invalid arguments: ${formatSchemaIssues(outcome.issues)}` };
    }
    return { value: ((outcome as { value?: unknown }).value ?? {}) as Record<string, any> };
  };

  const normalised: IAiTool = Object.create(tool, {
    execute: {
      value: async (args: Record<string, any>, context: AiToolContext) => {
        const checked = await validate(args);
        if ('error' in checked) {
          return { message: checked.error, success: false };
        }
        return tool.execute.call(tool, checked.value, context);
      },
    },
    parameters: { enumerable: true, value: jsonSchema },
  });
  if (typeof tool.authorize === 'function') {
    Object.defineProperty(normalised, 'authorize', {
      value: async (args: Record<string, any>, context: AiToolContext): Promise<AiToolAuthorization | boolean> => {
        const checked = await validate(args);
        if ('error' in checked) {
          return { allowed: false, reason: checked.error };
        }
        return tool.authorize.call(tool, checked.value, context);
      },
    });
  }
  return normalised;
}
