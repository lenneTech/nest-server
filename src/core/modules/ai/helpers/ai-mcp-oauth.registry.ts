/**
 * What is mounted of the MCP OAuth endpoints, for `setupSwagger()` and the MCP controller.
 *
 * The MCP OAuth endpoints are an Express router mounted with `app.use()`, not Nest controllers, so
 * `@nestjs/swagger` cannot see them. The mount records here what it put in place — only then are the
 * endpoints documented, and only then does the MCP endpoint's 401 point clients at the metadata.
 *
 * Imports nothing on purpose: read by the common Swagger helper without pulling in the AI module.
 */
export interface IMountedMcpOAuth {
  /**
   * Path the IAM endpoints answer under (`/iam`, or below a global prefix) — where the consent page
   * signs users in. Unset when the mount could not tell (a manual `mountAiMcpOAuth()`).
   */
  authBasePath?: string;
  /** Public base URL of the server the router describes, without a trailing slash */
  baseUrl: string;
  /** OAuth issuer, as the discovery metadata states it */
  issuerUrl: string;
  /** Path of the protected MCP resource (`/ai/mcp`, or below a global prefix) */
  mcpPath: string;
  /** Whether `/register` (dynamic client registration) is mounted */
  registration: boolean;
  /** URL of the protected resource metadata (RFC 9728) — what a 401 names in `resource_metadata` */
  resourceMetadataUrl: string;
  /** URL of the protected MCP resource */
  resourceUrl: string;
  /** Whether `/revoke` is mounted */
  revocation: boolean;
}

let mounted: IMountedMcpOAuth | undefined;

/** Records the mounted MCP OAuth endpoints (called by the mount). */
export function setMountedMcpOAuth(value: IMountedMcpOAuth | undefined): void {
  mounted = value;
}

/** The mounted MCP OAuth endpoints, or `undefined` when nothing mounted them. */
export function getMountedMcpOAuth(): IMountedMcpOAuth | undefined {
  return mounted;
}
