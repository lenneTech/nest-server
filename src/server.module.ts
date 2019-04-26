import { Module } from '@nestjs/common';
import envConfig from './config.env';
import { CoreModule } from './core.module';

// =============================================================================
// Server module
// =============================================================================
/**
 * Server module (dynamic)
 */
@Module({
  imports: [
    CoreModule.forRoot(envConfig),
  ],
})
export class ServerModule {}
