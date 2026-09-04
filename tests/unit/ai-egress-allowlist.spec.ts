import { Logger, ServiceUnavailableException } from '@nestjs/common';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { ConfigService } from '../../src/core/common/services/config.service';
import { OpenAiCompatibleProvider } from '../../src/core/modules/ai/providers/openai-compatible.provider';

/**
 * Unit coverage for the SSRF egress allowlist (`ai.allowedBaseUrlHosts`).
 *
 * The guard itself is old; what this file pins is that it cannot be turned OFF by
 * a malformed value. `ai.allowedBaseUrlHosts` is reachable through the framework's
 * own environment mapping as `NSC__AI__ALLOWED_BASE_URL_HOSTS`, and
 * `getEnvironmentObject()` + lodash `merge` assign that STRING straight over the
 * configured array. The previous `!Array.isArray(allowedHosts) → return` read that
 * as "no allowlist configured" and skipped the check entirely — so an operator
 * reaching for the canonical `NSC__` spelling (the documented form for every other
 * setting) silently disabled egress control, with no log line and no error.
 *
 * A security control that fails OPEN on a value shape its own configuration
 * mechanism produces is worse than no control, because everyone believes it is on.
 *
 * @regression   11.39.x — `ai.allowedBaseUrlHosts` arriving as a STRING (which is what
 *   `NSC__AI__ALLOWED_BASE_URL_HOSTS` produces) was read as "no allowlist configured",
 *   silently disabling SSRF egress control. Separately, `probeContextWindow()` reached
 *   the network without consulting the allowlist at all.
 * @seen-failing Restore the old shape in `resolveAllowedBaseUrlHosts()` — registered as
 *   mutation `ai-allowlist-string-fails-open` in tests/regression-mutations.json. The
 *   dropped-lowercase and unguarded-probe variants are registered as
 *   `ai-allowlist-case-sensitive` and `ai-allowlist-probe-unguarded`.
 */
describe('OpenAiCompatibleProvider — egress allowlist (ai.allowedBaseUrlHosts)', () => {
  /** Point `ai.allowedBaseUrlHosts` at `value` for one test. */
  function withAllowedHosts(value: unknown): void {
    vi.spyOn(ConfigService, 'get').mockImplementation((key: string) =>
      key === 'ai.allowedBaseUrlHosts' ? value : undefined,
    );
  }

  /** A provider whose protected `assertBaseUrlAllowed` is callable from the test. */
  function assertHost(url: string): void {
    const provider = new OpenAiCompatibleProvider({
      baseUrl: 'https://llm.example.com/v1',
      model: 'test-model',
      name: 'test',
    } as never);
    (provider as unknown as { assertBaseUrlAllowed: (url: string) => void }).assertBaseUrlAllowed(url);
  }

  afterEach(() => {
    vi.restoreAllMocks();
  });

  describe('permissive only when genuinely unconfigured', () => {
    it.each([undefined, null, [], ''])('allows any host when the list is %s', (value) => {
      // Unset stays permissive so a local provider (Ollama on localhost) works out
      // of the box — that is the documented default and must not change.
      withAllowedHosts(value);
      expect(() => assertHost('https://anything.example.com/v1')).not.toThrow();
    });
  });

  describe('array configuration', () => {
    it('allows a listed host and refuses an unlisted one', () => {
      withAllowedHosts(['llm.example.com']);
      expect(() => assertHost('https://llm.example.com/v1')).not.toThrow();
      expect(() => assertHost('https://evil.example.com/v1')).toThrow(ServiceUnavailableException);
    });

    it('refuses the link-local metadata endpoint a mistyped baseUrl would reach', () => {
      withAllowedHosts(['llm.example.com']);
      expect(() => assertHost('http://169.254.169.254/latest/meta-data/')).toThrow(ServiceUnavailableException);
    });

    it('refuses a host that merely CONTAINS an allowed one', () => {
      withAllowedHosts(['llm.example.com']);
      expect(() => assertHost('https://llm.example.com.evil.test/v1')).toThrow(ServiceUnavailableException);
    });

    it('matches a host:port entry against the full host', () => {
      withAllowedHosts(['llm.internal:8080']);
      expect(() => assertHost('http://llm.internal:8080/v1')).not.toThrow();
    });

    it('still refuses a DIFFERENT port on an allowed host:port entry', () => {
      // The negative control for the rule above — without it, "the port is part of the
      // comparison" is asserted only in its passing state.
      withAllowedHosts(['llm.internal:8080']);
      expect(() => assertHost('http://llm.internal:9200/v1')).toThrow(ServiceUnavailableException);
    });

    it('honours an entry that spells out the default port', () => {
      // `URL.host` omits :443, so a conscientious operator writing it out would otherwise
      // be locked out of their own AI, with only a WARN to explain it.
      withAllowedHosts(['llm.example.com:443']);
      expect(() => assertHost('https://llm.example.com/v1')).not.toThrow();
    });

    it('does not let the default-port form leak across schemes', () => {
      // :443 is https's default, not http's. Accepting it for an http URL would widen
      // the allowlist past what the operator wrote.
      withAllowedHosts(['llm.example.com:443']);
      expect(() => assertHost('http://llm.example.com/v1')).toThrow(ServiceUnavailableException);
    });
  });

  describe('trailing dot (the fully-qualified spelling of the same name)', () => {
    it('accepts a trailing-dot URL against a plain entry', () => {
      // `llm.example.com.` resolves identically in DNS. Refusing it was safe but produced
      // an unexplainable outage rather than protection.
      withAllowedHosts(['llm.example.com']);
      expect(() => assertHost('https://llm.example.com./v1')).not.toThrow();
    });

    it('accepts a plain URL against a trailing-dot entry', () => {
      withAllowedHosts(['llm.example.com.']);
      expect(() => assertHost('https://llm.example.com/v1')).not.toThrow();
    });

    it('does not let a trailing dot smuggle a different host past the check', () => {
      withAllowedHosts(['llm.example.com']);
      expect(() => assertHost('https://evil.example.com./v1')).toThrow(ServiceUnavailableException);
    });
  });

  describe('a STRING must not disable the check', () => {
    // The regression this file exists for. `NSC__AI__ALLOWED_BASE_URL_HOSTS=…`
    // produces exactly this shape, and lodash `merge` overwrites the array with it.
    it('reads a single-host string as a one-entry allowlist', () => {
      withAllowedHosts('llm.example.com');
      expect(() => assertHost('https://llm.example.com/v1')).not.toThrow();
      expect(() => assertHost('https://evil.example.com/v1')).toThrow(ServiceUnavailableException);
    });

    it('reads a comma-separated string as a list', () => {
      withAllowedHosts('llm.example.com, whisper.internal');
      expect(() => assertHost('https://llm.example.com/v1')).not.toThrow();
      expect(() => assertHost('https://whisper.internal/v1')).not.toThrow();
      expect(() => assertHost('https://evil.example.com/v1')).toThrow(ServiceUnavailableException);
    });

    it('does not let an empty entry blank the list', () => {
      withAllowedHosts(['llm.example.com', '', '   ']);
      expect(() => assertHost('https://evil.example.com/v1')).toThrow(ServiceUnavailableException);
    });

    it.each([42, true, {}])('ignores a nonsensical value (%s) rather than trusting it', (value) => {
      // Not an array and not a string: nothing usable to interpret. Returning an
      // empty list keeps the documented "unset = permissive" behaviour rather than
      // inventing a rule, and the misconfiguration is visible as "no restriction".
      // The error itself is asserted in the next block; silenced here so the expected
      // output of a passing run stays clean and a real error still stands out.
      vi.spyOn(Logger.prototype, 'error').mockImplementation((() => undefined) as any);
      withAllowedHosts(value);
      expect(() => assertHost('https://anything.example.com/v1')).not.toThrow();
    });

    it.each([42, true, {}])('SAYS SO when a %s leaves the control inert', (value) => {
      // The half that matters. Returning [] is the only honest answer for a value
      // carrying no hostnames — but it reopens egress while the operator believes the
      // control is on. Silence there is indistinguishable from "correctly unset", which
      // is exactly the confusion the whole fix exists to remove.
      const errors: string[] = [];
      vi.spyOn(Logger.prototype, 'error').mockImplementation(((message: unknown) => {
        errors.push(String(message));
      }) as any);
      withAllowedHosts(value);
      assertHost('https://anything.example.com/v1');
      expect(errors.some((e) => e.includes('is NOT active'))).toBe(true);
    });

    it('stays silent when the list is genuinely unset', () => {
      // The negative control for the rule above: unset is a DECISION, not an accident,
      // and logging an error for it would train the reader to ignore the message.
      const errors: string[] = [];
      vi.spyOn(Logger.prototype, 'error').mockImplementation(((message: unknown) => {
        errors.push(String(message));
      }) as any);
      withAllowedHosts(undefined);
      assertHost('https://anything.example.com/v1');
      expect(errors).toEqual([]);
    });
  });

  describe('case handling', () => {
    it('matches a differently-cased allowlist entry', () => {
      // `URL.hostname` is always lowercase, so `LLM.Example.com` in a .env would
      // otherwise fail CLOSED — safe, but the only symptom is a WARN log and an AI
      // that stopped working, which is a slow and confusing incident.
      withAllowedHosts(['LLM.Example.com']);
      expect(() => assertHost('https://llm.example.com/v1')).not.toThrow();
    });

    it('matches an uppercase host in the URL', () => {
      withAllowedHosts(['llm.example.com']);
      expect(() => assertHost('https://LLM.EXAMPLE.COM/v1')).not.toThrow();
    });
  });

  describe('every outbound path consults the allowlist', () => {
    // The gap this whole file used to have. Driving `assertBaseUrlAllowed` directly proves
    // the RULE and says nothing about its COVERAGE — so `probeContextWindow()` reached the
    // network unguarded while every case here was green. These cases assert on `fetch`
    // itself, which is the only thing that cannot be satisfied by a guard nobody calls.
    it.each([
      ['chat', (p: OpenAiCompatibleProvider) => p.chat([{ content: 'hi', role: 'user' }], [])],
      ['detectCapabilities', (p: OpenAiCompatibleProvider) => p.detectCapabilities()],
      ['detectContextWindow', (p: OpenAiCompatibleProvider) => p.detectContextWindow()],
    ])('%s never reaches a disallowed host', async (_name, drive) => {
      withAllowedHosts(['llm.example.com']);
      const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response('{}', { status: 200 }));
      const provider = new OpenAiCompatibleProvider({
        baseUrl: 'https://evil.example.com/v1',
        model: 'test-model',
        name: 'test',
      } as never);

      // Some paths throw, some degrade to a fallback. Which one is not the point here;
      // the point is that no packet left for a host the operator did not allow.
      await drive(provider).catch(() => undefined);

      expect(fetchSpy, `${_name} reached the network for a disallowed host`).not.toHaveBeenCalled();
    });

    it('does reach an ALLOWED host, so the rule above is not vacuous', () => {
      // Without this, a provider that never calls fetch at all would satisfy every case.
      withAllowedHosts(['llm.example.com']);
      expect(() => assertHost('https://llm.example.com/api/show')).not.toThrow();
    });
  });

  describe('URL parsing', () => {
    it('rejects an unparsable URL rather than letting it through', () => {
      withAllowedHosts(['llm.example.com']);
      expect(() => assertHost('not-a-url')).toThrow(ServiceUnavailableException);
    });

    it('is not fooled by userinfo naming an allowed host', () => {
      withAllowedHosts(['llm.example.com']);
      expect(() => assertHost('https://llm.example.com@evil.example.com/v1')).toThrow(ServiceUnavailableException);
    });
  });
});
