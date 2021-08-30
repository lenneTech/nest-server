import { Injectable } from '@nestjs/common';
import * as nodemailer from 'nodemailer';
import { Attachment } from 'nodemailer/lib/mailer';
import { InputHelper } from '../helpers/input.helper';
import { ConfigService } from './config.service';
import { TemplateService } from './template.service';

/**
 * Email service
 */
@Injectable()
export class EmailService {
  /**
   * Inject services
   */
  constructor(protected configService: ConfigService, protected templateService: TemplateService) {}

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
      templateData?: { [key: string]: any };
      text?: string;
      textTemplate?: string;
    }
  ): Promise<any> {
    // Process config
    const { attachments, htmlTemplate, senderName, senderEmail, templateData, textTemplate } = {
      senderEmail: this.configService.get('email.defaultSender.email'),
      senderName: this.configService.get('email.defaultSender.name'),
      ...config,
    };

    let html = config.html;
    let text = config.text;

    // Check parameter
    InputHelper.isTrue(recipients);
    InputHelper.isNonEmptyString(subject);
    InputHelper.isNonEmptyString(senderName);
    InputHelper.isNonEmptyString(senderEmail);

    // Process text template
    if (htmlTemplate) {
      html = await this.templateService.renderTemplate(htmlTemplate, templateData);
    }

    // Process text template
    if (textTemplate) {
      text = await this.templateService.renderTemplate(textTemplate, templateData);
    }

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
