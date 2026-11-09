import { Body, Controller, Get, Headers, Post } from '@nestjs/common';
import { ApiBody, ApiHeader, ApiOperation, ApiProperty, ApiResponse, ApiTags } from '@nestjs/swagger';
import { IsEmail, IsNotEmpty, IsOptional, IsString, MinLength } from 'class-validator';

import { Roles } from '../../common/decorators/roles.decorator';
import { RoleEnum } from '../../common/enums/role.enum';
import {
  CoreSystemSetupService,
  type SystemSetupInitResult,
  type SystemSetupStatus,
} from './core-system-setup.service';
import { SYSTEM_SETUP_TOKEN_HEADER } from './system-setup-http-init.helper';

/**
 * DTO for system setup init request
 */
export class SystemSetupInitDto {
  @ApiProperty({ description: 'Email address for the initial admin user', example: 'admin@example.com' })
  @IsEmail()
  @IsNotEmpty()
  email: string;

  @ApiProperty({ description: 'Name of the initial admin user', example: 'Admin', required: false })
  @IsOptional()
  @IsString()
  name?: string;

  @ApiProperty({ description: 'Password for the initial admin user', minLength: 8 })
  @IsNotEmpty()
  @IsString()
  @MinLength(8)
  password: string;
}

/**
 * CoreSystemSetupController provides REST endpoints for initial system setup.
 *
 * These endpoints are public (S_EVERYONE) to allow first-time admin creation
 * on a fresh system with zero users. The service enforces security: the init is
 * refused where `systemSetup.httpInit` does not open it (by default every
 * environment except `local`, `ci` and `e2e`, 11.46.0+), and once any user exists.
 *
 * A subclass that overrides `createInitialAdmin()` must call
 * `systemSetupService.assertHttpInitAllowed(token)` itself.
 */
@ApiTags('System Setup')
@Controller('system-setup')
@Roles(RoleEnum.ADMIN)
export class CoreSystemSetupController {
  constructor(protected readonly systemSetupService: CoreSystemSetupService) {}

  /**
   * Check if the system needs initial setup
   */
  @ApiOperation({ description: 'Returns whether the system needs initial admin setup', summary: 'Get setup status' })
  @ApiResponse({ description: 'Setup status retrieved', status: 200 })
  @Get('status')
  @Roles(RoleEnum.S_EVERYONE)
  async getSetupStatus(): Promise<SystemSetupStatus> {
    return this.systemSetupService.getSetupStatus();
  }

  /**
   * Create the initial admin user (only works when zero users exist)
   */
  @ApiBody({ type: SystemSetupInitDto })
  @ApiHeader({
    description: 'The setup token, required when systemSetup.httpInit configures one (see GET /system-setup/status)',
    name: SYSTEM_SETUP_TOKEN_HEADER,
    required: false,
  })
  @ApiOperation({
    description:
      'Creates the initial admin user. Only works when zero users exist in the database, and only where ' +
      'systemSetup.httpInit opens it (by default in the local, ci and e2e environments).',
    summary: 'Create initial admin',
  })
  @ApiResponse({ description: 'Initial admin created', status: 201 })
  @ApiResponse({
    description:
      'LTNS_0053: HTTP init not enabled in this environment; LTNS_0054: setup token missing or invalid; ' +
      'LTNS_0050: users already exist, or the initial-admin setup is claimed',
    status: 403,
  })
  @Post('init')
  @Roles(RoleEnum.S_EVERYONE)
  async createInitialAdmin(
    @Body() input: SystemSetupInitDto,
    @Headers(SYSTEM_SETUP_TOKEN_HEADER) token?: string,
  ): Promise<SystemSetupInitResult> {
    this.systemSetupService.assertHttpInitAllowed(token);
    return this.systemSetupService.createInitialAdmin(input);
  }
}
