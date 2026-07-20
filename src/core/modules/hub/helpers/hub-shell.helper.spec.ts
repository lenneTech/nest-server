import { describe, expect, it } from 'vitest';

import {
  buildHubCsp,
  buildHubSecurityHeaders,
  escapeHtml,
  escapeJsString,
  generateNonce,
  injectNonce,
} from './hub-shell.helper';

describe('hub-shell.helper', () => {
  describe('escapeHtml', () => {
    it('escapes all five HTML-significant characters', () => {
      expect(escapeHtml(`<img src="x" onerror='y'>&`)).toBe('&lt;img src=&quot;x&quot; onerror=&#39;y&#39;&gt;&amp;');
    });

    it('neutralizes a script-tag XSS payload', () => {
      const out = escapeHtml('<script>alert(1)</script>');
      expect(out).not.toContain('<script>');
      expect(out).toContain('&lt;script&gt;');
    });

    it('handles empty / non-string-ish input', () => {
      expect(escapeHtml('')).toBe('');
    });
  });

  describe('escapeJsString', () => {
    it('escapes characters that would break out of a JS string / script context', () => {
      const out = escapeJsString(`a'b\\c</script>`);
      expect(out).not.toContain('</script>');
      expect(out).toContain("\\'");
      expect(out).toContain('\\\\');
      // The closing angle bracket must be escaped so `</script>` cannot terminate the tag.
      expect(out).toContain('\\u003c');
    });

    it('escapes CR / LF into their JS escapes', () => {
      const out = escapeJsString('line1\r\nline2');
      expect(out).toBe('line1\\r\\nline2');
    });

    it('escapes U+2028 / U+2029, which are line terminators inside a JS string literal', () => {
      // Built via fromCharCode so this test file stays pure ASCII (a literal separator would itself
      // terminate the source line). A raw U+2028 in a `'...'` literal is a syntax error at runtime.
      const lineSep = String.fromCharCode(0x2028);
      const paraSep = String.fromCharCode(0x2029);
      const out = escapeJsString(`before${lineSep}mid${paraSep}after`);
      expect(out).toContain('\\u2028');
      expect(out).toContain('\\u2029');
      expect(out).not.toContain(lineSep);
      expect(out).not.toContain(paraSep);
      // The escaped result must be a valid single-line JS string literal.
      expect(() => new Function(`return '${out}';`)()).not.toThrow();
      expect(new Function(`return '${out}';`)()).toBe(`before${lineSep}mid${paraSep}after`);
    });
  });

  describe('generateNonce', () => {
    it('produces a non-empty base64 nonce that differs each call', () => {
      const a = generateNonce();
      const b = generateNonce();
      expect(a.length).toBeGreaterThan(10);
      expect(a).not.toBe(b);
    });
  });

  describe('injectNonce', () => {
    it('replaces every __CSP_NONCE__ placeholder', () => {
      const html = `<style nonce="__CSP_NONCE__"></style><script nonce="__CSP_NONCE__"></script>`;
      const out = injectNonce(html, 'abc123');
      expect(out).not.toContain('__CSP_NONCE__');
      expect(out).toContain('nonce="abc123"');
      expect((out.match(/abc123/g) ?? []).length).toBe(2);
    });
  });

  describe('buildHubCsp', () => {
    it('is a strict, self-contained policy pinned to the nonce', () => {
      const csp = buildHubCsp('nonce123');
      expect(csp).toContain("default-src 'none'");
      expect(csp).toContain("script-src 'nonce-nonce123'");
      expect(csp).toContain("frame-ancestors 'none'");
      expect(csp).not.toContain('unsafe-inline');
    });
  });

  describe('buildHubSecurityHeaders', () => {
    it('returns the strict header set with no-store for HTML by default', () => {
      const headers = buildHubSecurityHeaders('n1');
      expect(headers['Content-Security-Policy']).toContain('nonce-n1');
      expect(headers['X-Frame-Options']).toBe('DENY');
      expect(headers['X-Content-Type-Options']).toBe('nosniff');
      expect(headers['Referrer-Policy']).toBe('no-referrer');
      expect(headers['Cache-Control']).toContain('no-store');
    });

    it('uses a long-lived immutable cache for the cacheable script bundle', () => {
      const headers = buildHubSecurityHeaders('n1', { cacheable: true });
      expect(headers['Cache-Control']).toContain('max-age');
      expect(headers['Cache-Control']).toContain('immutable');
      expect(headers['Cache-Control']).not.toContain('no-store');
    });
  });
});
