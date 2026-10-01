// Fixture: listens on NITRO_PORT, announces it like Nitro, renders 200.
import { createServer } from 'node:http';
createServer((_req, res) => res.end('ok')).listen(Number(process.env.NITRO_PORT), '127.0.0.1', () => {
  console.log(`Listening on http://127.0.0.1:${process.env.NITRO_PORT}`);
});
