import { Injectable } from '@nestjs/common';
import brevo = require('@getbrevo/brevo');
import { ConfigService } from './config.service';

@Injectable()
export class BrevoService {
  constructor(protected configService: ConfigService) {
    const defaultClient = brevo.ApiClient.instance;
    const apiKey = defaultClient.authentications['api-key'];
    apiKey.apiKey = configService.configFastButReadOnly.brevo?.apiKey;
    if (!apiKey.apiKey) {
      console.warn('Brevo API key not set!');
    }
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
    if (this.configService.configFastButReadOnly.brevo?.exclude?.test?.(to)) {
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
}
