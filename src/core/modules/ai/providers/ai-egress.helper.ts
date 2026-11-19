import { Logger, ServiceUnavailableException } from '@nestjs/common';

import { ConfigService } from '../../../common/services/config.service.js';
import { ErrorCode } from '../../error-code/error-codes.js';

/**
 * The AI egress allowlist (`ai.allowedBaseUrlHosts`) as functions, for every outbound path the AI module constructs —
 * the OpenAI-compatible provider and the AI SDK transport alike (nestjs-ai plan §2). One implementation, so a model
 * provider a project builds with the AI SDK (`createAnthropic({ fetch })`) is held to exactly the rule the built-in
 * provider is.
 */

const logger = new Logger('AiEgress');

/**
 * Lowercase, trim, and drop a fully-qualifying trailing dot — applied to BOTH the allowlist entry and the URL, so
 * neither side wins by spelling one DNS name differently (`llm.example.com.` vs `llm.example.com`).
 */
export function normaliseAiEgressHost(value: string): string {
  return value
    .trim()
    .toLowerCase()
    .replace(/\.(?=$|:)/, '');
}

/**
 * The configured allowlist as normalised entries; `[]` when unset (permissive — a local Ollama works out of the box).
 *
 * A comma-separated STRING is split rather than rejected: `NSC__AI__ALLOWED_BASE_URL_HOSTS` arrives as one, and reading
 * it as "not configured" silently switched the control off until 11.39.x. A value that is neither array nor string
 * carries no hostnames: the list is empty and that is LOGGED, because from the outside it looks exactly like "unset".
 */
export function resolveAiEgressAllowlist(log: Pick<Logger, 'error'> = logger): string[] {
  const configured = ConfigService.get<unknown>('ai.allowedBaseUrlHosts');
  if (configured === undefined || configured === null) {
    return [];
  }
  const entries = typeof configured === 'string' ? configured.split(',') : configured;
  if (!Array.isArray(entries)) {
    log.error(
      `ai.allowedBaseUrlHosts is a ${typeof configured} and carries no hostnames — the SSRF egress ` +
        'allowlist is NOT active. Use an array or a comma-separated string.',
    );
    return [];
  }
  return entries.map((host) => normaliseAiEgressHost(String(host))).filter(Boolean);
}

/**
 * The spellings of a URL's host an allowlist entry may name: `host` (with a non-default port), `hostname` (any port),
 * and `hostname:<default port>` for an operator who wrote the port out. Nothing here widens the set of reachable hosts.
 */
export function aiEgressHostCandidates(url: URL): string[] {
  const defaultPort = url.protocol === 'https:' ? '443' : url.protocol === 'http:' ? '80' : '';
  const candidates = [url.host, url.hostname];
  if (defaultPort && url.host === url.hostname) {
    candidates.push(`${url.hostname}:${defaultPort}`);
  }
  return candidates;
}

/**
 * Throws `ServiceUnavailableException` (`AI_CONNECTION_NOT_AVAILABLE`) when an allowlist is configured and the URL's
 * host is not on it, `AI_CONNECTION_INVALID_URL` when the URL does not parse. No allowlist → every URL passes.
 */
export function assertAiEgressAllowed(url: string | URL, connectionName = 'AI connection'): void {
  const allowedHosts = resolveAiEgressAllowlist();
  if (!allowedHosts.length) {
    return;
  }
  let parsed: URL;
  try {
    parsed = url instanceof URL ? url : new URL(url);
  } catch {
    throw new ServiceUnavailableException(ErrorCode.AI_CONNECTION_INVALID_URL);
  }
  const candidates = aiEgressHostCandidates(parsed).map(normaliseAiEgressHost);
  if (!candidates.some((candidate) => allowedHosts.includes(candidate))) {
    logger.warn(`AI connection "${connectionName}" host "${parsed.host}" is not in ai.allowedBaseUrlHosts`);
    throw new ServiceUnavailableException(ErrorCode.AI_CONNECTION_NOT_AVAILABLE);
  }
}

/**
 * A `fetch` that refuses every URL outside `ai.allowedBaseUrlHosts` before sending — for a model provider a project
 * builds itself (`createAnthropic({ apiKey, fetch })`). Hand it to the provider; the AI SDK provider packages send every
 * request through the `fetch` they were given. The allowlist is read on every call, so a configuration change applies
 * without a restart.
 */
export function createAiEgressFetch(connectionName = 'AI connection', base: typeof fetch = fetch): typeof fetch {
  // async: a refusal is a rejected promise, as every fetch failure is — never a synchronous throw
  const guarded = async (input: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]) => {
    const url = typeof input === 'string' || input instanceof URL ? input : input.url;
    assertAiEgressAllowed(url, connectionName);
    return base(input, init);
  };
  return guarded as typeof fetch;
}
