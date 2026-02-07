import { Module } from '@nestjs/common';

import { CoreSystemSetupController } from './core-system-setup.controller';
import { CoreSystemSetupService } from './core-system-setup.service';

/**
 * CoreSystemSetupModule provides initial admin creation for fresh deployments.
 *
 * This module is conditionally imported in CoreModule when `systemSetup` is configured.
 * It follows the "presence implies enabled" pattern:
 * - `systemSetup: undefined` → Module not loaded (default, backward compatible)
 * - `systemSetup: {}` → Module loaded
 * - `systemSetup: { enabled: false }` → Module not loaded
 */
@Module({
  controllers: [CoreSystemSetupController],
  providers: [CoreSystemSetupService],
})
export class CoreSystemSetupModule {}
