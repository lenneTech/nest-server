/**
 * k6 Load Test: Session-Cookie Performance
 *
 * Measures GET /iam/session latency when using session cookies.
 * This test stresses the MongoDB aggregation pipeline that looks up
 * sessions and joins user data.
 *
 * Run:
 *   k6 run load-tests/iam-session.k6.js
 */
import { check, sleep } from 'k6';
import { Trend, Counter, Rate } from 'k6/metrics';
import {
  iamSignUp,
  iamSignIn,
  extractSessionCookie,
  extractJwt,
  iamGetSession,
  uniqueEmail,
} from './helpers.js';

// ---------------------------------------------------------------------------
// Custom metrics
// ---------------------------------------------------------------------------

const sessionDuration = new Trend('iam_session_duration', true);
const sessionErrors   = new Counter('iam_session_errors');
const sessionSuccess  = new Rate('iam_session_success');

// ---------------------------------------------------------------------------
// Options
// ---------------------------------------------------------------------------

export const options = {
  scenarios: {
    session_load: {
      executor: 'ramping-vus',
      startVUs: 0,
      stages: [
        { duration: '10s', target: 50 },   // ramp up
        { duration: '1m',  target: 50 },   // sustained
        { duration: '10s', target: 0 },    // ramp down
      ],
      gracefulRampDown: '5s',
    },
  },
  thresholds: {
    iam_session_duration: ['p(95)<1500', 'p(99)<4000'],
    iam_session_success:  ['rate>0.95'],
    http_req_failed:      ['rate<0.05'],
  },
};

// ---------------------------------------------------------------------------
// Setup – create user, sign in, extract session cookie (or JWT fallback)
// ---------------------------------------------------------------------------

export function setup() {
  const email    = uniqueEmail('session');
  const password = 'K6SessionPass123';
  const name     = 'K6 Session User';

  iamSignUp(email, password, name);

  const signIn = iamSignIn(email, password);
  const cookie = extractSessionCookie(signIn);
  const jwt    = extractJwt(signIn);

  if (!cookie && !jwt) {
    console.error('Setup: could not extract session cookie or JWT');
    console.error(JSON.stringify(signIn.body));
  }

  return { cookie, jwt };
}

// ---------------------------------------------------------------------------
// VU code
// ---------------------------------------------------------------------------

export default function (data) {
  const start = Date.now();

  // Prefer cookie-based session; fall back to JWT bearer
  const result = data.cookie
    ? iamGetSession({ cookie: data.cookie })
    : iamGetSession({ token: data.jwt });

  const elapsed = Date.now() - start;

  sessionDuration.add(elapsed);

  const ok = check(result.res, {
    'status 200': (r) => r.status === 200,
    'has user':   () => result.body && result.body.user,
  });

  if (ok) {
    sessionSuccess.add(1);
  } else {
    sessionSuccess.add(0);
    sessionErrors.add(1);
  }

  sleep(0.2);
}

// ---------------------------------------------------------------------------
// Teardown
// ---------------------------------------------------------------------------

export function teardown() {
  console.log('Session load test completed.');
}
