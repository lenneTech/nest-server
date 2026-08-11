import { forwardRef, Module } from '@nestjs/common';
import { MongooseModule } from '@nestjs/mongoose';
import { PubSub } from 'graphql-subscriptions';

import { ConfigService } from '../../../core/common/services/config.service';
import { CoreRedisPubSub } from '../../../core/common/services/core-redis-pubsub';
import { CoreRedisService } from '../../../core/common/services/core-redis.service';
import { FileModule } from '../file/file.module';
import { AvatarController } from './avatar.controller';
import { UserController } from './user.controller';
import { User, UserSchema } from './user.model';
import { UserResolver } from './user.resolver';
import { UserService } from './user.service';

/**
 * User module
 */
@Module({
  controllers: [AvatarController, UserController],
  exports: [MongooseModule, UserResolver, UserService, 'USER_CLASS'],
  // forwardRef: FileModule already imports UserModule, and the avatar upload now
  // needs FileService to reach the central storage — so the two reference each other.
  imports: [MongooseModule.forFeature([{ name: User.name, schema: UserSchema }]), forwardRef(() => FileModule)],
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
