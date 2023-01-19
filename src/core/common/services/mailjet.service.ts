import { Injectable } from '@nestjs/common';
import { template } from 'lodash';
import { ConfigService } from './config.service';
// eslint-disable-next-line
const Mailjet = require('node-mailjet');

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
      senderEmail?: string;
      senderName?: string;
      attachments?: {
        ContentID?: string;
        ContentType: string;
        Filename: string;
        Base64Content: string;
      }[];
      templateData?: { [key: string]: any };
      sandbox?: boolean;
    }
  ) {
    // Process config
    const { senderName, senderEmail, templateData, attachments, sandbox } = {
      senderEmail: this.configService.getFastButReadOnly('email.defaultSender.email'),
      senderName: this.configService.getFastButReadOnly('email.defaultSender.name'),
      sandbox: false,
      attachments: null,
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
          From: {
            Email: senderEmail,
            Name: senderName,
          },
          To: to,
          TemplateID: templateId,
          TemplateLanguage: true,
          Variables: templateData,
          Subject: subject,
          Attachments: attachments,
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
        throw new Error('Cannot connect to mailjet.');
      }
      console.debug(
        JSON.stringify(
          {
            info: 'Mailjet credentials are missing',
            'email.mailjet.api_key_public':
              this.configService.getFastButReadOnly('email.mailjet.api_key_public') || 'missing',
            'email.mailjet.api_key_private':
              this.configService.getFastButReadOnly('email.mailjet.api_key_private') || 'missing',
            templateData: templateData,
          },
          null,
          2
        )
      );
      return;
    }

    // Send mail with mailjet
    return connection.post('send', { version: 'v3.1' }).request(body);
  }
}
