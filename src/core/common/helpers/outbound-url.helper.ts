import { lookup as dnsLookup, type LookupAddress } from 'node:dns';
import { BlockList, isIP } from 'node:net';
import { Agent, buildConnector, fetch as undiciFetch } from 'undici';

import { ConfigService } from '../services/config.service';

/**
 * Requests to a URL a USER entered — a webhook, an export target, an ERP address.
 *
 * The server calls such a URL from inside its own network. Without a check, a user points it at the
 * neighbourhood — the database, other containers, the cloud metadata service at 169.254.169.254 — and,
 * wherever the response is stored or shown, reads the answer back (SSRF).
 *
 * **Only for user-entered URLs.** Targets the operator configured (AI providers, SMTP, S3, Redis,
 * Brevo) do not go through this; nothing here is applied globally.
 *
 * The check runs twice on purpose:
 * 1. {@link assertOutboundUrlAllowed} on the URL before anything is sent — a readable error, and
 * 2. on every connection through {@link createOutboundDispatcher} — the only place that sees a
 *    redirect's next hop and the address a DNS name resolves to at connect time (rebinding).
 *
 * {@link outboundFetch} does both.
 *
 * Internal targets are refused on deployed stages (including `test`) and allowed locally, in e2e and CI,
 * where the counterpart often runs in the same network. `security.allowPrivateOutboundTargets`
 * (`NSC__SECURITY__ALLOW_PRIVATE_OUTBOUND_TARGETS=true|false`) decides it explicitly either way;
 * `allowedHosts` frees individual internal hosts without opening all of them.
 */

const blocked = new BlockList();
for (const [network, prefix] of [
  ['0.0.0.0', 8], // "this network"
  ['10.0.0.0', 8], // RFC 1918
  ['100.64.0.0', 10], // carrier-grade NAT
  ['127.0.0.0', 8], // loopback
  ['169.254.0.0', 16], // link-local, incl. the cloud metadata service
  ['172.16.0.0', 12], // RFC 1918
  ['192.0.0.0', 24], // IETF protocol assignments
  ['192.168.0.0', 16], // RFC 1918
  ['198.18.0.0', 15], // benchmarking
  ['224.0.0.0', 4], // multicast
  ['240.0.0.0', 4], // reserved, incl. broadcast
] as const) {
  blocked.addSubnet(network, prefix, 'ipv4');
}
for (const [network, prefix] of [
  ['::', 96], // unspecified, loopback and IPv4-compatible (::a.b.c.d)
  ['64:ff9b::', 96], // NAT64 — embeds an IPv4 address
  ['fc00::', 7], // unique local
  ['fe80::', 10], // link-local
  ['ff00::', 8], // multicast
] as const) {
  blocked.addSubnet(network, prefix, 'ipv6');
}

/**
 * Environments in which internal targets are allowed unless configured otherwise. Deliberately NOT
 * `test`: in projects built from nest-server-starter that is a DEPLOYED stage.
 */
const LOCAL_ENVIRONMENTS = new Set(['ci', 'e2e', 'local']);

/** Thrown for a target that is, or resolves to, an internal address. */
export class OutboundUrlBlockedError extends Error {
  constructor(
    readonly host: string,
    readonly address: string,
  ) {
    super(
      `Outbound target not allowed: "${host}" points to the internal address ${address}. ` +
        'Use a public address, list the host in allowedHosts, or set security.allowPrivateOutboundTargets.',
    );
    this.name = 'OutboundUrlBlockedError';
  }
}

export interface IOutboundUrlOptions {
  /**
   * Internal hosts that may be reached anyway, e.g. an ERP in the same network. `'erp.local:8443'`
   * matches that port only, `'erp.local'` and `'10.0.0.5'` any port. Matched against the host as
   * written in the URL — and on every connection, so a redirect does not inherit the exemption.
   */
  allowedHosts?: string[];
}

/** Whether internal targets are allowed at all — explicit config first, then the environment. */
export function privateOutboundTargetsAllowed(): boolean {
  const config = ConfigService.configFastButReadOnly;
  // Read loosely: a value from NSC__* or NEST_SERVER_CONFIG may arrive as a string.
  const flag = config?.security?.allowPrivateOutboundTargets as unknown;
  if (flag === true || flag === 'true') {
    return true;
  }
  if (flag === false || flag === 'false') {
    return false;
  }
  const env = String(config?.env ?? process.env.NODE_ENV ?? '')
    .trim()
    .toLowerCase();
  return LOCAL_ENVIRONMENTS.has(env);
}

/** Whether an IP address is internal. A hostname (not an IP) answers false — resolve it first. */
export function isBlockedOutboundAddress(address: string): boolean {
  const plain = stripBrackets(address);
  const family = isIP(plain);
  if (family === 4) {
    return blocked.check(plain, 'ipv4');
  }
  if (family === 6) {
    const mapped = mappedIpv4(plain);
    return mapped ? blocked.check(mapped, 'ipv4') : blocked.check(plain, 'ipv6');
  }
  return false;
}

/**
 * Refuses a URL whose scheme is not http(s) or whose host is, or resolves to, an internal address.
 * Returns the parsed URL. A redirect is NOT covered here — send the request through
 * {@link outboundFetch} or {@link createOutboundDispatcher}.
 */
export async function assertOutboundUrlAllowed(url: string, options: IOutboundUrlOptions = {}): Promise<URL> {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    throw new Error(`Invalid outbound URL: "${url}"`);
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    throw new Error(`Outbound URL must use http:// or https://: "${url}"`);
  }
  const host = stripBrackets(parsed.hostname);
  if (privateOutboundTargetsAllowed() || isAllowedHost(host, effectivePort(parsed.port, parsed.protocol), options)) {
    return parsed;
  }
  const addresses = isIP(host) ? [host] : await resolveAll(host);
  const internal = addresses.find(isBlockedOutboundAddress);
  if (internal) {
    throw new OutboundUrlBlockedError(host, internal);
  }
  return parsed;
}

const plainConnect = buildConnector({});
const guardedConnect = buildConnector({ lookup: guardedLookup as never });

/**
 * An undici dispatcher that refuses every connection to an internal address — whether the host came
 * as a name or as a literal, and whether it is the first URL or a redirect's next hop. Use it with
 * undici's own `fetch`/`request`; {@link outboundFetch} does that for you.
 */
export function createOutboundDispatcher(options: IOutboundUrlOptions = {}): Agent {
  return new Agent({
    connect: (connectOptions, callback) => {
      const host = stripBrackets(String(connectOptions.hostname ?? ''));
      const port = effectivePort(connectOptions.port, connectOptions.protocol);
      if (privateOutboundTargetsAllowed() || isAllowedHost(host, port, options)) {
        plainConnect(connectOptions, callback);
        return;
      }
      if (isIP(host) && isBlockedOutboundAddress(host)) {
        callback(new OutboundUrlBlockedError(host, host), null);
        return;
      }
      guardedConnect(connectOptions, callback);
    },
  });
}

let defaultDispatcher: Agent | undefined;
const allowListDispatchers = new Map<string, Agent>();
const MAX_ALLOW_LIST_DISPATCHERS = 50;

/**
 * `fetch` for a user-entered URL: the URL check first (a readable {@link OutboundUrlBlockedError}),
 * then the request through a guarded dispatcher. Uses undici's own `fetch`, so the dispatcher always
 * matches the client — Node's built-in `fetch` bundles a different undici major on Node 22.
 *
 * A refusal on a later hop (redirect, rebinding) surfaces as undici's `TypeError: fetch failed` with
 * the {@link OutboundUrlBlockedError} as its `cause`.
 */
export async function outboundFetch(
  url: string,
  init: Parameters<typeof undiciFetch>[1] = {},
  options: IOutboundUrlOptions = {},
): ReturnType<typeof undiciFetch> {
  await assertOutboundUrlAllowed(url, options);
  return undiciFetch(url, { ...init, dispatcher: dispatcherFor(options) });
}

function dispatcherFor(options: IOutboundUrlOptions): Agent {
  const hosts = (options.allowedHosts ?? []).map(normalizeHost).filter(Boolean).sort();
  if (!hosts.length) {
    defaultDispatcher ??= createOutboundDispatcher();
    return defaultDispatcher;
  }
  const key = hosts.join(',');
  let dispatcher = allowListDispatchers.get(key);
  if (!dispatcher) {
    if (allowListDispatchers.size >= MAX_ALLOW_LIST_DISPATCHERS) {
      const [oldestKey, oldest] = allowListDispatchers.entries().next().value as [string, Agent];
      allowListDispatchers.delete(oldestKey);
      void oldest.close().catch(() => undefined);
    }
    dispatcher = createOutboundDispatcher({ allowedHosts: hosts });
    allowListDispatchers.set(key, dispatcher);
  }
  return dispatcher;
}

function guardedLookup(
  hostname: string,
  options: { all?: boolean; family?: number },
  callback: (err: Error | null, address?: LookupAddress[] | string, family?: number) => void,
): void {
  dnsLookup(hostname, { ...options, all: true }, (err, addresses) => {
    if (err) {
      callback(err);
      return;
    }
    const list = addresses as LookupAddress[];
    const internal = list.find((entry) => isBlockedOutboundAddress(entry.address));
    if (internal) {
      callback(new OutboundUrlBlockedError(hostname, internal.address));
      return;
    }
    if (options.all) {
      callback(null, list);
      return;
    }
    callback(null, list[0]?.address, list[0]?.family);
  });
}

function resolveAll(host: string): Promise<string[]> {
  return new Promise((resolve, reject) => {
    dnsLookup(host, { all: true }, (err, addresses) => {
      if (err) {
        reject(new Error(`Outbound target cannot be resolved: "${host}" (${err.message})`));
        return;
      }
      resolve(addresses.map((entry) => entry.address));
    });
  });
}

function isAllowedHost(host: string, port: string, options: IOutboundUrlOptions): boolean {
  const wanted = host.toLowerCase();
  return (options.allowedHosts ?? []).some((entry) => {
    const normalized = normalizeHost(entry);
    if (!normalized) {
      return false;
    }
    const [entryHost, entryPort] = splitHostPort(normalized);
    return entryHost === wanted && (!entryPort || entryPort === port);
  });
}

/** `Host`, `host:port`, `[v6]` and `[v6]:port`, lowercased, IPv6 canonicalised; '' when unusable. */
function normalizeHost(entry: string): string {
  if (typeof entry !== 'string' || !entry.trim()) {
    return '';
  }
  try {
    const url = new URL(`http://${entry.trim()}`);
    const host = stripBrackets(url.hostname).toLowerCase();
    return url.port ? `${host.includes(':') ? `[${host}]` : host}:${url.port}` : host;
  } catch {
    return '';
  }
}

function splitHostPort(normalized: string): [string, string] {
  const v6 = /^\[(.+)\]:(\d+)$/.exec(normalized);
  if (v6) {
    return [v6[1], v6[2]];
  }
  if (isIP(normalized) === 6) {
    return [normalized, ''];
  }
  const index = normalized.lastIndexOf(':');
  return index === -1 ? [normalized, ''] : [normalized.slice(0, index), normalized.slice(index + 1)];
}

function effectivePort(port: number | string | null | undefined, protocol: string | null | undefined): string {
  if (port !== undefined && port !== null && String(port) !== '') {
    return String(port);
  }
  return protocol === 'https:' ? '443' : '80';
}

function stripBrackets(value: string): string {
  return value.replace(/^\[|\]$/g, '');
}

/** The IPv4 address inside an IPv4-mapped IPv6 address, in any notation. */
function mappedIpv4(address: string): string | undefined {
  let canonical: string;
  try {
    canonical = stripBrackets(new URL(`http://[${address}]`).hostname);
  } catch {
    return undefined;
  }
  const match = /^::ffff:([0-9a-f]{1,4}):([0-9a-f]{1,4})$/i.exec(canonical);
  if (!match) {
    return undefined;
  }
  const high = parseInt(match[1], 16);
  const low = parseInt(match[2], 16);
  return `${high >> 8}.${high & 255}.${low >> 8}.${low & 255}`;
}
