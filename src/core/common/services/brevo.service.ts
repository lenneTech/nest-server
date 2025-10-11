import { SendSmtpEmail, TransactionalEmailsApi, TransactionalEmailsApiApiKeys } from '@getbrevo/brevo';
import { Injectable } from '@nestjs/common';

import { ConfigService } from './config.service';

/**
 * Brevo service to send transactional emails
 */
@Injectable()
export class BrevoService {
  brevoConfig: ConfigService['configFastButReadOnly']['brevo'];
  private apiInstance: TransactionalEmailsApi;

  constructor(protected configService: ConfigService) {
    this.brevoConfig = configService.configFastButReadOnly.brevo;
    if (!this.brevoConfig) {
      throw new Error('Brevo configuration not set!');
    }
    this.apiInstance = new TransactionalEmailsApi();
    this.apiInstance.setApiKey(TransactionalEmailsApiApiKeys.apiKey, this.brevoConfig.apiKey);
  }

  /**
   * Send a transactional email via Brevo
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
      const sendSmtpEmail: SendSmtpEmail = {
        params,
        templateId,
        to: [{ email: to }],
      };

      // Send email
      const result = await this.apiInstance.sendTransacEmail(sendSmtpEmail);
      return result.body;
    } catch (error) {
      console.error(error);
    }

    // Return null if error
    return null;
  }

  /**
   * Send HTML mail
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
      const sendSmtpEmail: SendSmtpEmail = {
        htmlContent: html,
        params: options?.params,
        sender: this.brevoConfig.sender,
        subject,
        to: [{ email: to }],
      };

      // Send email
      const result = await this.apiInstance.sendTransacEmail(sendSmtpEmail);
      return result.body;
    } catch (error) {
      console.error(error);
    }

    // Return null if error
    return null;
  }
}
