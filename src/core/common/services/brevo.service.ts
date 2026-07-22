import { Injectable, Logger } from '@nestjs/common';
import { randomUUID } from 'node:crypto';

import type { Brevo, BrevoClient } from '@getbrevo/brevo';

import { ConfigService } from './config.service';

/**
 * Brevo service to send transactional emails
 *
 * ## Return contract
 *
 * Both send methods resolve to one of four things, and callers on security-critical paths
 * (verification, password reset, magic link) MUST distinguish them:
 *
 * | Value | Meaning |
 * |-------|---------|
 * | `false` | Rejected before sending — a required argument was missing |
 * | `'TEST_USER!'` | Recipient matched `brevo.exclude`, nothing was sent (by design) |
 * | `null` | The send FAILED. The error was logged, not thrown |
 * | otherwise | The Brevo `SendTransacEmailResponse` (`{ messageId?, messageIds? }`) |
 *
 * A `null` is the one that bites: treating "did not throw" as "was delivered" silently drops mail.
 * Set `brevo.throwOnError: true` if you would rather have the exception propagate.
 */
@Injectable()
export class BrevoService {
  brevoConfig: ConfigService['configFastButReadOnly']['brevo'];
  protected readonly logger = new Logger(BrevoService.name);
  private client: BrevoClient | undefined;

  constructor(protected configService: ConfigService) {
    this.brevoConfig = configService.configFastButReadOnly.brevo;
    if (!this.brevoConfig) {
      throw new Error('Brevo configuration not set!');
    }
  }

  /**
   * Send a transactional email via Brevo
   *
   * @param to - Recipient email address
   * @param templateId - Brevo template id
   * @param params - Template parameters. These are rendered SERVER-SIDE by the Brevo template
   *   engine, so any user-controlled value placed here is content-injection surface owned by
   *   whoever wrote the template — escape it there, or do not pass it.
   * @returns The Brevo response, `false` on missing input, `'TEST_USER!'` when excluded, `null` on failure
   */
  async sendMail(to: string, templateId: number, params?: object): Promise<unknown> {
    try {
      // Check input
      if (!to || !templateId) {
        return false;
      }

      // Exclude (test) users, must be done via config and not via configFastButReadOnly,
      // otherwise the error TypeError: Cannot assign to read only property 'lastIndex' of object '[object RegExp]' occurs
      if (this.configService.config?.brevo?.exclude?.test?.(to)) {
        return 'TEST_USER!';
      }

      // Prepare data
      const request: Brevo.SendTransacEmailRequest = {
        headers: this.buildIdempotencyHeaders(),
        // The public signature keeps the wider `object` so existing callers stay source-compatible;
        // the SDK narrowed its own field to an index-signature type in v6.
        params: params as Record<string, unknown>,
        templateId,
        to: [{ email: to }],
      };

      // Send email
      const client = await this.getClient();
      return await client.transactionalEmails.sendTransacEmail(request);
    } catch (error) {
      return this.handleSendError(error, to);
    }
  }

  /**
   * Send HTML mail
   *
   * @param to - Recipient email address
   * @param subject - Email subject
   * @param html - HTML body
   * @param options - Optional template parameters
   * @returns The Brevo response, `false` on missing input, `'TEST_USER!'` when excluded, `null` on failure
   */
  async sendHtmlMail(
    to: string,
    subject: string,
    html: string,
    options?: { params?: Record<string, string> },
  ): Promise<unknown> {
    try {
      // Check input
      if (!to || !subject || !html) {
        return false;
      }

      // Exclude (test) users, must be done via config and not via configFastButReadOnly,
      // otherwise the error TypeError: Cannot assign to read only property 'lastIndex' of object '[object RegExp]' occurs
      if (this.configService.config?.brevo?.exclude?.test?.(to)) {
        return 'TEST_USER!';
      }

      // Prepare data
      const request: Brevo.SendTransacEmailRequest = {
        headers: this.buildIdempotencyHeaders(),
        htmlContent: html,
        params: options?.params,
        sender: this.brevoConfig.sender,
        subject,
        to: [{ email: to }],
      };

      // Send email
      const client = await this.getClient();
      return await client.transactionalEmails.sendTransacEmail(request);
    } catch (error) {
      return this.handleSendError(error, to);
    }
  }

  /**
   * Builds the per-send idempotency header.
   *
   * The SDK retries POSTs on 408/429/5xx. Without a key, a retry issued after a response that was
   * actually delivered (but whose reply was lost) sends the mail twice. Brevo deduplicates on
   * `Idempotency-Key`.
   *
   * @returns Custom headers for the send request
   */
  protected buildIdempotencyHeaders(): Record<string, unknown> {
    return { 'Idempotency-Key': randomUUID() };
  }

  /**
   * Lazily constructs (and memoises) the Brevo SDK client.
   *
   * The import is dynamic on purpose: `@getbrevo/brevo` pulls in ~580 CommonJS modules, and
   * `BrevoService` is re-exported from the package barrel. A static import would put that cost on
   * every consumer's cold start, including the majority that never configure Brevo at all.
   *
   * @returns The memoised SDK client
   */
  protected async getClient(): Promise<BrevoClient> {
    if (!this.client) {
      const { BrevoClient: BrevoClientCtor } = await import('@getbrevo/brevo');
      this.client = new BrevoClientCtor({
        apiKey: this.brevoConfig.apiKey,
        // The SDK defaults to 2 retries honouring `Retry-After` with a 60 s cap PER attempt, and to
        // no timeout at all. Both send methods are awaited inside request handlers, so those
        // defaults let a rate-limited Brevo park a user-facing request for roughly two minutes.
        maxRetries: this.brevoConfig.maxRetries ?? 0,
        timeoutInSeconds: this.brevoConfig.timeoutInSeconds ?? 10,
      });
    }
    return this.client;
  }

  /**
   * Logs a failed send through the Nest logger and applies the configured failure policy.
   *
   * @param error - The thrown SDK error
   * @param to - Recipient, for correlation
   * @returns `null` (the historical contract) unless `brevo.throwOnError` is set
   * @throws The original error when `brevo.throwOnError` is `true`
   */
  protected handleSendError(error: unknown, to: string): null {
    this.logger.error(
      `Brevo sendTransacEmail failed for ${to}: ${error instanceof Error ? error.message : String(error)}`,
    );
    if (this.brevoConfig.throwOnError) {
      throw error;
    }
    // Return null if error
    return null;
  }
}
