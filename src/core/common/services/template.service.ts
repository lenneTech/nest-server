import { Injectable } from '@nestjs/common';
import { TemplateFunction } from 'ejs';
import ejs = require('ejs');
import fs = require('fs');
import { join } from 'path';

import { ConfigService } from './config.service';

/**
 * Template service
 */
@Injectable()
export class TemplateService {
  /**
   * Cached templates
   */
  protected templates: { [key: string]: TemplateFunction } = {};

  /**
   * Inject services
   */
  constructor(protected readonly configService: ConfigService) {}

  /**
   * Render a template for a mail with specific data
   * @param filePath Directory names (separated via '/' if template is in subdirectory) + name of the template file without extension
   * @param templateData Data to render into template
   */
  public async renderTemplate(filePath: string, templateData: { [key: string]: any }): Promise<string> {
    const template = await this.getTemplate(filePath);
    return template(templateData);
  }

  /**
   * Compile and cache template
   * @param filePath Directory names (separated via '/' if template is in subdirectory) + name of the template file without extension
   */
  protected async getTemplate(filePath: string): Promise<TemplateFunction> {
    return new Promise<TemplateFunction>((resolve, reject) => {
      // Get template from cache
      if (this.templates[filePath]) {
        resolve(this.templates[filePath]);
        return;
      }

      // Get template file
      fs.readFile(
        `${join(this.configService.getFastButReadOnly('templates.path'), filePath)}.ejs`,
        { encoding: 'utf8' },
        (err, data) => {
          if (err) {
            reject(err);
          } else {
            // Compile and return template
            this.templates[filePath] = ejs.compile(data);
            resolve(this.templates[filePath]);
          }
        },
      );
    });
  }
}
