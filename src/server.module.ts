import { Module } from '@nestjs/common';
import { APP_GUARD } from '@nestjs/core';
import { GraphQLModule } from '@nestjs/graphql';
import { TypeOrmModule } from '@nestjs/typeorm';
import { RolesGuard } from './common/guards/roles.guard';
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
      installSubscriptionHandlers: true,
      autoSchemaFile: 'schema.gql',
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
