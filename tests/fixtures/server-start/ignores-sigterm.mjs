// Fixture: announces readiness and ignores SIGTERM, so only the SIGKILL escalation stops it.
import { createServer } from 'node:http';
process.on('SIGTERM', () => {});
createServer((_req, res) => res.end('ok')).listen(Number(process.env.NITRO_PORT), '127.0.0.1', () =>
  console.log('Listening on it'),
);
