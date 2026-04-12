/**
 * EmailService — JSONTransport production guard tests
 *
 * Verifies that the production/staging guard correctly blocks JSONTransport
 * (which silently discards all mail) in production and staging environments,
 * while allowing it in non-production environments (local, e2e, ci).
 */
import { describe, expect, it, vi } from 'vitest';

import { EmailService } from '../src/core/common/services/email.service';
import { ConfigService } from '../src/core/common/services/config.service';
import { TemplateService } from '../src/core/common/services/template.service';

// Minimal config for sendMail — JSONTransport never actually sends, so these
// are just enough to pass the input validation checks.
const baseMailConfig = {
  html: '<p>Test</p>',
  senderEmail: 'test@example.com',
  senderName: 'Test Sender',
};

/**
 * Create an EmailService with a mocked ConfigService that returns
 * the given env and smtp values.
 */
function createEmailService(env: string, smtpFromConfig?: any): EmailService {
  const configService = {
    getFastButReadOnly: vi.fn((key: string) => {
      if (key === 'env') return env;
      if (key === 'email.defaultSender.email') return 'default@example.com';
      if (key === 'email.defaultSender.name') return 'Default Sender';
      return undefined;
    }),
    get: vi.fn((key: string) => {
      if (key === 'email.smtp') return smtpFromConfig;
      return undefined;
    }),
  } as unknown as ConfigService;

  const templateService = {
    renderTemplate: vi.fn(),
  } as unknown as TemplateService;

  return new EmailService(configService, templateService);
}

describe('EmailService JSONTransport production guard', () => {
  // ---------------------------------------------------------------------------
  // Production environment — guard must block
  // ---------------------------------------------------------------------------
  describe('production environment', () => {
    it('should throw when smtp has jsonTransport: true', async () => {
      const service = createEmailService('production');
      await expect(
        service.sendMail('recipient@example.com', 'Test Subject', {
          ...baseMailConfig,
          smtp: { jsonTransport: true } as any,
        }),
      ).rejects.toThrow('JSONTransport (jsonTransport: true) is not permitted in production/staging');
    });

    it('should throw when smtp has jsonTransport: 1 (truthy)', async () => {
      const service = createEmailService('production');
      await expect(
        service.sendMail('recipient@example.com', 'Test Subject', {
          ...baseMailConfig,
          smtp: { jsonTransport: 1 } as any,
        }),
      ).rejects.toThrow('JSONTransport');
    });

    it('should throw when smtp has jsonTransport: "true" (truthy string)', async () => {
      const service = createEmailService('production');
      await expect(
        service.sendMail('recipient@example.com', 'Test Subject', {
          ...baseMailConfig,
          smtp: { jsonTransport: 'true' } as any,
        }),
      ).rejects.toThrow('JSONTransport');
    });

    it('should NOT throw for legitimate SMTP config', async () => {
      const service = createEmailService('production');
      // This will fail at the nodemailer level (no real SMTP server), but
      // it must NOT throw the JSONTransport guard error.
      await expect(
        service.sendMail('recipient@example.com', 'Test Subject', {
          ...baseMailConfig,
          smtp: { host: 'smtp.example.com', port: 587, auth: { user: 'u', pass: 'p' } },
        }),
      ).rejects.not.toThrow('JSONTransport');
    });

    it('should NOT throw when smtp has jsonTransport: false', async () => {
      const service = createEmailService('production');
      await expect(
        service.sendMail('recipient@example.com', 'Test Subject', {
          ...baseMailConfig,
          smtp: { jsonTransport: false } as any,
        }),
      ).rejects.not.toThrow('JSONTransport');
    });
  });

  // ---------------------------------------------------------------------------
  // Staging environment — guard must block
  // ---------------------------------------------------------------------------
  describe('staging environment', () => {
    it('should throw when smtp has jsonTransport: true', async () => {
      const service = createEmailService('staging');
      await expect(
        service.sendMail('recipient@example.com', 'Test Subject', {
          ...baseMailConfig,
          smtp: { jsonTransport: true } as any,
        }),
      ).rejects.toThrow('JSONTransport (jsonTransport: true) is not permitted in production/staging');
    });
  });

  // ---------------------------------------------------------------------------
  // Non-production environments — guard must NOT block
  // ---------------------------------------------------------------------------
  describe('local environment', () => {
    it('should NOT throw for jsonTransport: true', async () => {
      const service = createEmailService('local');
      const result = await service.sendMail('recipient@example.com', 'Test Subject', {
        ...baseMailConfig,
        smtp: { jsonTransport: true } as any,
      });
      // JSONTransport returns a JSON-serialized envelope — verify it worked
      expect(result).toBeDefined();
      expect(result.envelope).toBeDefined();
    });
  });

  describe('e2e environment', () => {
    it('should NOT throw for jsonTransport: true', async () => {
      const service = createEmailService('e2e');
      const result = await service.sendMail('recipient@example.com', 'Test Subject', {
        ...baseMailConfig,
        smtp: { jsonTransport: true } as any,
      });
      expect(result).toBeDefined();
    });
  });

  describe('ci environment', () => {
    it('should NOT throw for jsonTransport: true', async () => {
      const service = createEmailService('ci');
      const result = await service.sendMail('recipient@example.com', 'Test Subject', {
        ...baseMailConfig,
        smtp: { jsonTransport: true } as any,
      });
      expect(result).toBeDefined();
    });
  });

  // ---------------------------------------------------------------------------
  // Guard reads from config via sendMail's smtp parameter (not only from config)
  // ---------------------------------------------------------------------------
  describe('smtp from config fallback', () => {
    it('should throw in production when smtp from config has jsonTransport: true', async () => {
      const service = createEmailService('production', { jsonTransport: true });
      await expect(
        service.sendMail('recipient@example.com', 'Test Subject', {
          ...baseMailConfig,
          // No explicit smtp — falls back to config
        }),
      ).rejects.toThrow('JSONTransport');
    });

    it('should NOT throw in local when smtp from config has jsonTransport: true', async () => {
      const service = createEmailService('local', { jsonTransport: true });
      const result = await service.sendMail('recipient@example.com', 'Test Subject', {
        ...baseMailConfig,
      });
      expect(result).toBeDefined();
    });
  });
});
