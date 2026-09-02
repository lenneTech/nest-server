import { readFileSync } from 'fs';
import { join } from 'path';
import { describe, expect, it } from 'vitest';

/**
 * The PRODUCTION PROFILE's SMTP wiring, not the helper underneath it.
 *
 * The outage was the pairing in `config.env.ts` — port 587 with `secure` defaulting to true, which
 * cannot connect — and the helper that fixes it is covered separately in `smtp-tls-config.spec.ts`.
 * That split is the gap this file closes: reverting `config.env.ts` to
 * `process.env.SMTP_SECURE !== 'false'` restores the production outage verbatim and, before this
 * spec existed, left the entire suite green, because the registered mutation targets the helper.
 *
 * This repository's whole incident history is "block-level tests green, mail broken". A helper with
 * excellent coverage that nothing calls correctly is that same failure in miniature.
 *
 * ── Why this is a STRUCTURAL test ──────────────────────────────────────────────
 * `config.env.ts` keeps its `config` map module-private and default-exports only the profile
 * resolved for the current `NODE_ENV`, so the production block cannot be read at runtime without
 * booting as production. This repo already answers that with structural invariants over `src/`
 * (`import-cycle-invariants`, `pnpm-pin-contract`, `test-file-placement`), and the property here is
 * the same shape: a claim about the SOURCE that no runtime path in this suite can observe.
 *
 * @regression   11.38.0 — the production SMTP profile paired port 587 with `secure: true` and could
 *   send no mail at all; the repaired channel then had no TLS floor, so a stripped STARTTLS
 *   capability line downgraded it to plaintext carrying SMTP credentials and a live reset link.
 * @seen-failing Two registered mutations in tests/regression-mutations.json:
 *     production-smtp-secure-unwired   reverts the wiring to the unconditional default
 *     production-smtp-no-require-tls   drops the requireTLS floor
 */
describe('production SMTP wiring', () => {
  const source = readFileSync(join(__dirname, '..', '..', 'src', 'config.env.ts'), 'utf-8');

  /** The `production:` profile only — the local profiles legitimately hard-code `secure: false`. */
  const productionBlock = (() => {
    const start = source.indexOf('  production: {');
    expect(start, 'the production profile must exist').toBeGreaterThan(-1);
    return source.slice(start);
  })();

  it('derives `secure` from the port instead of defaulting it unconditionally', () => {
    // The exact line that caused the outage, and the one a well-meaning revert would restore.
    expect(productionBlock).toContain('secure: resolveSmtpSecure(process.env.SMTP_SECURE,');
    expect(productionBlock).not.toContain("secure: process.env.SMTP_SECURE !== 'false'");
  });

  it('resolves the port ONCE and feeds that same value to the TLS decision', () => {
    // Two independent `parseInt` calls would let the port and the TLS mode drift apart — which is
    // the class of defect this whole area exists to remove, not just the one instance of it.
    expect(source).toContain('const productionSmtpPort = parseInt(');
    expect(productionBlock).toContain('port: productionSmtpPort,');
    expect(productionBlock).toContain('resolveSmtpSecure(process.env.SMTP_SECURE, productionSmtpPort)');
  });

  it('sets a TLS floor so the repaired channel cannot be silently downgraded', () => {
    // `secure: false` alone means OPPORTUNISTIC STARTTLS: nodemailer upgrades only when the server
    // advertises it, so an on-path attacker who strips that line gets a plaintext session carrying
    // the SMTP credentials and a working password-reset link.
    expect(productionBlock).toContain('requireTLS:');
  });

  it('lets a deployment opt out of the TLS floor, but only by saying so', () => {
    // The paired permissive case: an internal relay without STARTTLS is a real deployment. What
    // must not happen is losing the floor by accident.
    expect(productionBlock).toContain("process.env.SMTP_REQUIRE_TLS !== 'false'");
  });

  it('keeps the local profiles on plaintext, which is what a local mail catcher speaks', () => {
    // Guards against a copy-paste of the production block into the local ones, which would break
    // Mailpit/MailHog on port 1025 for every developer. The derivation belongs to exactly one
    // profile; counted rather than searched, because the import at the top of the file names it too.
    const localBlocks = source.slice(0, source.indexOf('  production: {'));
    expect(localBlocks).toContain('secure: false');

    const derivationCallSites = source.split('secure: resolveSmtpSecure(').length - 1;
    expect(derivationCallSites, 'only the production profile derives its TLS mode').toBe(1);
  });
});
