# TestHelper Reference

The `TestHelper` class provides utilities for testing GraphQL and REST APIs in `@lenne.tech/nest-server` projects.

## Initialization

```typescript
import { TestHelper } from '@lenne.tech/nest-server';

const app = moduleFixture.createNestApplication();
await app.init();
const testHelper = new TestHelper(app);

// With WebSocket support for subscriptions
const testHelper = new TestHelper(app, 'ws://127.0.0.1:3030/graphql');
```

## REST API Testing (`testHelper.rest()`)

```typescript
const result = await testHelper.rest('/endpoint', options);
```

### TestRestOptions

| Option           | Type                                              | Default | Description                                      |
| ---------------- | ------------------------------------------------- | ------- | ------------------------------------------------ |
| `method`         | `'GET' \| 'POST' \| 'PUT' \| 'PATCH' \| 'DELETE'` | `'GET'` | HTTP method                                      |
| `token`          | `string`                                          | `null`  | Bearer token via Authorization header            |
| `cookies`        | `string \| Record<string, string>`                | -       | Cookie-based authentication (see below)          |
| `headers`        | `Record<string, string>`                          | -       | Custom request headers                           |
| `payload`        | `any`                                             | `null`  | Request body                                     |
| `statusCode`     | `number`                                          | `200`   | Expected HTTP status code                        |
| `returnResponse` | `boolean`                                         | `false` | Return full response including headers           |
| `attachments`    | `Record<string, string>`                          | -       | File uploads (key: field name, value: file path) |
| `log`            | `boolean`                                         | `false` | Log request config to console                    |
| `logError`       | `boolean`                                         | `false` | Log error details when status >= 400             |

## Cookie Authentication

The `cookies` option supports three modes with **auto-detection**:

### 1. Plain Session Token (Auto-Detection)

When a string **without** `=` or `;` is provided, it is automatically recognized as a session token and converted via `buildBetterAuthCookies()`:

```typescript
// Auto-detection: plain token -> sets iam.session_token + token cookies
const result = await testHelper.rest('/endpoint', {
  cookies: sessionToken,
});
```

This is equivalent to:

```typescript
cookies: { 'iam.session_token': sessionToken, 'token': sessionToken }
```

### 2. Explicit Cookie Pairs

```typescript
const result = await testHelper.rest('/endpoint', {
  cookies: { 'iam.session_token': token, 'custom-cookie': 'value' },
});
```

### 3. Raw Cookie String

When a string **with** `=` or `;` is provided, it is used as-is:

```typescript
const result = await testHelper.rest('/endpoint', {
  cookies: 'iam.session_token=abc; token=xyz',
});
```

### `token` vs `cookies`

| Option    | Transport                              | Use Case                                  |
| --------- | -------------------------------------- | ----------------------------------------- |
| `token`   | `Authorization: Bearer <token>` header | JWT authentication                        |
| `cookies` | `Cookie` header                        | Session-based authentication (BetterAuth) |

Both can be used simultaneously without conflict - `token` sets the Authorization header while `cookies` sets the Cookie header.

## Static Helper Methods

### `TestHelper.buildBetterAuthCookies(sessionToken, basePath?)`

Build a cookie Record for BetterAuth session authentication:

```typescript
const cookies = TestHelper.buildBetterAuthCookies('session-token-value');
// Result: { 'iam.session_token': 'session-token-value', 'token': 'session-token-value' }

// Custom base path
const cookies = TestHelper.buildBetterAuthCookies('token', 'auth');
// Result: { 'auth.session_token': 'token', 'token': 'token' }
```

### `TestHelper.extractSessionToken(response, cookieName?)`

Extract a session token from Set-Cookie headers. Handles signed cookies (`value.signature` format):

```typescript
const response = await testHelper.rest('/iam/sign-in/email', {
  method: 'POST',
  payload: { email, password },
  returnResponse: true,
});
const sessionToken = TestHelper.extractSessionToken(response);
// Returns the token value from 'iam.session_token' cookie

// Custom cookie name
const token = TestHelper.extractSessionToken(response, 'custom.session_token');
```

### `TestHelper.extractCookies(response)`

Extract all Set-Cookie values as a `Record<name, value>`:

```typescript
const response = await testHelper.rest('/iam/sign-in/email', {
  method: 'POST',
  payload: { email, password },
  returnResponse: true,
});
const cookies = TestHelper.extractCookies(response);
// Result: { 'iam.session_token': 'abc.sig', 'token': 'abc.sig', ... }
```

## Practical Examples

### JWT Authentication

```typescript
const signIn = await testHelper.rest('/iam/sign-in/email', {
  method: 'POST',
  payload: { email: 'user@test.com', password: 'Password123!' },
});
const jwtToken = signIn.token;

await testHelper.rest('/protected-endpoint', {
  token: jwtToken,
});
```

### Cookie Authentication (Auto-Detection)

```typescript
// Get session token from database after sign-in
const session = await db.collection('session').findOne({ userId: user._id });

// Use session token with auto-detection
await testHelper.rest('/protected-endpoint', {
  cookies: session.token, // Auto -> iam.session_token=...; token=...
});
```

### Extract Session Token from Response

```typescript
const response = await testHelper.rest('/iam/sign-in/email', {
  method: 'POST',
  payload: { email, password },
  returnResponse: true,
});
const sessionToken = TestHelper.extractSessionToken(response);

// Use extracted token for subsequent requests
await testHelper.rest('/protected-endpoint', {
  cookies: sessionToken,
});
```

## File Download Testing (`testHelper.download()` / `testHelper.downloadBuffer()`)

### `download(url, tokenOrOptions?)`

Download a file and return the response with a `data` string property for content comparison.

```typescript
// The core download routes are gated by `file.downloadRoles` (default ADMIN),
// so a request without credentials answers 401 — pass a token or a session cookie.
const res = await testHelper.download('/files/id/abc123', { token: adminToken });
expect(res.statusCode).toEqual(200);
expect(res.data).toEqual('file content');

// Without credentials:
const anonymous = await testHelper.download('/files/id/abc123');
expect(anonymous.statusCode).toEqual(401);
```

### `downloadBuffer(url, tokenOrOptions?)`

Download a file and return a `Buffer` for binary comparison or saving.

```typescript
const buffer = await testHelper.downloadBuffer('/files/id/abc123', jwtToken);
await fs.promises.writeFile('/tmp/downloaded.bin', buffer);
```

### TestDownloadOptions

The second parameter accepts either a plain token string or a `TestDownloadOptions` object:

| Option    | Type     | Description                                                   |
| --------- | -------- | ------------------------------------------------------------- |
| `token`   | `string` | Bearer token via Authorization header (JWT)                   |
| `cookies` | `string` | Plain session token, converted via `buildBetterAuthCookies()` |

Both can be used simultaneously — `token` sets the Authorization header while `cookies` sets the Cookie header.

```typescript
// String form (backward compatible) — sets Authorization: bearer <token>
await testHelper.download('/files/id/abc123', jwtToken);

// Options object with JWT token
await testHelper.download('/files/id/abc123', { token: jwtToken });

// Options object with cookie-based session auth
await testHelper.download('/files/id/abc123', { cookies: sessionToken });

// Both simultaneously
await testHelper.download('/files/id/abc123', { cookies: sessionToken, token: jwtToken });
```

## GraphQL Testing (`testHelper.graphQl()`)

```typescript
const result = await testHelper.graphQl(
  {
    name: 'findUsers',
    type: TestGraphQLType.QUERY,
    arguments: { filter: { email: { eq: 'test@test.com' } } },
    fields: ['id', 'email', 'name'],
  },
  {
    token: jwtToken,
    statusCode: 200,
  },
);
```

See `TestGraphQLConfig` and `TestGraphQLOptions` interfaces in `test.helper.ts` for full configuration options.

## MCP Testing (`testHelper.mcp()` / `testHelper.mcpSession()`)

An MCP client reaches the same services as REST and GraphQL through its own door: the MCP server of the AI module
(`/ai/mcp`, enabled with `ai.mcp` in `config.env.ts`) has its own role filter, its own sessions, and reports a refused
or failing tool as a result with `isError: true` instead of an HTTP error. A project that enables MCP therefore tests
its tools over MCP too, next to its API tests.

The transport answers requests as an SSE stream. These helpers handle the stream, the session header and the
handshake, so a test reads results directly.

### `mcpSession(options?)`

Opens a session the way every MCP client does (`initialize`, then `notifications/initialized`) for the user of `token`
or `cookies`:

```typescript
const session = await testHelper.mcpSession({ token: userToken });

// tools/list — filtered by the user's roles
const names = (await session.listTools()).map((tool) => tool.name);
expect(names).toContain('find_users');

// tools/call — `json` is the first text content parsed as JSON (the tool's own result)
const result = await session.callTool('find_users', { query: '@test.com' });
expect(result.isError).toBeFalsy();
expect(result.json.data.length).toBeGreaterThan(0);

// A tool outside the user's roles is refused, not run
const refused = await session.callTool('delete_user', { id });
expect(refused.isError).toBe(true);

// Any other JSON-RPC request; returns the whole message, protocol errors included
const reply = await session.request('prompts/list');

// End the session server-side
await session.close();
```

| Member                               | Description                                                              |
| ------------------------------------ | ------------------------------------------------------------------------ |
| `sessionId`                          | `mcp-session-id` the server assigned                                     |
| `initializeResult`                   | Result of `initialize` (`serverInfo`, `capabilities`, `protocolVersion`) |
| `listTools()`                        | `tools/list`, returns the tools array                                    |
| `callTool(name, args?)`              | `tools/call`, returns the `CallToolResult` plus `json`                   |
| `request(method, params?, options?)` | Any request in the session, returns the JSON-RPC message                 |
| `close()`                            | `DELETE` with the session id                                             |

### `mcp(message, options?)`

Sends a single JSON-RPC message and returns `{ message, response, sessionId }`. Use it for the HTTP-level cases a
session hides:

```typescript
// No token → 401
await testHelper.mcp({ id: 1, method: 'initialize', params: {} }, { statusCode: 401 });

// Another user's session id → 404 (not 403: confirming the id exists would be an oracle)
await testHelper.mcp(
  { id: 2, method: 'tools/list' },
  { sessionId: adminSession.sessionId, statusCode: 404, token: userToken },
);
```

### TestMcpOptions

| Option             | Type                               | Default                         | Description                                     |
| ------------------ | ---------------------------------- | ------------------------------- | ----------------------------------------------- |
| `token`            | `string`                           | -                               | Bearer token, the same one `rest()` takes       |
| `cookies`          | `string \| Record<string, string>` | -                               | Cookie authentication, same modes as `rest()`   |
| `sessionId`        | `string`                           | -                               | `mcp-session-id` header (`mcp()` only)          |
| `statusCode`       | `number`                           | `200`, `202` for a notification | Expected HTTP status (`mcp()` only)             |
| `path`             | `string`                           | `'/ai/mcp'`                     | Endpoint, for a project with its own MCP module |
| `headers`          | `Record<string, string>`           | -                               | Additional headers                              |
| `log` / `logError` | `boolean`                          | `false`                         | Same as `rest()`                                |

`mcpSession()` additionally takes `clientInfo` and `protocolVersion` for the `initialize` request.
`TestHelper.parseMcpMessage(response)` is the parser behind both, for tests that send requests themselves.