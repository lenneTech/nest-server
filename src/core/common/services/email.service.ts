import { Injectable } from '@nestjs/common';
import * as nodemailer from 'nodemailer';
import { Attachment } from 'nodemailer/lib/mailer';
import { InputHelper } from '../../common/helpers/input.helper';
import { ConfigService } from './config.service';

/**
 * Email service
 */
@Injectable()
export class EmailService {

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
    config: {
      attachments?: Attachment[],
      html?: string,
      senderEmail?: string,
      senderName?: string,
      text?: string,
    },
  ): Promise<any> {

    // Process config
    const { text, html, attachments, senderName, senderEmail } = {
      senderEmail: this.configService.get('email.defaultSender.email'),
      senderName: this.configService.get('email.defaultSender.name'),
      ...config,
    };

    // Check parameter
    InputHelper.isTrue(recipients);
    InputHelper.isNonEmptyString(subject);
    InputHelper.isNonEmptyString(senderName);
    InputHelper.isNonEmptyString(senderEmail);

    // Check if at lest one of text or html is set
    if (!InputHelper.isNonEmptyString(html, InputHelper.returnFalse)) {
      InputHelper.isNonEmptyString(text);
    }
    if (!InputHelper.isNonEmptyString(text, InputHelper.returnFalse)) {
      InputHelper.isNonEmptyString(html);
    }

    // Init transporter
    const transporter = nodemailer.createTransport(this.configService.get('email.smtp'));

    // Send mail
    return transporter.sendMail({
      from: `"${senderName}" <${senderEmail}>`,
      to: recipients,
      subject,
      text,
      html,
      attachments,
    });
  }
}
