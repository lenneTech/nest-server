import { Body, Controller, Get, Post } from '@nestjs/common';
import { ApiBody, ApiOperation, ApiProperty, ApiResponse, ApiTags } from '@nestjs/swagger';
import { IsEmail, IsNotEmpty, IsOptional, IsString, MinLength } from 'class-validator';

import { Roles } from '../../common/decorators/roles.decorator';
import { RoleEnum } from '../../common/enums/role.enum';
import { CoreSystemSetupService, SystemSetupInitResult, SystemSetupStatus } from './core-system-setup.service';

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
 * on a fresh system with zero users. The service enforces security by checking
 * that no users exist before allowing creation.
 */
@ApiTags('System Setup')
@Controller('api/system-setup')
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
  @ApiOperation({
    description: 'Creates the initial admin user. Only works when zero users exist in the database.',
    summary: 'Create initial admin',
  })
  @ApiResponse({ description: 'Initial admin created', status: 201 })
  @ApiResponse({ description: 'System setup not available - users already exist', status: 403 })
  @Post('init')
  @Roles(RoleEnum.S_EVERYONE)
  async createInitialAdmin(@Body() input: SystemSetupInitDto): Promise<SystemSetupInitResult> {
    return this.systemSetupService.createInitialAdmin(input);
  }
}
