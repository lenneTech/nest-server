import { describe, expect, it } from 'vitest';

import { isImpossibleSmtpTlsCombination, resolveSmtpSecure } from '../../src/core/common/helpers/config.helper';
import { EmailService } from '../../src/core/common/services/email.service';

/**
 * `secure` does not mean "encrypt". It means "begin the TLS handshake immediately", which only
 * port 465 supports. Port 587 opens in plaintext and upgrades through STARTTLS, which nodemailer
 * performs on its own with `secure: false`.
 *
 * This package's `production` profile shipped port 587 together with `secure` defaulting to true —
 * a pair that cannot connect. Nodemailer sent a TLS ClientHello, the server answered with an SMTP
 * greeting, and OpenSSL reported `wrong version number`.
 *
 * It was invisible for the same reason the reset-link defects were: authentication mail is
 * deliberately not awaited (awaiting it would leak whether an address exists), so the failure never
 * reached a response. The API answered 200 and every password-reset mail died in transport. Found
 * in production, on a real deployment, not by a test.
 *
 * @regression   11.38.0 — the production SMTP profile paired port 587 with `secure: true`, so a
 *   deployment that configured only host and credentials could send no mail at all.
 * @seen-failing Registered mutation `smtp-secure-ignores-port` in tests/regression-mutations.json
 *   — restores the unconditional default, i.e. `secure` true unless explicitly disabled.
 */
describe('SMTP TLS configuration', () => {
  /**
   * The WARNING, not the predicate underneath it. `EmailService` reports an unconnectable pair
   * rather than overruling it — an operator may know something about their server that the
   * framework does not, and silently overriding an explicit setting is the mechanism by which the
   * original defect stayed invisible for months.
   *
   * The latch is the part most likely to rot: a once-per-process flag degrades to "warns never"
   * without anything failing.
   */
  describe('EmailService.warnOnImpossibleSmtpTlsCombination', () => {
    const serviceWith = (warnings: string[]) => {
      const service = Object.create(EmailService.prototype) as Record<string, unknown>;
      service.smtpTlsWarningEmitted = false;
      service.emailServiceLogger = { warn: (m: string) => warnings.push(m) };
      return service as unknown as { warnOnImpossibleSmtpTlsCombination(smtp: unknown): void };
    };

    it('warns on implicit TLS off the one port that speaks it', () => {
      const warnings: string[] = [];
      serviceWith(warnings).warnOnImpossibleSmtpTlsCombination({ port: 587, secure: true });

      expect(warnings).toHaveLength(1);
      expect(warnings[0]).toContain('587');
      // Both remedies named — the reader has to be able to act without looking anything up.
      expect(warnings[0]).toContain('SMTP_SECURE=false');
      expect(warnings[0]).toContain('SMTP_PORT=465');
    });

    it('warns on plaintext on the implicit-TLS port', () => {
      const warnings: string[] = [];
      serviceWith(warnings).warnOnImpossibleSmtpTlsCombination({ port: 465, secure: false });

      expect(warnings).toHaveLength(1);
    });

    it('stays silent on the two pairs that work', () => {
      // The paired permissive case. A warning that fires always is one nobody reads.
      for (const smtp of [
        { port: 587, secure: false },
        { port: 465, secure: true },
      ]) {
        const warnings: string[] = [];
        serviceWith(warnings).warnOnImpossibleSmtpTlsCombination(smtp);
        expect(warnings, JSON.stringify(smtp)).toHaveLength(0);
      }
    });

    it('stays silent on a shape it cannot judge', () => {
      // A non-numeric SMTP_PORT yields NaN, and a JSON-sourced `secure` may be a string. Claiming
      // an impossible pair on a value we did not understand would be a confident wrong answer.
      for (const smtp of [null, undefined, 'nope', { port: '587', secure: true }, { port: 587, secure: 'true' }]) {
        const warnings: string[] = [];
        serviceWith(warnings).warnOnImpossibleSmtpTlsCombination(smtp);
        expect(warnings, JSON.stringify(smtp)).toHaveLength(0);
      }
    });

    it('warns once per process, not once per mail', () => {
      // The latch. Without it every send repeats the same line and the log becomes unreadable
      // precisely on the deployment that has the problem.
      const warnings: string[] = [];
      const service = serviceWith(warnings);
      service.warnOnImpossibleSmtpTlsCombination({ port: 587, secure: true });
      service.warnOnImpossibleSmtpTlsCombination({ port: 587, secure: true });
      service.warnOnImpossibleSmtpTlsCombination({ port: 465, secure: false });

      expect(warnings).toHaveLength(1);
    });
  });

  describe('resolveSmtpSecure', () => {
    it('derives false for the submission port, which is the defect', () => {
      // The exact production default: nothing set, port 587.
      expect(resolveSmtpSecure(undefined, 587)).toBe(false);
    });

    it('derives true for 465, the only port that speaks implicit TLS', () => {
      expect(resolveSmtpSecure(undefined, 465)).toBe(true);
    });

    it('derives false for any other port', () => {
      for (const port of [25, 2525, 1025]) {
        expect(resolveSmtpSecure(undefined, port), `port ${port}`).toBe(false);
      }
    });

    it('honours an explicit "false" whatever the port', () => {
      expect(resolveSmtpSecure('false', 465)).toBe(false);
      expect(resolveSmtpSecure('FALSE', 465)).toBe(false);
      expect(resolveSmtpSecure('  false  ', 465)).toBe(false);
    });

    it('honours an explicit canonical "true" even where it cannot work', () => {
      // Honoured, not overruled: an operator may know something about their server that this
      // function does not. The impossible pair is REPORTED instead — see
      // isImpossibleSmtpTlsCombination below.
      expect(resolveSmtpSecure('true', 587)).toBe(true);
      expect(resolveSmtpSecure('  TRUE  ', 587)).toBe(true);
    });

    it('falls back to the port for a non-canonical value rather than guessing', () => {
      // Both obvious rules have a silent wrong side. `!== 'false'` turns an unknown value into
      // true on 587 (the reported outage); `=== 'true'` turns `1` into false on 465 (the same
      // outage mirrored). Deferring to the port is the only rule under which NO input produces a
      // pair that cannot connect.
      for (const value of ['1', 'yes', 'on', 'anything']) {
        expect(resolveSmtpSecure(value, 465), `${value} on 465`).toBe(true);
        expect(resolveSmtpSecure(value, 587), `${value} on 587`).toBe(false);
      }
    });

    it('never yields a combination that cannot connect, unless asked in so many words', () => {
      // The property that motivates the whole shape. It holds for every input EXCEPT the two
      // canonical values, which are honoured deliberately — an operator may know something about
      // their server that this function does not, and overruling an explicit instruction is how
      // the original defect stayed invisible. Those two are reported by
      // isImpossibleSmtpTlsCombination instead, and asserted below.
      for (const value of [undefined, '', '  ', '1', 'yes', 'on', 'anything']) {
        for (const port of [25, 465, 587, 2525]) {
          const secure = resolveSmtpSecure(value, port);
          expect(isImpossibleSmtpTlsCombination(port, secure), `${String(value)} on ${port}`).toBe(false);
        }
      }
    });

    it('treats an empty or whitespace value as unset', () => {
      expect(resolveSmtpSecure('', 587)).toBe(false);
      expect(resolveSmtpSecure('   ', 465)).toBe(true);
    });
  });

  describe('isImpossibleSmtpTlsCombination', () => {
    it('flags implicit TLS on a STARTTLS port', () => {
      // The pair that shipped, and the one that produces "wrong version number".
      expect(isImpossibleSmtpTlsCombination(587, true)).toBe(true);
    });

    it('flags plaintext on the implicit-TLS port', () => {
      // The mirror case: rarer, equally broken.
      expect(isImpossibleSmtpTlsCombination(465, false)).toBe(true);
    });

    it('accepts the two working pairs', () => {
      expect(isImpossibleSmtpTlsCombination(465, true)).toBe(false);
      expect(isImpossibleSmtpTlsCombination(587, false)).toBe(false);
    });

    it('stays silent on an unparseable port instead of guessing', () => {
      // A NaN port comes from a malformed SMTP_PORT. That deserves its own error, not a confident
      // claim about TLS.
      expect(isImpossibleSmtpTlsCombination(Number.NaN, true)).toBe(false);
    });
  });
});
