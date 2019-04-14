import { Module } from '@nestjs/common';
import { APP_GUARD, APP_INTERCEPTOR } from '@nestjs/core';
import { GraphQLModule } from '@nestjs/graphql';
import { TypeOrmModule } from '@nestjs/typeorm';
import { RolesGuard } from './common/guards/roles.guard';
import { CheckResponseInterceptor } from './common/interceptors/check-response.interceptor';
import envConfig from './config.env';
import { UserModule } from './modules/user/user.module';

// =============================================================================
// Server module
// =============================================================================

/**
 * Server module
 */
@Module({
  imports: [
    UserModule,
    GraphQLModule.forRoot({
      autoSchemaFile: 'schema.gql',
      installSubscriptionHandlers: true
    }),
    TypeOrmModule.forRoot(envConfig.typeOrm),
  ],
  providers: [
    {
        provide: APP_GUARD,
        useClass: RolesGuard
    }
  ]
})
export class ServerModule {
}
