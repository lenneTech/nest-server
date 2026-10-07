import type { DocumentBuilder, SwaggerCustomOptions, SwaggerDocumentOptions } from '@nestjs/swagger';

/**
 * What the Swagger helper knows about one operation, handed to `operationTags`.
 *
 * @since 11.42.7
 */
export interface ISwaggerOperationInfo {
  /**
   * Class name of the controller that serves the operation. For a route Better-Auth serves itself, the
   * project's Better-Auth controller (`BetterAuthController` / `CoreBetterAuthController`).
   */
  controller: string;

  /** Name of the handler method; for a route Better-Auth serves itself, Better-Auth's operation id */
  handler: string;

  /** True when neither the role guard nor the tenant guard requires a sign-in */
  isPublic: boolean;

  /** HTTP method in lower case (`get`, `post`, ...) */
  method: string;

  /** OpenAPI path (`/drop-in/uploads/{analysisId}/status`) */
  path: string;

  /** Scopes released via `@ApiTokenScopes()`, `undefined` when API tokens are refused */
  scopes?: string[];

  /** Tags the operation carries before `operationTags` runs (usually the controller tag) */
  tags: string[];
}

/**
 * The second Swagger document that lists only the routes an API token may call.
 *
 * Follows "presence implies enabled": `true` or `{}` switches it on, `{ enabled: false }` keeps it off.
 *
 * @since 11.42.7
 */
export interface ISwaggerApiTokenViewOptions {
  /**
   * Description of the view. Defaults to the description of the full document.
   */
  description?: string;

  /**
   * Pre-configure without enabling.
   * @default true (when the object is present)
   */
  enabled?: boolean;

  /**
   * Path of the JSON document.
   * @default '/api-docs-api-tokens-json'
   */
  jsonDocumentUrl?: string;

  /**
   * Path of the Swagger UI. Keep it outside the path of the full UI: Swagger UI serves its assets below
   * its own path, and a nested view would share them.
   * @default 'swagger-api-tokens'
   */
  path?: string;

  /**
   * Title of the view.
   * @default '<title> — API tokens'
   */
  title?: string;
}

/**
 * Options of `setupSwagger()` / `buildSwaggerDocument()`.
 *
 * @since 11.42.7
 */
export interface ISwaggerSetupOptions {
  /**
   * Second document with only the routes released for API tokens (`@ApiTokenScopes()`), for partners who
   * integrate with a token and do not need the management routes.
   * @default disabled
   */
  apiTokenView?: boolean | ISwaggerApiTokenViewOptions;

  /**
   * Extend the `DocumentBuilder` before it is built: servers, contact, license, further schemes.
   */
  configureBuilder?: (builder: DocumentBuilder) => DocumentBuilder;

  /**
   * Options for `SwaggerModule.setup()` of both documents (`swaggerOptions`, `customSiteTitle`, ...).
   */
  customOptions?: Omit<SwaggerCustomOptions, 'jsonDocumentUrl' | 'yamlDocumentUrl'>;

  /** Description of the document */
  description?: string;

  /**
   * Options for `SwaggerModule.createDocument()`. `autoTagControllers` and `deepScanRoutes` default to `true`.
   * An own `operationIdFactory` is refused: the helper maps each operation to its handler through the
   * default operation id (`<Controller>_<method>`).
   */
  documentOptions?: Omit<SwaggerDocumentOptions, 'operationIdFactory'>;

  /**
   * Path of the JSON document.
   * @default '/api-docs-json'
   */
  jsonDocumentUrl?: string;

  /**
   * Tags by use case instead of by controller: return the tags of an operation, or `undefined` to keep
   * the ones it has.
   */
  operationTags?: (operation: ISwaggerOperationInfo) => string[] | undefined;

  /**
   * Path of the Swagger UI.
   * @default 'swagger'
   */
  path?: string;

  /**
   * Order and descriptions of the tags. Tags an operation uses but this list does not name follow at the end.
   */
  tags?: { description?: string; name: string }[];

  /** Title of the document */
  title: string;

  /** Version of the document, usually the version of the project's package.json */
  version?: string;
}
