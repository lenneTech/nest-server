/**
 * k6 Load Test: JWT-Authenticated GraphQL Performance
 *
 * Measures the middleware overhead for JWT verification on GraphQL requests.
 * Each VU executes a simple authenticated query with a Bearer JWT token.
 *
 * This test specifically stresses:
 *  - CoreBetterAuthMiddleware JWT verification path
 *  - JWKS key import / HS256 key derivation
 *  - Session lookup after JWT decode
 *
 * Run:
 *   k6 run load-tests/iam-graphql-jwt.k6.js
 */
import { check, sleep } from 'k6';
import { Trend, Counter, Rate } from 'k6/metrics';
import {
  iamSignUp,
  iamSignIn,
  extractJwt,
  graphqlQuery,
  uniqueEmail,
} from './helpers.js';

// ---------------------------------------------------------------------------
// Custom metrics
// ---------------------------------------------------------------------------

const gqlDuration = new Trend('gql_jwt_duration', true);
const gqlErrors   = new Counter('gql_jwt_errors');
const gqlSuccess  = new Rate('gql_jwt_success');

// ---------------------------------------------------------------------------
// Options
// ---------------------------------------------------------------------------

export const options = {
  scenarios: {
    graphql_jwt_load: {
      executor: 'ramping-vus',
      startVUs: 0,
      stages: [
        { duration: '10s', target: 100 },  // ramp up
        { duration: '2m',  target: 100 },  // sustained
        { duration: '10s', target: 0 },    // ramp down
      ],
      gracefulRampDown: '5s',
    },
  },
  thresholds: {
    gql_jwt_duration: ['p(95)<1000', 'p(99)<3000'],
    gql_jwt_success:  ['rate>0.95'],
    http_req_failed:  ['rate<0.05'],
  },
};

// ---------------------------------------------------------------------------
// GraphQL query used by VUs
// ---------------------------------------------------------------------------

const AUTH_QUERY = `
  query {
    betterAuthEnabled
  }
`;

// ---------------------------------------------------------------------------
// Setup – create user and obtain JWT
// ---------------------------------------------------------------------------

export function setup() {
  const email    = uniqueEmail('gqljwt');
  const password = 'K6GqlJwtPass123';
  const name     = 'K6 GQL JWT User';

  iamSignUp(email, password, name);

  const signIn = iamSignIn(email, password);
  const jwt = extractJwt(signIn);

  if (!jwt) {
    console.error('Setup: could not extract JWT from sign-in response');
    console.error(JSON.stringify(signIn.body));
  }

  return { jwt };
}

// ---------------------------------------------------------------------------
// VU code
// ---------------------------------------------------------------------------

export default function (data) {
  if (!data.jwt) {
    console.error('No JWT available – skipping iteration');
    sleep(1);
    return;
  }

  const start = Date.now();

  const result = graphqlQuery(AUTH_QUERY, {}, data.jwt);
  const elapsed = Date.now() - start;

  gqlDuration.add(elapsed);

  const ok = check(result.res, {
    'status 200':      (r) => r.status === 200,
    'no graphql errors': () => !result.body?.errors,
    'has data':          () => !!result.body?.data,
  });

  if (ok) {
    gqlSuccess.add(1);
  } else {
    gqlSuccess.add(0);
    gqlErrors.add(1);
  }

  sleep(0.1); // high frequency to stress middleware
}

// ---------------------------------------------------------------------------
// Teardown
// ---------------------------------------------------------------------------

export function teardown() {
  console.log('GraphQL JWT load test completed.');
}
