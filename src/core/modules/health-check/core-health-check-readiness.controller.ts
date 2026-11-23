import { Controller, Get } from '@nestjs/common';

import { Roles } from '../../common/decorators/roles.decorator.js';
import { RoleEnum } from '../../common/enums/role.enum.js';
import { CoreHealthCheckService } from './core-health-check.service.js';

/**
 * `GET /health-check/ready` (12.11.0): the readiness check beside the liveness check `GET /health-check`.
 *
 * Registered by `CoreHealthCheckModule.forRoot()` only with `healthCheck.readiness`, so without it the route does not
 * exist (404). Public like the liveness check: a load balancer or a Kubernetes readiness probe sends no credential.
 * 200 while every check is up, 503 when one is down or the application shuts down. A project replaces it with a
 * subclass through `CoreModule.forRoot(env, { healthCheck: { readinessController } })` — a subclass that re-declares
 * `readinessCheck()` re-declares its `@Get()` and `@Roles()` too.
 */
@Controller()
@Roles(RoleEnum.ADMIN)
export class CoreHealthCheckReadinessController {
  constructor(protected readonly healthCheckService: CoreHealthCheckService) {}

  /** The readiness check: the checks `healthCheck.readiness.checks` lists and the project's readiness indicators */
  @Get('health-check/ready')
  @Roles(RoleEnum.S_EVERYONE)
  async readinessCheck() {
    return this.healthCheckService.readinessCheck();
  }
}
