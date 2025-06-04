import type SMTPPool = require('nodemailer/lib/smtp-pool');

import { Injectable } from '@nestjs/common';
import nodemailer = require('nodemailer');
import { Attachment } from 'nodemailer/lib/mailer';

import { isNonEmptyString, isTrue, returnFalse } from '../helpers/input.helper';
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
  constructor(
    protected configService: ConfigService,
    protected templateService: TemplateService,
  ) {}

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
      smtp?: SMTPPool | SMTPPool.Options;
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

    // Init transporter
    const transporter = nodemailer.createTransport(smtp);

    // Send mail
    return transporter.sendMail({
      attachments,
      from: `"${senderName}" <${senderEmail}>`,
      html,
      subject,
      text,
      to: recipients,
    });
  }
}
