import { Controller, Get } from '@nestjs/common';

import { Roles } from '../../common/decorators/roles.decorator';
import { RoleEnum } from '../../common/enums/role.enum';
import { CoreHealthCheckService } from './core-health-check.service';

/**
 * The HealthController class checks the health of various components including the database, memory, and disk.
 * Inspired by https://mobileappcircular.com/marketplace-backend-creating-a-health-check-endpoint-in-nestjs-app-using-terminus-25727e96c7d2
 */
@Roles(RoleEnum.ADMIN)
@Controller()
export class CoreHealthCheckController {
  constructor(protected readonly healthCheckService: CoreHealthCheckService) {}

  /**
   * The function checks the health of various components including the database, memory, and storage.
   * @returns The function is returning the result of calling the `healthCheck()` method
   * with an array of functions as arguments. Each function in the array is a check for a different
   * aspect of the system's health, including the status of the database, memory usage, and disk
   * storage. The `healthCheck()` method will return a Promise that resolves with an array of objects
   * representing the results of each check
   */
  @Roles(RoleEnum.S_EVERYONE)
  @Get('health-check')
  async healthCheck() {
    return this.healthCheckService.healthCheck();
  }
}
