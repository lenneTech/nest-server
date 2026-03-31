import http from 'k6/http';
import { sleep } from 'k6';

export const options = {
  vus: 10,
  duration: '30s',
};

export default function () {
  const query = `
    query HealthCheck {
      healthCheck
    }`;
  const headers = {
    'Content-Type': 'application/json',
  };
  http.post(
    'http://localhost:3000/graphql/test',
    JSON.stringify({ query }),
    { headers },
  );
  sleep(1);
}
