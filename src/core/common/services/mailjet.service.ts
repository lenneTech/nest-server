import { HttpException, Injectable } from '@nestjs/common';
import type { Client } from 'node-mailjet';
import MailjetDefault from 'node-mailjet';

import { ConfigService } from './config.service.js';

/**
 * node-mailjet's declarations say `export default Mailjet`, while its CommonJS build exports the class itself (no
 * `.default`). At runtime both module systems hand the class to a default import; only TypeScript's ESM view types it
 * as the module object. `Mailjet` extends `Client` without changing the constructor, so this is the honest type.
 */
const Mailjet = MailjetDefault as unknown as typeof Client;

/**
 * Mailjet service
 */
@Injectable()
export class MailjetService {
  /**
   * Inject services
   */
  constructor(protected configService: ConfigService) {}

  /**
   * Send a mail
   */
  public async sendMail(
    recipients: string | string[],
    subject: string,
    templateId: number,
    config: {
      attachments?: {
        Base64Content: string;
        ContentID?: string;
        ContentType: string;
        Filename: string;
      }[];
      sandbox?: boolean;
      senderEmail?: string;
      senderName?: string;
      templateData?: { [key: string]: any };
    },
  ) {
    // Process config
    const { attachments, sandbox, senderEmail, senderName, templateData } = {
      attachments: null,
      sandbox: false,
      senderEmail: this.configService.getFastButReadOnly('email.defaultSender.email'),
      senderName: this.configService.getFastButReadOnly('email.defaultSender.name'),
      templateData: null,
      ...config,
    };

    // Parse recipients
    let to;
    if (Array.isArray(recipients)) {
      to = [];
      for (const recipient of recipients) {
        to.push({ Email: recipient });
      }
    } else {
      to = [{ Email: recipients }];
    }

    // Parse body for mailjet request
    const body = {
      Messages: [
        {
          Attachments: attachments,
          From: {
            Email: senderEmail,
            Name: senderName,
          },
          Subject: subject,
          TemplateID: templateId,
          TemplateLanguage: true,
          To: to,
          Variables: templateData,
        },
      ],
      SandboxMode: sandbox,
    };

    let connection;
    try {
      // Connect to mailjet
      connection = new Mailjet({
        apiKey: this.configService.getFastButReadOnly('email.mailjet.api_key_public'),
        apiSecret: this.configService.getFastButReadOnly('email.mailjet.api_key_private'),
      });
    } catch (e) {
      if (
        this.configService.getFastButReadOnly('email.mailjet.api_key_public') &&
        this.configService.getFastButReadOnly('email.mailjet.api_key_private')
      ) {
        throw new HttpException('Cannot connect to mailjet.', 502);
      }
      console.debug(
        JSON.stringify(
          {
            'email.mailjet.api_key_private':
              this.configService.getFastButReadOnly('email.mailjet.api_key_private') || 'missing',
            'email.mailjet.api_key_public':
              this.configService.getFastButReadOnly('email.mailjet.api_key_public') || 'missing',
            info: 'Mailjet credentials are missing',
            templateData: templateData,
          },
          null,
          2,
        ),
      );
      return;
    }

    // Send mail with mailjet
    return connection.post('send', { version: 'v3.1' }).request(body);
  }
}
