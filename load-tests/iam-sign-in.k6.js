/**
 * k6 Load Test: IAM Sign-In Performance
 *
 * Measures the latency and throughput of POST /iam/sign-in/email.
 * Each VU signs in with valid credentials (shared test user).
 *
 * Run:
 *   k6 run load-tests/iam-sign-in.k6.js
 */
import { check, sleep } from 'k6';
import { Trend, Counter, Rate } from 'k6/metrics';
import {
  BASE_URL,
  iamSignUp,
  iamSignIn,
  uniqueEmail,
} from './helpers.js';

// ---------------------------------------------------------------------------
// Custom metrics
// ---------------------------------------------------------------------------

const signInDuration = new Trend('iam_sign_in_duration', true);
const signInErrors   = new Counter('iam_sign_in_errors');
const signInSuccess  = new Rate('iam_sign_in_success');

// ---------------------------------------------------------------------------
// Options
// ---------------------------------------------------------------------------

export const options = {
  scenarios: {
    sign_in_load: {
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
    iam_sign_in_duration: ['p(95)<2000', 'p(99)<5000'],
    iam_sign_in_success:  ['rate>0.95'],
    http_req_failed:      ['rate<0.05'],
  },
};

// ---------------------------------------------------------------------------
// Setup – create a shared test user
// ---------------------------------------------------------------------------

export function setup() {
  const email    = uniqueEmail('signin');
  const password = 'K6LoadTestPass123';
  const name     = 'K6 SignIn User';

  const result = iamSignUp(email, password, name);

  if (!result.body || (result.res.status !== 200 && result.res.status !== 201)) {
    console.error(`Setup: sign-up failed (status ${result.res.status})`);
    console.error(result.res.body);
  }

  return { email, password };
}

// ---------------------------------------------------------------------------
// VU code
// ---------------------------------------------------------------------------

export default function (data) {
  const start = Date.now();

  const result = iamSignIn(data.email, data.password);
  const elapsed = Date.now() - start;

  signInDuration.add(elapsed);

  const ok = check(result.res, {
    'status 200':       (r) => r.status === 200,
    'has user':         () => result.body && result.body.user,
    'has session/token': () => result.body && (result.body.session || result.body.token),
  });

  if (ok) {
    signInSuccess.add(1);
  } else {
    signInSuccess.add(0);
    signInErrors.add(1);
  }

  sleep(0.3); // small pause to avoid pure flood
}

// ---------------------------------------------------------------------------
// Teardown
// ---------------------------------------------------------------------------

export function teardown() {
  console.log('Sign-In load test completed.');
}
