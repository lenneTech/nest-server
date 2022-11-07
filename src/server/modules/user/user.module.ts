import { Module } from '@nestjs/common';
import { MongooseModule } from '@nestjs/mongoose';
import { PubSub } from 'graphql-subscriptions';
import { ConfigService } from '../../../core/common/services/config.service';
import { AvatarController } from './avatar.controller';
import { User, UserSchema } from './user.model';
import { UserResolver } from './user.resolver';
import { UserService } from './user.service';

/**
 * User module
 */
@Module({
  imports: [MongooseModule.forFeature([{ name: User.name, schema: UserSchema }])],
  controllers: [AvatarController],
  providers: [
    UserResolver,
    ConfigService,
    UserService,
    {
      provide: 'USER_CLASS',
      useValue: User,
    },
    {
      provide: 'PUB_SUB',
      useValue: new PubSub(),
    },
  ],
  exports: [MongooseModule, UserResolver, UserService, 'USER_CLASS'],
})
export class UserModule {}
