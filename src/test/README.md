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

| Option | Type | Default | Description |
|--------|------|---------|-------------|
| `method` | `'GET' \| 'POST' \| 'PUT' \| 'PATCH' \| 'DELETE'` | `'GET'` | HTTP method |
| `token` | `string` | `null` | Bearer token via Authorization header |
| `cookies` | `string \| Record<string, string>` | - | Cookie-based authentication (see below) |
| `headers` | `Record<string, string>` | - | Custom request headers |
| `payload` | `any` | `null` | Request body |
| `statusCode` | `number` | `200` | Expected HTTP status code |
| `returnResponse` | `boolean` | `false` | Return full response including headers |
| `attachments` | `Record<string, string>` | - | File uploads (key: field name, value: file path) |
| `log` | `boolean` | `false` | Log request config to console |
| `logError` | `boolean` | `false` | Log error details when status >= 400 |

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

| Option | Transport | Use Case |
|--------|-----------|----------|
| `token` | `Authorization: Bearer <token>` header | JWT authentication |
| `cookies` | `Cookie` header | Session-based authentication (BetterAuth) |

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
  cookies: session.token,  // Auto -> iam.session_token=...; token=...
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

## GraphQL Testing (`testHelper.graphQl()`)

```typescript
const result = await testHelper.graphQl({
  name: 'findUsers',
  type: TestGraphQLType.QUERY,
  arguments: { filter: { email: { eq: 'test@test.com' } } },
  fields: ['id', 'email', 'name'],
}, {
  token: jwtToken,
  statusCode: 200,
});
```

See `TestGraphQLConfig` and `TestGraphQLOptions` interfaces in `test.helper.ts` for full configuration options.
