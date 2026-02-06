/**
 * k6 Soak Test: Memory-Leak Detection
 *
 * Runs for 10 minutes with moderate load, exercising:
 *  - Sign-in with many unique users (new rate limiter entries per IP)
 *  - Unique X-Forwarded-For IPs to grow the rate limiter Map
 *  - Session lookups
 *
 * Monitor server memory externally while this test runs:
 *   watch -n 2 'ps -o rss,vsz,pid -p $(pgrep -f "node.*nest-server")'
 *
 * Or use the companion script:
 *   ./load-tests/monitor-memory.sh <pid>
 *
 * Run:
 *   k6 run load-tests/iam-memory-soak.k6.js
 */
import { check, sleep } from 'k6';
import { Trend, Counter } from 'k6/metrics';
import http from 'k6/http';
import {
  BASE_URL,
  IAM_URL,
  JSON_HEADERS,
  iamSignUp,
  uniqueEmail,
} from './helpers.js';

// ---------------------------------------------------------------------------
// Custom metrics
// ---------------------------------------------------------------------------

const soakDuration = new Trend('soak_request_duration', true);
const soakErrors   = new Counter('soak_errors');

// ---------------------------------------------------------------------------
// Options  –  20 VUs for 10 minutes
// ---------------------------------------------------------------------------

export const options = {
  scenarios: {
    memory_soak: {
      executor: 'constant-vus',
      vus: 20,
      duration: '10m',
    },
  },
  thresholds: {
    http_req_failed: ['rate<0.30'], // allow some 429s from rate limiter
  },
};

// ---------------------------------------------------------------------------
// Setup – pre-create a pool of users for sign-in
// ---------------------------------------------------------------------------

const USER_POOL_SIZE = 50;

export function setup() {
  const users = [];
  const password = 'K6SoakPass123';

  for (let i = 0; i < USER_POOL_SIZE; i++) {
    const email = uniqueEmail(`soak${i}`);
    const result = iamSignUp(email, password, `Soak User ${i}`);
    if (result.res.status === 200) {
      users.push({ email, password });
    }
  }

  console.log(`Setup: created ${users.length} soak users`);
  return { users };
}

// ---------------------------------------------------------------------------
// VU code  –  mixed workload with unique IPs
// ---------------------------------------------------------------------------

let iterCounter = 0;

export default function (data) {
  if (!data.users || data.users.length === 0) {
    console.error('No soak users available');
    sleep(1);
    return;
  }

  iterCounter++;

  // Pick a random user from the pool
  const user = data.users[Math.floor(Math.random() * data.users.length)];

  // Generate a unique X-Forwarded-For IP to stress rate limiter Map growth
  const fakeIp = `10.${Math.floor(Math.random() * 256)}.${Math.floor(Math.random() * 256)}.${Math.floor(Math.random() * 256)}`;

  const headers = {
    ...JSON_HEADERS,
    'X-Forwarded-For': fakeIp,
  };

  const start = Date.now();

  // Alternate between sign-in and session check
  if (iterCounter % 3 === 0) {
    // Sign-in request
    const res = http.post(
      `${IAM_URL}/sign-in/email`,
      JSON.stringify({ email: user.email, password: user.password }),
      { headers, tags: { endpoint: 'soak-sign-in' } },
    );

    const elapsed = Date.now() - start;
    soakDuration.add(elapsed);

    const ok = check(res, {
      'sign-in ok or rate-limited': (r) => r.status === 200 || r.status === 429,
    });

    if (!ok) soakErrors.add(1);
  } else {
    // Session check (unauthenticated – should return 401)
    const res = http.get(`${IAM_URL}/session`, {
      headers: { ...headers, 'Authorization': `Bearer invalid-token-${iterCounter}` },
      tags: { endpoint: 'soak-session' },
    });

    const elapsed = Date.now() - start;
    soakDuration.add(elapsed);

    // 401 is expected for invalid tokens
    check(res, {
      'session responds': (r) => r.status === 200 || r.status === 401,
    });
  }

  sleep(0.5);
}

// ---------------------------------------------------------------------------
// Teardown
// ---------------------------------------------------------------------------

export function teardown() {
  console.log('Memory soak test completed.');
  console.log('Check server memory with: ps -o rss,pid -p $(pgrep -f "node.*nest-server")');
}
