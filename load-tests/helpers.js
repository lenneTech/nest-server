import http from 'k6/http';
import { check } from 'k6';

// ---------------------------------------------------------------------------
// Configuration
// ---------------------------------------------------------------------------

export const BASE_URL = __ENV.BASE_URL || 'http://127.0.0.1:3000';
export const IAM_URL = `${BASE_URL}/iam`;
export const GQL_URL = `${BASE_URL}/graphql`;

export const JSON_HEADERS = {
  'Content-Type': 'application/json',
};

// ---------------------------------------------------------------------------
// IAM helpers
// ---------------------------------------------------------------------------

/**
 * Sign up a new user via BetterAuth IAM.
 * Returns the parsed JSON body (contains user + session).
 */
export function iamSignUp(email, password, name) {
  const res = http.post(
    `${IAM_URL}/sign-up/email`,
    JSON.stringify({ email, password, name, termsAndPrivacyAccepted: true }),
    { headers: JSON_HEADERS, tags: { endpoint: 'sign-up' } },
  );

  check(res, {
    'sign-up status ok': (r) => r.status === 200 || r.status === 201,
  });

  return { body: safeJson(res), res };
}

/**
 * Sign in an existing user via BetterAuth IAM.
 * Returns the parsed JSON body (contains user + session + token).
 */
export function iamSignIn(email, password) {
  const res = http.post(
    `${IAM_URL}/sign-in/email`,
    JSON.stringify({ email, password }),
    { headers: JSON_HEADERS, tags: { endpoint: 'sign-in' } },
  );

  check(res, {
    'sign-in status 200': (r) => r.status === 200,
  });

  return { body: safeJson(res), res };
}

/**
 * Get current session via GET /iam/session.
 * Accepts either a JWT bearer token or a session cookie string.
 */
export function iamGetSession({ token, cookie }) {
  const headers = { ...JSON_HEADERS };
  if (token) {
    headers['Authorization'] = `Bearer ${token}`;
  }

  const params = { headers, tags: { endpoint: 'session' } };

  if (cookie) {
    // k6 jar-style cookies
    params.cookies = { 'iam.session_token': cookie };
  }

  const res = http.get(`${IAM_URL}/session`, params);

  check(res, {
    'session status 200': (r) => r.status === 200,
  });

  return { body: safeJson(res), res };
}

// ---------------------------------------------------------------------------
// GraphQL helpers
// ---------------------------------------------------------------------------

/**
 * Execute an authenticated GraphQL query.
 */
export function graphqlQuery(query, variables, token) {
  const headers = { ...JSON_HEADERS };
  if (token) {
    headers['Authorization'] = `Bearer ${token}`;
  }

  const res = http.post(
    GQL_URL,
    JSON.stringify({ query, variables }),
    { headers, tags: { endpoint: 'graphql' } },
  );

  check(res, {
    'graphql status 200': (r) => r.status === 200,
  });

  return { body: safeJson(res), res };
}

// ---------------------------------------------------------------------------
// Token extraction
// ---------------------------------------------------------------------------

/**
 * Extract JWT from sign-in response.
 * BetterAuth returns the token in the session object or as a set-cookie header.
 */
export function extractJwt(signInResult) {
  // 1. Try response body → session.token or token
  const body = signInResult.body;
  if (body) {
    if (body.token) return body.token;
    if (body.session?.token) return body.session.token;
  }

  // 2. Try set-cookie header (lt-jwt-token)
  const setCookie = signInResult.res.headers['Set-Cookie'] || signInResult.res.headers['set-cookie'];
  if (setCookie) {
    const cookies = Array.isArray(setCookie) ? setCookie : [setCookie];
    for (const c of cookies) {
      // BetterAuth JWT cookie
      const jwtMatch = c.match(/lt-jwt-token=([^;]+)/);
      if (jwtMatch) return jwtMatch[1];
      // Generic bearer token cookie
      const tokenMatch = c.match(/token=([^;]+)/);
      if (tokenMatch) return tokenMatch[1];
    }
  }

  return null;
}

/**
 * Extract session cookie value from sign-in response.
 */
export function extractSessionCookie(signInResult) {
  const setCookie = signInResult.res.headers['Set-Cookie'] || signInResult.res.headers['set-cookie'];
  if (!setCookie) return null;

  const cookies = Array.isArray(setCookie) ? setCookie : [setCookie];
  for (const c of cookies) {
    const match = c.match(/iam\.session_token=([^;]+)/);
    if (match) return match[1];
  }
  return null;
}

// ---------------------------------------------------------------------------
// Utility
// ---------------------------------------------------------------------------

function safeJson(res) {
  try {
    return res.json();
  } catch {
    return null;
  }
}

/**
 * Generate a unique test email address.
 */
export function uniqueEmail(prefix) {
  const ts = Date.now();
  const rnd = Math.random().toString(36).substring(2, 8);
  return `${prefix || 'k6'}-${ts}-${rnd}@loadtest.local`;
}

/**
 * Wait for server health-check to pass.
 * k6 setup functions can call this once.
 */
export function waitForServer(maxRetries = 30, delayMs = 1000) {
  for (let i = 0; i < maxRetries; i++) {
    try {
      const res = http.get(`${BASE_URL}/health`, { timeout: '5s' });
      if (res.status === 200) return true;
    } catch {
      // ignore
    }
    // k6 doesn't have a blocking sleep in setup – use a busy-wait
    const end = Date.now() + delayMs;
    while (Date.now() < end) {
      // spin
    }
  }
  return false;
}
