import type { INestApplication } from '@nestjs/common';

/**
 * The address of a listening server, written the way a person opens it in a browser (12.7.2, DEV-4128).
 *
 * `app.getUrl()` reports a server bound to every interface as `http://[::1]:3000` (bound to `::`, Node's default when
 * no host is given) or `http://127.0.0.1:3000` (bound to `0.0.0.0`). Both are loopback addresses of ONE family, and
 * which one a copied address reaches depends on the system — `[::1]` fails where IPv6 loopback is not routed. For a
 * wildcard bind this answers `http://localhost:<port>` instead, which reaches the server on either family. A server
 * bound to one explicit address keeps that address: only it is guaranteed to answer there.
 *
 * Use it for the start message in `main.ts`:
 *
 * ```typescript
 * await server.listen(envConfig.port, envConfig.hostname);
 * console.debug(`Server started at ${await serverDisplayUrl(server)}`);
 * ```
 */
export async function serverDisplayUrl(app: INestApplication): Promise<string> {
  const url = await app.getUrl();
  const bound = app.getHttpServer?.()?.address?.();
  const host = bound && typeof bound === 'object' ? bound.address : undefined;
  if (host !== '::' && host !== '0.0.0.0') {
    return url;
  }
  return url.replace(/^([a-z][a-z0-9+.-]*:\/\/)(\[::1\]|127\.0\.0\.1)(?=:\d+$)/i, '$1localhost');
}
