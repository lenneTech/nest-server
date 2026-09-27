// Fixture: listens and announces, but every render throws (the mis-traced-bundle case).
import { createServer } from 'node:http';
createServer((_req, res) => {
  res.statusCode = 500;
  res.end('render failed');
}).listen(Number(process.env.NITRO_PORT), '127.0.0.1', () => console.log('Listening on it'));
