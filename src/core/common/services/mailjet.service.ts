import { Injectable } from '@nestjs/common';
import { ConfigService } from './config.service';
import Mailjet from 'node-mailjet';

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
      throw new Error('Cannot connect to mailjet.');
    }

    // Send mail with mailjet
    return connection.post('send', { version: 'v3.1' }).request(body);
  }
}
