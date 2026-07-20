import { createHash } from 'crypto';
import { Inject, Injectable, OnModuleDestroy, Optional } from '@nestjs/common';
import nodemailer = require('nodemailer');
import { Attachment } from 'nodemailer/lib/mailer';

import { isNonEmptyString, isTrue, returnFalse } from '../helpers/input.helper';
import { MailTransportOptions } from '../interfaces/server-options.interface';
import { HUB_EMAIL_CAPTURE } from '../../modules/hub/hub.constants';
import { ConfigService } from './config.service';
import { TemplateService } from './template.service';
import type { IHubEmailCapture } from '../../modules/hub/interfaces/hub-config.interface';

/**
 * Email service
 */
@Injectable()
export class EmailService implements OnModuleDestroy {
  /**
   * Cached transporter to avoid creating new SMTP connections per email.
   * Reused as long as the SMTP config hasn't changed.
   */
  private cachedTransporter: nodemailer.Transporter | null = null;
  private cachedSmtpConfig: string | null = null;

  /**
   * Inject services
   */
  constructor(
    protected configService: ConfigService,
    protected templateService: TemplateService,
    // Optional Hub mailbox hook. When the Hub mailbox is enabled it captures outgoing mail (and, in
    // capture mode, suppresses the actual send). Undefined otherwise — zero cost.
    @Optional() @Inject(HUB_EMAIL_CAPTURE) protected readonly emailCapture?: IHubEmailCapture,
  ) {}

  onModuleDestroy(): void {
    if (this.cachedTransporter) {
      this.cachedTransporter.close();
      this.cachedTransporter = null;
      this.cachedSmtpConfig = null;
    }
  }

  /**
   * Send a mail
   */
  public async sendMail(
    recipients: string | string[],
    subject: string,
    config: {
      attachments?: Attachment[];
      html?: string;
      htmlTemplate?: string;
      senderEmail?: string;
      senderName?: string;
      smtp?: MailTransportOptions;
      templateData?: { [key: string]: any };
      text?: string;
      textTemplate?: string;
    },
  ): Promise<any> {
    // Process config
    const { attachments, htmlTemplate, senderEmail, senderName, smtp, templateData, textTemplate } = {
      senderEmail: this.configService.getFastButReadOnly('email.defaultSender.email'),
      senderName: this.configService.getFastButReadOnly('email.defaultSender.name'),
      smtp: config.smtp || this.configService.get('email.smtp'),
      ...config,
    };

    let html = config.html;
    let text = config.text;

    // Check parameter
    isTrue(recipients);
    isNonEmptyString(subject);
    isNonEmptyString(senderName);
    isNonEmptyString(senderEmail);

    // Process text template
    if (htmlTemplate) {
      html = await this.templateService.renderTemplate(htmlTemplate, templateData);
    }

    // Process text template
    if (textTemplate) {
      text = await this.templateService.renderTemplate(textTemplate, templateData);
    }

    // Check if at lest one of text or html is set
    if (!isNonEmptyString(html, returnFalse)) {
      isNonEmptyString(text);
    }
    if (!isNonEmptyString(text, returnFalse)) {
      isNonEmptyString(html);
    }

    // Guard: JSONTransport silently discards all mail — block in production / staging
    // to prevent accidental misconfiguration that causes password-reset, 2FA, and
    // verification emails to vanish without error.
    // Uses truthy check (not strict === true) because nodemailer activates
    // JSONTransport for any truthy value of options.jsonTransport.
    const env = this.configService.getFastButReadOnly<string>('env');
    if (env === 'production' || env === 'staging') {
      if (typeof smtp === 'object' && smtp !== null && !!(smtp as Record<string, unknown>).jsonTransport) {
        throw new Error(
          'JSONTransport (jsonTransport: true) is not permitted in production/staging environments. ' +
            'It silently discards all outgoing email. Check email.smtp in your config.',
        );
      }
    }

    // Hub mailbox capture (Mailpit-style). Runs after templates are rendered, before the transport.
    // In capture mode it records the mail and suppresses the send (returns a jsonTransport-like ack).
    // Fully guarded: a broken mailbox hook must never break (or crash) the mail path.
    if (this.emailCapture) {
      let skipTransport = false;
      try {
        skipTransport = this.emailCapture.capture({
          from: `"${senderName}" <${senderEmail}>`,
          html,
          subject,
          templateName: htmlTemplate ?? textTemplate,
          text,
          to: Array.isArray(recipients) ? recipients.join(', ') : recipients,
        });
      } catch {
        /* mailbox capture must never break mail sending */
      }
      if (skipTransport) {
        return {
          accepted: Array.isArray(recipients) ? recipients : [recipients],
          captured: true,
          messageId: 'hub-mailbox',
          rejected: [],
        };
      }
    }

    // Reuse transporter if SMTP config hasn't changed (avoids creating new connections per email)
    // Use hash instead of raw JSON to avoid keeping credentials as a string in memory
    const smtpKey = createHash('sha256').update(JSON.stringify(smtp)).digest('hex');
    if (!this.cachedTransporter || this.cachedSmtpConfig !== smtpKey) {
      this.cachedTransporter = nodemailer.createTransport(smtp);
      this.cachedSmtpConfig = smtpKey;
    }

    // Send mail
    return this.cachedTransporter.sendMail({
      attachments,
      from: `"${senderName}" <${senderEmail}>`,
      html,
      subject,
      text,
      to: recipients,
    });
  }
}
