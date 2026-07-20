import { Inject, Injectable, Logger, Optional } from '@nestjs/common';
import { existsSync, readdirSync } from 'fs';
import { join, resolve } from 'path';

import { ConfigService } from '../../../common/services/config.service';
import { TemplateService } from '../../../common/services/template.service';
import { HUB_CONFIG } from '../hub.constants';
import { HubEmailsData, HubUnavailable } from '../interfaces/hub-panels.interface';
import { ResolvedHubConfig } from '../interfaces/hub-config.interface';

/** Sample data used to render an email template preview. Values are illustrative, never real user data. */
const SAMPLE_PAYLOAD: Record<string, unknown> = {
  appName: 'Nest Server',
  email: 'jane.doe@example.com',
  firstName: 'Jane',
  lastName: 'Doe',
  link: 'https://example.com/verify?token=SAMPLE',
  name: 'Jane Doe',
  token: 'SAMPLE-TOKEN',
  url: 'https://example.com/verify?token=SAMPLE',
  username: 'jane.doe',
};

/**
 * Enumerates and previews EJS email templates for the Email Preview panel.
 *
 * Templates come from the project templates dir (`config.templates.path`, what `TemplateService`
 * actually renders) and the framework fallback dir; both are scanned so a project sees the full set.
 * Preview is rendered server-side with illustrative sample data.
 */
@Injectable()
export class CoreHubEmailService {
  protected readonly logger = new Logger(CoreHubEmailService.name);

  constructor(
    @Inject(HUB_CONFIG) protected readonly config: ResolvedHubConfig,
    protected readonly configService: ConfigService,
    @Optional() protected readonly templateService?: TemplateService,
  ) {}

  /** Whether the email preview panel is enabled (`hub.emailPreview`). */
  get previewEnabled(): boolean {
    return this.config.emailPreview !== false;
  }

  /** Inventory of available templates, grouped by base name with detected locale variants. */
  getTemplates(): HubEmailsData {
    const projectDir = this.projectTemplatesDir();
    const frameworkDir = this.frameworkTemplatesDir();

    const grouped = new Map<string, { locales: Set<string>; source: 'framework' | 'project' }>();
    const add = (dir: string, source: 'framework' | 'project'): void => {
      for (const file of this.listEjs(dir)) {
        const { base, locale } = this.parseName(file);
        const entry = grouped.get(base) ?? { locales: new Set<string>(), source };
        if (locale) {
          entry.locales.add(locale);
        }
        // Project templates win the source label (they override framework fallbacks).
        if (source === 'project') {
          entry.source = 'project';
        }
        grouped.set(base, entry);
      }
    };
    add(frameworkDir, 'framework');
    if (projectDir && projectDir !== frameworkDir) {
      add(projectDir, 'project');
    } else if (projectDir === frameworkDir) {
      // Framework acts as its own project (e.g. this repo's e2e run) — label as project.
      for (const [, entry] of grouped) {
        entry.source = 'project';
      }
    }

    return {
      templates: [...grouped.entries()]
        .map(([name, e]) => ({ locales: [...e.locales].sort(), name, source: e.source }))
        .sort((a, b) => a.name.localeCompare(b.name)),
    };
  }

  /** Render a template preview with sample data. The name is validated against the inventory (no traversal). */
  async renderPreview(templateName: string, locale?: string): Promise<HubUnavailable | { html: string }> {
    if (!this.previewEnabled) {
      return { available: false, hint: 'The email preview panel is disabled (hub.emailPreview: false).' };
    }
    if (!this.templateService) {
      return { available: false, hint: 'TemplateService is not available.' };
    }
    const inventory = this.getTemplates().templates;
    const match = inventory.find((t) => t.name === templateName);
    if (!match) {
      return { available: false, hint: `Unknown template "${templateName}".` };
    }
    // Resolve the actual file name: prefer the requested locale variant, then the base file, then
    // fall back to the first available locale variant.
    let fileName = templateName;
    if (locale && match.locales.includes(locale)) {
      fileName = `${templateName}-${locale}`;
    } else if (
      !existsSyncTemplate(this.projectTemplatesDir(), this.frameworkTemplatesDir(), templateName) &&
      match.locales.length
    ) {
      fileName = `${templateName}-${match.locales[0]}`;
    }

    try {
      const html = await this.templateService.renderTemplate(fileName, SAMPLE_PAYLOAD);
      return { html };
    } catch (error) {
      this.logger.warn(
        `Failed to render template "${fileName}": ${error instanceof Error ? error.message : String(error)}`,
      );
      return { available: false, hint: `Failed to render template "${templateName}".` };
    }
  }

  protected frameworkTemplatesDir(): string {
    // From src/core/modules/hub/services → src/templates (same relative offset in dist/).
    return resolve(__dirname, '../../../../templates');
  }

  protected listEjs(dir: string): string[] {
    if (!dir || !existsSync(dir)) {
      return [];
    }
    try {
      return readdirSync(dir)
        .filter((f) => f.endsWith('.ejs'))
        .map((f) => f.slice(0, -4));
    } catch {
      return [];
    }
  }

  /** Split `email-verification-de` → `{ base: 'email-verification', locale: 'de' }`. */
  protected parseName(file: string): { base: string; locale?: string } {
    const match = /^(.*)-([a-z]{2})$/.exec(file);
    if (match) {
      return { base: match[1], locale: match[2] };
    }
    return { base: file };
  }

  protected projectTemplatesDir(): string {
    const path = this.configService.getFastButReadOnly('templates.path');
    return typeof path === 'string' ? path : '';
  }
}

/** Does a non-locale-suffixed template file exist in either dir? */
function existsSyncTemplate(projectDir: string, frameworkDir: string, name: string): boolean {
  return (
    (projectDir && existsSync(join(projectDir, `${name}.ejs`))) ||
    (frameworkDir && existsSync(join(frameworkDir, `${name}.ejs`)))
  );
}
