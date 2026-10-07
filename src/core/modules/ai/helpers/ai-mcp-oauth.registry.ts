/**
 * What `mountAiMcpOAuth()` mounted, for `setupSwagger()`.
 *
 * The MCP OAuth endpoints are an Express router mounted with `app.use()`, not Nest controllers, so
 * `@nestjs/swagger` cannot see them. The mount records here what it put in place — only then are the
 * endpoints documented, so the document follows the actual call in `main.ts`, not a config flag.
 *
 * Imports nothing on purpose: read by the common Swagger helper without pulling in the AI module.
 */
export interface IMountedMcpOAuth {
  /** Path of the protected MCP resource (`/ai/mcp`) */
  mcpPath: string;
  /** Whether `/register` (dynamic client registration) is mounted */
  registration: boolean;
  /** Whether `/revoke` is mounted */
  revocation: boolean;
}

let mounted: IMountedMcpOAuth | undefined;

/** Records the mounted MCP OAuth endpoints (called by `mountAiMcpOAuth()`). */
export function setMountedMcpOAuth(value: IMountedMcpOAuth | undefined): void {
  mounted = value;
}

/** The mounted MCP OAuth endpoints, or `undefined` when `mountAiMcpOAuth()` was not called. */
export function getMountedMcpOAuth(): IMountedMcpOAuth | undefined {
  return mounted;
}
