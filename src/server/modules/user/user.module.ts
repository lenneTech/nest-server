import { forwardRef, Module } from '@nestjs/common';
import { PubSub } from 'graphql-subscriptions';

import { CorePersistenceModule } from '../../../core/common/persistence/core-persistence.module.js';
import { ConfigService } from '../../../core/common/services/config.service.js';
import { CoreRedisPubSub } from '../../../core/common/services/core-redis-pubsub.js';
import { CoreRedisService } from '../../../core/common/services/core-redis.service.js';
import { FileModule } from '../file/file.module.js';
import { AvatarController } from './avatar.controller.js';
import { UserController } from './user.controller.js';
import { User, UserSchema } from './user.model.js';
import { UserResolver } from './user.resolver.js';
import { UserService } from './user.service.js';

/**
 * The user model, registered database-neutrally: `@InjectModel()` keeps working, and `database` in the configuration
 * decides whether users are stored in MongoDB or a SQL database (`CorePersistenceModule`)
 */
const UserPersistence = CorePersistenceModule.forFeature([{ model: User, name: User.name, schema: UserSchema }]);

/**
 * User module
 */
@Module({
  controllers: [AvatarController, UserController],
  exports: [UserPersistence, UserResolver, UserService, 'USER_CLASS'],
  // forwardRef: FileModule already imports UserModule, and the avatar upload now
  // needs FileService to reach the central storage — so the two reference each other.
  imports: [UserPersistence, forwardRef(() => FileModule)],
  providers: [
    UserResolver,
    ConfigService,
    UserService,
    {
      provide: 'USER_CLASS',
      useValue: User,
    },
    {
      // Redis-backed when Redis is enabled (subscriptions reach all replicas),
      // process-local in-memory PubSub otherwise
      provide: 'PUB_SUB',
      useFactory: (redisService?: CoreRedisService) =>
        redisService?.enabled ? new CoreRedisPubSub(redisService) : new PubSub(),
      inject: [{ optional: true, token: CoreRedisService }],
    },
  ],
})
export class UserModule {}
