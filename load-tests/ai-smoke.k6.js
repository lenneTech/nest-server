/**
 * AI module smoke test (no auth) — measures the auth-pipeline latency for the
 * three AI list endpoints introduced in v11.26.0. All return 401 because no
 * Bearer token is provided; the metric of interest is request-handling latency
 * (header parsing, guard chain, ResponseModelInterceptor short-circuit).
 *
 * The test confirms no regression in the request pipeline introduced by the AI
 * module; it does NOT exercise the AI orchestrator (that requires an auth token
 * + a configured AI connection). For real orchestrator load testing, scaffold a
 * scenario that signs in first, then POSTs to /ai/prompt.
 *
 *   k6 run load-tests/ai-smoke.k6.js
 */
import http from 'k6/http';
import { check } from 'k6';
import { Trend, Rate } from 'k6/metrics';

const BASE_URL = __ENV.BASE_URL || 'http://localhost:3000';

const aiDuration = new Trend('ai_endpoint_duration', true);
const aiOk = new Rate('ai_endpoint_ok');

export const options = {
  scenarios: {
    ai_smoke: {
      executor: 'ramping-vus',
      startVUs: 0,
      stages: [
        { duration: '5s', target: 20 },
        { duration: '20s', target: 20 },
        { duration: '5s', target: 0 },
      ],
      gracefulRampDown: '5s',
    },
  },
  thresholds: {
    ai_endpoint_duration: ['p(95)<300', 'p(99)<800'],
    http_req_failed: ['rate<0.01'],
  },
};

const endpoints = [
  '/ai/connections/available',
  '/ai/connections/preferences',
  '/ai/conversations',
];

export default function () {
  for (const path of endpoints) {
    const res = http.get(`${BASE_URL}${path}`);
    aiDuration.add(res.timings.duration);
    // 401 means the pipeline ran through guard chain; that's a successful smoke.
    const ok = check(res, {
      'pipeline reached guard': (r) => r.status === 401 || r.status === 200,
    });
    aiOk.add(ok ? 1 : 0);
  }
}
