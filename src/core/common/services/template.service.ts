import { Injectable } from '@nestjs/common';
import { TemplateFunction } from 'ejs';
import ejs = require('ejs');
import fs = require('fs');
import { resolve, sep } from 'path';

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
    // Resolve the template file to an absolute path and enforce that it stays within the configured
    // templates directory. Legitimate template names never contain '..'; this guard is a defense in
    // depth against path traversal for any caller that forwards user-influenced template names.
    const baseDir = resolve(this.configService.getFastButReadOnly('templates.path'));
    const fullPath = resolve(baseDir, `${filePath}.ejs`);
    if (fullPath !== baseDir && !fullPath.startsWith(baseDir + sep)) {
      throw new Error(`Invalid template path "${filePath}".`);
    }

    return new Promise<TemplateFunction>((res, reject) => {
      // Get template from cache
      if (this.templates[filePath]) {
        res(this.templates[filePath]);
        return;
      }

      // Get template file
      fs.readFile(fullPath, { encoding: 'utf8' }, (err, data) => {
        if (err) {
          reject(err);
        } else {
          // Compile and return template
          this.templates[filePath] = ejs.compile(data);
          res(this.templates[filePath]);
        }
      });
    });
  }
}
