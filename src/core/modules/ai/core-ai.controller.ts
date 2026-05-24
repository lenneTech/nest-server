import { Body, Controller, Delete, Get, Param, Post, Put } from '@nestjs/common';

import { RESTServiceOptions } from '../../common/decorators/rest-service-options.decorator';
import { Roles } from '../../common/decorators/roles.decorator';
import { RoleEnum } from '../../common/enums/role.enum';
import { ServiceOptions } from '../../common/interfaces/service-options.interface';
import { CoreAiConnectionCreateInput } from './inputs/core-ai-connection-create.input';
import { CoreAiConnectionInput } from './inputs/core-ai-connection.input';
import { CoreAiPromptInput } from './inputs/core-ai-prompt.input';
import { CoreAiConnection } from './models/core-ai-connection.model';
import { CoreAiResponse } from './models/core-ai-response.model';
import { CoreAiConnectionService } from './services/core-ai-connection.service';
import { CoreAiService } from './services/core-ai.service';

/**
 * REST controller for AI prompts and connection management.
 *
 * - `POST /ai/prompt`: any authenticated user.
 * - `/ai/connections*`: admin only.
 *
 * Extend this controller in a project and pass it via `CoreAiModule.forRoot({ controller })`.
 */
@Controller('ai')
@Roles(RoleEnum.ADMIN)
export class CoreAiController {
  constructor(
    protected readonly aiService: CoreAiService,
    protected readonly connectionService: CoreAiConnectionService,
  ) {}

  /**
   * Send a prompt to the AI assistant.
   */
  @Post('prompt')
  @Roles(RoleEnum.S_USER)
  async prompt(
    @RESTServiceOptions() serviceOptions: ServiceOptions,
    @Body() input: CoreAiPromptInput,
  ): Promise<CoreAiResponse> {
    return this.aiService.prompt(input, serviceOptions);
  }

  /**
   * Find all AI connections.
   */
  @Get('connections')
  @Roles(RoleEnum.ADMIN)
  async findConnections(@RESTServiceOptions() serviceOptions: ServiceOptions): Promise<CoreAiConnection[]> {
    return this.connectionService.find({}, serviceOptions);
  }

  /**
   * Get an AI connection by id.
   */
  @Get('connections/:id')
  @Roles(RoleEnum.ADMIN)
  async getConnection(
    @RESTServiceOptions() serviceOptions: ServiceOptions,
    @Param('id') id: string,
  ): Promise<CoreAiConnection> {
    return this.connectionService.get(id, serviceOptions);
  }

  /**
   * Create a new AI connection.
   */
  @Post('connections')
  @Roles(RoleEnum.ADMIN)
  async createConnection(
    @RESTServiceOptions() serviceOptions: ServiceOptions,
    @Body() input: CoreAiConnectionCreateInput,
  ): Promise<CoreAiConnection> {
    return this.connectionService.create(input, { ...serviceOptions, inputType: CoreAiConnectionCreateInput });
  }

  /**
   * Update an AI connection.
   */
  @Put('connections/:id')
  @Roles(RoleEnum.ADMIN)
  async updateConnection(
    @RESTServiceOptions() serviceOptions: ServiceOptions,
    @Param('id') id: string,
    @Body() input: CoreAiConnectionInput,
  ): Promise<CoreAiConnection> {
    return this.connectionService.update(id, input, { ...serviceOptions, inputType: CoreAiConnectionInput });
  }

  /**
   * Delete an AI connection.
   */
  @Delete('connections/:id')
  @Roles(RoleEnum.ADMIN)
  async deleteConnection(
    @RESTServiceOptions() serviceOptions: ServiceOptions,
    @Param('id') id: string,
  ): Promise<CoreAiConnection> {
    return this.connectionService.delete(id, serviceOptions);
  }
}
