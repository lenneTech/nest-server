import { Controller, Get, Header, Headers, Post } from '@nestjs/common';

import { CorePermissionsService } from './core-permissions.service';
import type { PermissionsReport } from './interfaces/permissions.interface';

@Controller()
export class CorePermissionsController {
  constructor(private readonly permissionsService: CorePermissionsService) {}

  @Get()
  @Header('Content-Type', 'text/html')
  async getPermissionsHtml(@Headers('authorization') authHeader?: string): Promise<string> {
    await this.permissionsService.getOrScan();
    return this.permissionsService.generateHtml(authHeader);
  }

  @Get('json')
  async getPermissionsJson(): Promise<PermissionsReport> {
    return this.permissionsService.getOrScan();
  }

  @Get('markdown')
  @Header('Content-Type', 'text/plain; charset=utf-8')
  async getPermissionsMarkdown(): Promise<string> {
    await this.permissionsService.getOrScan();
    return this.permissionsService.generateMarkdown();
  }

  @Post('rescan')
  async rescan() {
    await this.permissionsService.scan();
    return { message: 'Rescan completed', timestamp: new Date().toISOString() };
  }
}
