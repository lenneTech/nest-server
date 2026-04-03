import http from 'k6/http';
import { check } from 'k6';
import { Trend, Counter } from 'k6/metrics';

/**
 * k6 Memory & Performance Load Test for Multi-Tenancy
 *
 * Tests REST endpoints under high concurrency to detect:
 * - Memory growth (via /health or process.memoryUsage endpoint)
 * - Response time degradation under load
 * - Throughput under tenant-scoped requests
 *
 * Usage:
 *   1. Start the server: NODE_ENV=local pnpm start
 *   2. Run test:         k6 run tests/k6/memory-test.js
 *   3. Extended test:    k6 run --duration 5m --vus 50 tests/k6/memory-test.js
 *
 * Compare before/after the performance fixes by running on different branches.
 */

const BASE_URL = __ENV.BASE_URL || 'http://localhost:3000';

// Custom metrics
const memoryHeapUsed = new Trend('memory_heap_used_mb', true);
const memoryRss = new Trend('memory_rss_mb', true);
const requestsPerSecond = new Counter('total_requests');

export const options = {
  scenarios: {
    // Scenario 1: Sustained high load (simulates 15 servers)
    sustained_load: {
      executor: 'constant-vus',
      vus: parseInt(__ENV.VUS || '15'),
      duration: __ENV.DURATION || '60s',
    },
    // Scenario 2: Memory sampling (runs alongside load)
    memory_sampler: {
      executor: 'constant-arrival-rate',
      rate: 1,
      timeUnit: '2s',
      duration: __ENV.DURATION || '60s',
      preAllocatedVUs: 1,
      exec: 'sampleMemory',
    },
  },
  thresholds: {
    http_req_duration: ['p(95)<500'],    // 95% of requests under 500ms
    http_req_failed: ['rate<0.01'],       // Less than 1% failures
    memory_heap_used_mb: ['max<512'],     // Heap should stay under 512MB
    memory_rss_mb: ['max<1024'],          // RSS should stay under 1GB
  },
};

// ============================================================================
// Setup: Create test data (user, tenant, membership)
// ============================================================================

export function setup() {
  let token = null;
  const email = __ENV.K6_EMAIL;
  const password = __ENV.K6_PASSWORD;

  if (!email || !password) {
    console.warn('K6_EMAIL/K6_PASSWORD not set — running unauthenticated load test.');
    console.warn('To test authenticated paths: k6 run -e K6_EMAIL=user@test.com -e K6_PASSWORD=secret tests/k6/memory-test.js');
    return { token: null };
  }

  // Try BetterAuth sign-in with provided credentials
  const signInRes = http.post(`${BASE_URL}/iam/sign-in/email`, JSON.stringify({
    email,
    password,
  }), { headers: { 'Content-Type': 'application/json' } });

  if (signInRes.status === 200) {
    try {
      const body = JSON.parse(signInRes.body);
      token = body.token || body.session?.token;
    } catch (e) {
      // Try cookies
    }
    if (!token && signInRes.cookies && signInRes.cookies['iam.session_token']) {
      token = signInRes.cookies['iam.session_token'][0].value;
    }
  }

  return { token };
}

// ============================================================================
// Main scenario: High-throughput REST requests with tenant context
// ============================================================================

export default function (data) {
  const headers = {
    'Content-Type': 'application/json',
    'X-Tenant-Id': 'k6-test-tenant-' + (__VU % 5), // 5 different tenants
  };

  if (data.token) {
    headers['Authorization'] = `Bearer ${data.token}`;
  }

  // Mix of REST endpoints to simulate real workload
  const endpoints = [
    { method: 'GET', path: '/users', name: 'list_users' },
    { method: 'GET', path: '/health-check', name: 'health_check' },
    { method: 'GET', path: '/users/me', name: 'current_user' },
  ];

  const endpoint = endpoints[Math.floor(Math.random() * endpoints.length)];

  const res = http.request(endpoint.method, `${BASE_URL}${endpoint.path}`, null, {
    headers,
    tags: { name: endpoint.name },
  });

  requestsPerSecond.add(1);

  check(res, {
    'status is not 500': (r) => r.status !== 500,
    'response time < 1s': (r) => r.timings.duration < 1000,
  });
}

// ============================================================================
// Memory sampling scenario
// ============================================================================

export function sampleMemory() {
  // Try the health endpoint which may include memory info
  const res = http.get(`${BASE_URL}/health-check`, {
    tags: { name: 'memory_sample' },
  });

  // Try a dedicated memory endpoint if available
  const memRes = http.get(`${BASE_URL}/debug/memory`, {
    tags: { name: 'memory_debug' },
  });

  if (memRes.status === 200) {
    try {
      const mem = JSON.parse(memRes.body);
      if (mem.heapUsed) {
        memoryHeapUsed.add(mem.heapUsed / 1024 / 1024);
      }
      if (mem.rss) {
        memoryRss.add(mem.rss / 1024 / 1024);
      }
    } catch (e) { /* ignore */ }
  }
}

// ============================================================================
// Teardown: Print summary
// ============================================================================

export function teardown(data) {
  if (__ENV.VERBOSE) {
    console.info('=== k6 Memory Test Complete ===');
    console.info('Check the k6 summary above for:');
    console.info('  - memory_heap_used_mb: heap should stay under 512MB');
    console.info('  - memory_rss_mb: RSS should stay under 1GB');
    console.info('  - http_req_duration p(95): should be under 500ms');
    console.info('  - http_req_failed rate: should be under 1%');
  }
}
