/**
 * `CoreBetterAuthEmailVerificationService.sendPasswordResetEmail()` — the delivery half of the
 * native password-reset flow, and the documented override point for projects.
 *
 * The flow it belongs to is credential recovery on an UNAUTHENTICATED route, so the branches that
 * matter here are the ones where a mail silently does not arrive (Brevo reporting failure as
 * `null`, no EmailService) and the one where a token would be handed to somebody reading logs.
 *
 * Constructed directly with stubs rather than through Nest — same approach as the send-slot cases
 * in `redis-rate-limiters.spec.ts`.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { CoreBetterAuthEmailVerificationService } from '../../src/core/modules/better-auth/core-better-auth-email-verification.service';

const USER = { email: 'reset.user@test.com', id: 'u1', name: 'Reset User' };
const RESET_URL = 'https://api.test.local/iam/reset-password/JnQ2K8xL5pR7wT1vB4hZ9mCd';

/**
 * What the mail actually carries for this fixture since 11.39.0.
 *
 * The stub configures `env: 'local'` and nothing else. Before 11.39.0 the twin read `appUrl`
 * straight off the configuration, found nothing, and fell back to Better-Auth's own API-hosted
 * link — so `RESET_URL` appeared in the mail. It now resolves through `resolveAppUrlFromConfig`,
 * the same function the legacy twin uses, and `local` is one of the three environments whose
 * localhost default lives inside that resolver.
 *
 * The change is the point of the refactor: in local, ci and e2e the IAM mail now links at the APP
 * rather than the API, which is what the legacy half had done all along. A deployed environment
 * sets `appUrl` or `baseUrl`, so nothing changes there.
 */
const EXPECTED_LINK = 'http://localhost:3001/auth/reset-password?token=t';

function createService(opts: {
  brevoResult?: null | unknown;
  brevoTemplateId?: number;
  env?: string;
  locale?: string;
  withEmailService?: boolean;
} = {}) {
  // Parameters are declared so `mock.calls[0]` keeps its tuple type — a zero-arg mock infers `[]`.
  const sendMailBrevo = vi.fn(
    async (_to: string, _templateId: number, _data: Record<string, unknown>) =>
      opts.brevoResult === undefined ? { messageId: 'ok' } : opts.brevoResult,
  );
  const sendMailSmtp = vi.fn(async (_to: string, _subject: string, _payload: Record<string, any>) => ({
    messageId: 'smtp',
  }));

  const configService = {
    getFastButReadOnly: (key: string) => {
      if (key === 'betterAuth.emailVerification') {
        return {
          locale: opts.locale ?? 'en',
          passwordResetBrevoTemplateId: opts.brevoTemplateId,
          resendCooldownSeconds: 60,
        };
      }
      if (key === 'env') return opts.env ?? 'local';
      // No project template dir → the nest-server template wins, exercising the absolute branch.
      if (key === 'templates.path') return undefined;
      return undefined;
    },
  } as any;

  const emailService = opts.withEmailService === false ? undefined : ({ sendMail: sendMailSmtp } as any);
  const brevoService = opts.brevoTemplateId ? ({ sendMail: sendMailBrevo } as any) : undefined;

  const service = new CoreBetterAuthEmailVerificationService(
    configService,
    emailService,
    undefined,
    brevoService,
    undefined,
  ) as any;

  return { sendMailBrevo, sendMailSmtp, service };
}

describe('sendPasswordResetEmail', () => {
  let logSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    logSpy = vi.spyOn(console, 'log').mockImplementation(() => undefined);
  });

  afterEach(() => {
    vi.restoreAllMocks();
    delete process.env.LT_LOG_AUTH_URLS;
  });

  describe('SMTP path', () => {
    it('renders the nest-server template and sends it', async () => {
      const { sendMailSmtp, service } = createService();

      await service.sendPasswordResetEmail({ token: 't', url: RESET_URL, user: USER });

      expect(sendMailSmtp).toHaveBeenCalledTimes(1);
      const [to, subject, payload] = sendMailSmtp.mock.calls[0];
      expect(to).toBe(USER.email);
      expect(subject).toContain('Reset your password');
      // The absolute (nest-server) branch renders to HTML rather than passing a template name.
      expect(payload.html).toContain(EXPECTED_LINK);
    });

    it('uses the German subject when the configured locale is de', async () => {
      const { sendMailSmtp, service } = createService({ locale: 'de' });

      await service.sendPasswordResetEmail({ token: 't', url: RESET_URL, user: USER });

      expect(sendMailSmtp.mock.calls[0][1]).toContain('Passwort zurücksetzen');
    });

    it('falls back to the English subject for an unknown locale', async () => {
      const { sendMailSmtp, service } = createService({ locale: 'fr' });

      await service.sendPasswordResetEmail({ token: 't', url: RESET_URL, user: USER });

      expect(sendMailSmtp.mock.calls[0][1]).toContain('Reset your password');
    });

    it('warns and sends nothing when no EmailService is available', async () => {
      const { sendMailSmtp, service } = createService({ withEmailService: false });

      await expect(service.sendPasswordResetEmail({ token: 't', url: RESET_URL, user: USER })).resolves.toBeUndefined();
      expect(sendMailSmtp).not.toHaveBeenCalled();
    });

    it('re-throws a send failure after logging it', async () => {
      const { service } = createService();
      service.emailService.sendMail = vi.fn(async () => {
        throw new Error('smtp down');
      });

      await expect(service.sendPasswordResetEmail({ token: 't', url: RESET_URL, user: USER })).rejects.toThrow(
        'smtp down',
      );
    });
  });

  describe('Brevo path', () => {
    it('uses the reset-specific template id and does not touch SMTP on success', async () => {
      const { sendMailBrevo, sendMailSmtp, service } = createService({ brevoTemplateId: 42 });

      await service.sendPasswordResetEmail({ token: 't', url: RESET_URL, user: USER });

      expect(sendMailBrevo).toHaveBeenCalledWith(USER.email, 42, expect.objectContaining({ link: EXPECTED_LINK }));
      expect(sendMailSmtp).not.toHaveBeenCalled();
    });

    it('falls through to SMTP when Brevo reports failure as null', async () => {
      // `BrevoService.sendMail()` swallows SDK errors and resolves to `null` unless
      // `brevo.throwOnError` is set, so "did not throw" is NOT "was delivered". Returning here
      // would leave a locked-out user with no mail at all.
      const { sendMailBrevo, sendMailSmtp, service } = createService({ brevoResult: null, brevoTemplateId: 42 });

      await service.sendPasswordResetEmail({ token: 't', url: RESET_URL, user: USER });

      expect(sendMailBrevo).toHaveBeenCalledTimes(1);
      expect(sendMailSmtp).toHaveBeenCalledTimes(1);
    });

    it('does NOT fall back to the verification template id', async () => {
      // Reusing `brevoTemplateId` here would mail "confirm your address" to somebody who asked to
      // reset their password.
      const { sendMailBrevo, sendMailSmtp, service } = createService();
      service.config.brevoTemplateId = 7;

      await service.sendPasswordResetEmail({ token: 't', url: RESET_URL, user: USER });

      expect(sendMailBrevo).not.toHaveBeenCalled();
      expect(sendMailSmtp).toHaveBeenCalledTimes(1);
    });
  });

  describe('per-address cooldown', () => {
    it('skips a second send inside the window', async () => {
      const { sendMailSmtp, service } = createService();

      await service.sendPasswordResetEmail({ token: 't', url: RESET_URL, user: USER });
      await service.sendPasswordResetEmail({ token: 't', url: RESET_URL, user: USER });

      expect(sendMailSmtp).toHaveBeenCalledTimes(1);
    });

    it('does not burn the cooldown when the send failed', async () => {
      const { service } = createService();
      const failing = vi.fn(async () => {
        throw new Error('smtp down');
      });
      service.emailService.sendMail = failing;

      await expect(service.sendPasswordResetEmail({ token: 't', url: RESET_URL, user: USER })).rejects.toThrow();
      // The slot was released, so the locked-out user may retry immediately.
      service.emailService.sendMail = vi.fn(async () => ({ messageId: 'ok' }));
      await service.sendPasswordResetEmail({ token: 't', url: RESET_URL, user: USER });

      expect(service.emailService.sendMail).toHaveBeenCalledTimes(1);
    });

    it('uses a namespace of its own so a pending verification mail does not block a reset', async () => {
      const { sendMailSmtp, service } = createService();

      // Burn the VERIFICATION slot for this address...
      expect(await service.acquireSendSlot(USER.email)).toBeTruthy();
      // ...the reset must still go out.
      await service.sendPasswordResetEmail({ token: 't', url: RESET_URL, user: USER });

      expect(sendMailSmtp).toHaveBeenCalledTimes(1);
    });
  });

  describe('reset-URL logging', () => {
    it('masks the address and prints the URL outside production', async () => {
      const { service } = createService({ env: 'local' });

      await service.sendPasswordResetEmail({ token: 't', url: RESET_URL, user: USER });

      const line = logSpy.mock.calls.map(c => String(c[0])).find(l => l.includes('[PASSWORD RESET]'));
      expect(line).toBeDefined();
      expect(line).not.toContain(USER.email);
      expect(line).toContain(EXPECTED_LINK);
    });

    it('prints nothing in a staging deployment', async () => {
      // `NODE_ENV !== 'production'` is NOT enough: staging sets NODE_ENV=staging so
      // getEnvironmentConfig() loads its block, which passes that test while holding real users.
      const { service } = createService({ env: 'staging' });

      await service.sendPasswordResetEmail({ token: 't', url: RESET_URL, user: USER });

      expect(logSpy.mock.calls.map(c => String(c[0])).find(l => l.includes('[PASSWORD RESET]'))).toBeUndefined();
    });

    it('prints nothing when LT_LOG_AUTH_URLS=0', async () => {
      process.env.LT_LOG_AUTH_URLS = '0';
      const { service } = createService({ env: 'local' });

      await service.sendPasswordResetEmail({ token: 't', url: RESET_URL, user: USER });

      expect(logSpy.mock.calls.map(c => String(c[0])).find(l => l.includes('[PASSWORD RESET]'))).toBeUndefined();
    });
  });
});
