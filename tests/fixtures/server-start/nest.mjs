// Fixture: behaves like this repo's built API (dist/main.js) — port from NSC__PORT, Nest's own log lines, then
// the line main.ts prints once the server listens.
import { createServer } from 'node:http';
const port = Number(process.env.NSC__PORT);
console.log('[Nest] 1  - LOG [NestApplication] Nest application successfully started');
createServer((_req, res) => res.end('ok')).listen(port, '127.0.0.1', () =>
  console.log(`Server started at http://[::1]:${port}`),
);
