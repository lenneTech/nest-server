/**
 * k6 Load Test: Full REST Flow with Cookie/JWT handling
 *
 * Tests the complete REST authentication lifecycle:
 *  1. Sign-Up (creates user)
 *  2. Sign-In (obtains token/cookie)
 *  3. Authenticated GET /iam/session (with cookie or JWT)
 *  4. Sign-Out
 *
 * This test exercises the full middleware chain including:
 *  - CoreBetterAuthMiddleware (token/cookie parsing)
 *  - CoreBetterAuthApiMiddleware (BetterAuth native handler forwarding)
 *  - Password hashing (scrypt via native crypto)
 *  - Session creation and lookup
 *  - User mapping and linking
 *
 * Run:
 *   k6 run load-tests/iam-rest-cookie.k6.js
 */
import { check, sleep } from 'k6';
import { Trend, Counter, Rate } from 'k6/metrics';
import http from 'k6/http';
import {
  BASE_URL,
  IAM_URL,
  JSON_HEADERS,
  iamSignUp,
  iamSignIn,
  extractJwt,
  extractSessionCookie,
  uniqueEmail,
} from './helpers.js';

// ---------------------------------------------------------------------------
// Custom metrics
// ---------------------------------------------------------------------------

const signInDuration  = new Trend('rest_sign_in_duration', true);
const sessionDuration = new Trend('rest_session_duration', true);
const signOutDuration = new Trend('rest_sign_out_duration', true);
const fullFlowDuration = new Trend('rest_full_flow_duration', true);
const restErrors       = new Counter('rest_flow_errors');
const restSuccess      = new Rate('rest_flow_success');

// ---------------------------------------------------------------------------
// Options
// ---------------------------------------------------------------------------

export const options = {
  scenarios: {
    rest_cookie_flow: {
      executor: 'ramping-vus',
      startVUs: 0,
      stages: [
        { duration: '10s', target: 30 },  // ramp up
        { duration: '1m',  target: 30 },  // sustained
        { duration: '10s', target: 0 },   // ramp down
      ],
      gracefulRampDown: '5s',
    },
  },
  thresholds: {
    rest_sign_in_duration:  ['p(95)<1500'],
    rest_session_duration:  ['p(95)<500'],
    rest_full_flow_duration: ['p(95)<2500'],
    rest_flow_success:      ['rate>0.95'],
    http_req_failed:        ['rate<0.05'],
  },
};

// ---------------------------------------------------------------------------
// Setup – create a pool of users for the VUs
// ---------------------------------------------------------------------------

const USER_POOL_SIZE = 30;

export function setup() {
  const users = [];
  const password = 'K6RestCookiePass123';

  for (let i = 0; i < USER_POOL_SIZE; i++) {
    const email = uniqueEmail(`rest${i}`);
    const signUp = iamSignUp(email, password, `K6 REST User ${i}`);
    if (signUp.res.status === 200 || signUp.res.status === 201) {
      users.push({ email, password });
    }
  }

  console.log(`Setup: created ${users.length} REST test users`);
  return { users };
}

// ---------------------------------------------------------------------------
// VU code – full REST flow per iteration
// ---------------------------------------------------------------------------

export default function (data) {
  if (!data.users || data.users.length === 0) {
    console.error('No users available');
    sleep(1);
    return;
  }

  const user = data.users[Math.floor(Math.random() * data.users.length)];
  const flowStart = Date.now();
  let allOk = true;

  // ---- Step 1: Sign-In ----
  const signInStart = Date.now();
  const signInRes = http.post(
    `${IAM_URL}/sign-in/email`,
    JSON.stringify({ email: user.email, password: user.password }),
    { headers: JSON_HEADERS, tags: { endpoint: 'rest-sign-in' } },
  );
  signInDuration.add(Date.now() - signInStart);

  const signInOk = check(signInRes, {
    'sign-in 200':  (r) => r.status === 200,
    'has token or cookie': (r) => {
      const body = safeJson(r);
      if (body?.token) return true;
      const setCookie = r.headers['Set-Cookie'] || r.headers['set-cookie'];
      return !!setCookie;
    },
  });
  if (!signInOk) allOk = false;

  // Extract auth credentials
  const signInBody = safeJson(signInRes);
  const jwt = signInBody?.token || signInBody?.session?.token;

  // Also extract session cookie if present
  let sessionCookie = null;
  const setCookie = signInRes.headers['Set-Cookie'] || signInRes.headers['set-cookie'];
  if (setCookie) {
    const cookies = Array.isArray(setCookie) ? setCookie : [setCookie];
    for (const c of cookies) {
      const match = c.match(/iam\.session_token=([^;]+)/);
      if (match) { sessionCookie = match[1]; break; }
    }
  }

  // ---- Step 2: Authenticated session check ----
  if (jwt || sessionCookie) {
    const sessionStart = Date.now();

    const sessionHeaders = { ...JSON_HEADERS };
    const sessionParams = { headers: sessionHeaders, tags: { endpoint: 'rest-session' } };

    if (sessionCookie) {
      // Cookie-based auth
      sessionParams.cookies = { 'iam.session_token': sessionCookie };
    } else if (jwt) {
      // JWT-based auth
      sessionHeaders['Authorization'] = `Bearer ${jwt}`;
    }

    const sessionRes = http.get(`${IAM_URL}/session`, sessionParams);
    sessionDuration.add(Date.now() - sessionStart);

    const sessionOk = check(sessionRes, {
      'session 200': (r) => r.status === 200,
      'session responds': () => {
        const body = safeJson(sessionRes);
        // In JWT mode: { success: false } (no cookie session)
        // In cookie mode: { user: {...}, session: {...} }
        return body !== null;
      },
    });
    if (!sessionOk) allOk = false;

    // ---- Step 3: Sign-Out ----
    const signOutStart = Date.now();

    const signOutHeaders = { ...JSON_HEADERS };
    const signOutParams = { headers: signOutHeaders, tags: { endpoint: 'rest-sign-out' } };

    if (sessionCookie) {
      signOutParams.cookies = { 'iam.session_token': sessionCookie };
    } else if (jwt) {
      signOutHeaders['Authorization'] = `Bearer ${jwt}`;
    }

    const signOutRes = http.post(`${IAM_URL}/sign-out`, null, signOutParams);
    signOutDuration.add(Date.now() - signOutStart);

    check(signOutRes, {
      'sign-out ok': (r) => r.status === 200 || r.status === 201 || r.status === 204,
    });
  }

  // Full flow timing
  fullFlowDuration.add(Date.now() - flowStart);

  if (allOk) {
    restSuccess.add(1);
  } else {
    restSuccess.add(0);
    restErrors.add(1);
  }

  sleep(0.3);
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function safeJson(res) {
  try { return res.json(); } catch { return null; }
}

// ---------------------------------------------------------------------------
// Teardown
// ---------------------------------------------------------------------------

export function teardown() {
  console.log('REST Cookie/JWT flow load test completed.');
}
