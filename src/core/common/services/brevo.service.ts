
import { Injectable } from '@nestjs/common';

import { ConfigService } from './config.service';

import brevo = require('@getbrevo/brevo');


@Injectable()
export class BrevoService {
  brevoConfig: ConfigService['configFastButReadOnly']['brevo'];

  constructor(protected configService: ConfigService) {
    const defaultClient = brevo.ApiClient.instance;
    const apiKey = defaultClient.authentications['api-key'];
    this.brevoConfig = configService.configFastButReadOnly.brevo;
    if (!this.brevoConfig) {
      throw new Error('Brevo configuration not set!');
    }
    apiKey.apiKey = this.brevoConfig.apiKey;
  }

  /**
   * Send a transactional email via Brevo
   */
  async sendMail(to: string, templateId: number, params?: object): Promise<unknown> {
    // Check input
    if (!to || !templateId) {
      return false;
    }

    // Exclude (test) users
    if (this.configService.configFastButReadOnly.brevo?.exclude?.test(to)) {
      return 'TEST_USER!';
    }

    // Prepare data
    const apiInstance = new brevo.TransactionalEmailsApi();
    const sendSmtpEmail = new brevo.SendSmtpEmail();
    sendSmtpEmail.templateId = templateId;
    sendSmtpEmail.to = [{ email: to }];
    sendSmtpEmail.params = params;

    // Send email
    try {
      return await apiInstance.sendTransacEmail(sendSmtpEmail);
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
    // Check input
    if (!to || !subject || !html) {
      return false;
    }

    // Exclude (test) users
    if (this.brevoConfig.exclude?.test(to)) {
      return 'TEST_USER!';
    }

    // Prepare data
    const apiInstance = new brevo.TransactionalEmailsApi();
    const sendSmtpEmail = new brevo.SendSmtpEmail();
    sendSmtpEmail.htmlContent = html;
    sendSmtpEmail.params = options?.params;
    sendSmtpEmail.sender = this.brevoConfig.sender;
    sendSmtpEmail.subject = subject;
    sendSmtpEmail.to = [{ email: to }];

    // Send email
    try {
      return await apiInstance.sendTransacEmail(sendSmtpEmail);
    } catch (error) {
      console.error(error);
    }

    // Return null if error
    return null;
  }
}
