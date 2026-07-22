/**
 * Manual smoke test for BrevoService against the REAL Brevo API.
 *
 * Deliberately NOT part of any automated suite: it costs a real send and needs real credentials.
 * The unit spec (src/core/common/services/brevo.service.spec.ts) covers the logic with a mocked
 * SDK; this script exists to prove the wire format against the live endpoint once after an SDK
 * upgrade.
 *
 * Usage:
 *   BREVO_API_KEY=xkeysib-... BREVO_SMOKE_TO=you@example.com pnpm exec tsx scripts/brevo-smoke.ts
 *
 * See docs/brevo-manual-test.md for the full walkthrough.
 */
import * as dotenv from 'dotenv';

import { BrevoService } from '../src/core/common/services/brevo.service';
import { ConfigService } from '../src/core/common/services/config.service';

dotenv.config({ quiet: true });

const apiKey = process.env.BREVO_API_KEY;
const nodeEnv = process.env.NODE_ENV ?? 'local';
const to = process.env.BREVO_SMOKE_TO;
const senderEmail = process.env.EMAIL_DEFAULT_SENDER;
const senderName = process.env.EMAIL_DEFAULT_SENDER_NAME || 'Nest Server Brevo Smoke Test';
const templateId = process.env.BREVO_SMOKE_TEMPLATE_ID ? Number(process.env.BREVO_SMOKE_TEMPLATE_ID) : undefined;

function fail(message: string): never {
  console.error(`[brevo-smoke] ${message}`);
  process.exit(1);
}

// This script sends REAL mail on REAL quota from the verified production sender. A `.env` copied
// from a deployment is the realistic way that happens by accident, so refuse a production-shaped
// environment unless it is overridden on purpose.
if (['production', 'staging'].includes(nodeEnv) && process.env.BREVO_SMOKE_ALLOW_PROD !== 'true') {
  fail(`Refusing to run with NODE_ENV=${nodeEnv}. Set BREVO_SMOKE_ALLOW_PROD=true to override.`);
}
if (!apiKey) {
  fail('BREVO_API_KEY is not set. Put it in .env or pass it inline. See docs/brevo-manual-test.md.');
}
if (!to) {
  fail('BREVO_SMOKE_TO is not set. Use a mailbox you can actually read.');
}
if (!senderEmail) {
  fail('EMAIL_DEFAULT_SENDER is not set. Brevo rejects sends from unverified senders.');
}
if (process.env.BREVO_SMOKE_TEMPLATE_ID && Number.isNaN(templateId)) {
  fail(`BREVO_SMOKE_TEMPLATE_ID is not a number: ${process.env.BREVO_SMOKE_TEMPLATE_ID}`);
}

async function main() {
  // No `exclude` pattern here on purpose - the point of this script is that mail leaves the house.
  const configService = new ConfigService(
    { brevo: { apiKey, sender: { email: senderEmail, name: senderName } } },
    { warn: false },
  );
  const brevoService = new BrevoService(configService);

  console.info(`[brevo-smoke] sender:    ${senderName} <${senderEmail}>`);
  console.info(`[brevo-smoke] recipient: ${to}`);

  const stamp = new Date().toISOString();
  console.info('[brevo-smoke] sending HTML mail via sendHtmlMail() ...');
  const htmlResult = await brevoService.sendHtmlMail(
    to,
    `nest-server Brevo smoke test (${stamp})`,
    `<html><body><h1>Brevo smoke test</h1><p>Sent by scripts/brevo-smoke.ts at ${stamp}.</p></body></html>`,
  );
  console.info('[brevo-smoke] sendHtmlMail result:', htmlResult);

  let templateResult: unknown;
  if (templateId) {
    console.info(`[brevo-smoke] sending template mail via sendMail() with templateId ${templateId} ...`);
    templateResult = await brevoService.sendMail(to, templateId, { smokeTestStamp: stamp });
    console.info('[brevo-smoke] sendMail result:', templateResult);
  } else {
    console.info('[brevo-smoke] BREVO_SMOKE_TEMPLATE_ID not set - skipping the template send.');
  }

  // Evaluate EVERY send that ran, not just the first: a script that reports OK while the template
  // send failed is worse than no script at all. See the return contract on BrevoService.
  //   null          -> the SDK threw and BrevoService swallowed it
  //   false         -> rejected before sending, a required argument was missing
  //   'TEST_USER!'  -> the recipient matched brevo.exclude, so nothing left the house
  const results = templateId ? [htmlResult, templateResult] : [htmlResult];
  const failed = results.some((result) => result === null || result === false);
  const excluded = results.some((result) => result === 'TEST_USER!');

  if (excluded) {
    console.warn(
      `[brevo-smoke] WARNING - a send returned 'TEST_USER!': ${to} matched the brevo.exclude pattern, so NO mail was sent.`,
    );
  }
  console.info(
    failed
      ? '[brevo-smoke] FAILED - at least one send did not go out, check the error logged above.'
      : '[brevo-smoke] OK - check the recipient mailbox and https://app.brevo.com/transactional/email/logs.',
  );
  process.exit(failed ? 1 : 0);
}

void main();
