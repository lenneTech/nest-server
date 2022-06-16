import { Injectable } from '@nestjs/common';
import { ConfigService } from './config.service';
import mailjet from 'node-mailjet';

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
      attachments?: mailjet.Email.Attachment[];
      templateData?: { [key: string]: any };
      sandbox?: boolean;
    }
  ): Promise<mailjet.Email.PostResponse> {
    // Process config
    const { senderName, senderEmail, templateData, attachments, sandbox } = {
      senderEmail: this.configService.get('email.defaultSender.email'),
      senderName: this.configService.get('email.defaultSender.name'),
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
    const body: mailjet.Email.SendParams = {
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

    let connection: mailjet.Email.Client;
    try {
      // Connect to mailjet
      connection = await mailjet.connect(
        this.configService.get('email.mailjet.api_key_public'),
        this.configService.get('email.mailjet.api_key_private')
      );
    } catch (e) {
      throw new Error('Cannot connect to mailjet.');
    }

    // Send mail with mailjet
    return connection.post('send', { version: 'v3.1' }).request(body);
  }
}
