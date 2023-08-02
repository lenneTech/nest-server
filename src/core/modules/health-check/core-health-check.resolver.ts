import { Query, Resolver } from '@nestjs/graphql';
import { RoleEnum } from '../../common/enums/role.enum';
import { Roles } from '../../common/decorators/roles.decorator';
import { CoreHealthCheckResult } from './core-health-check-result.model';
import { CoreHealthCheckService } from './core-health-check.service';


/**
 * Resolver to process with user data
 */
@Resolver(() => CoreHealthCheckResult)
@Roles(RoleEnum.ADMIN)
export class CoreHealthCheckResolver {
  /**
   * Import services
   */
  constructor(protected readonly healthCheckService: CoreHealthCheckService) {
  }

  // ===========================================================================
  // Queries
  // ===========================================================================

  /**
   * Get heath check result
   */
  @Roles(RoleEnum.S_EVERYONE)
  @Query(() => CoreHealthCheckResult, { description: 'Get health check result' })
  async healthCheck() {
    return this.healthCheckService.healthCheck();
  }
}
