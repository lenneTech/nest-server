import { Module } from '@nestjs/common';
import { GraphQLModule } from '@nestjs/graphql';
import { TypeOrmModule } from '@nestjs/typeorm';
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
})
export class ServerModule {
}
