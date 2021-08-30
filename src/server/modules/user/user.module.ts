import { Module } from '@nestjs/common';
import { JSON } from '../../../core/common/scalars/json.scalar';
import { AvatarController } from './avatar.controller';
import { User, UserSchema } from './user.model';
import { UserResolver } from './user.resolver';
import { UserService } from './user.service';
import { MongooseModule } from '@nestjs/mongoose';

/**
 * User module
 */
@Module({
  imports: [MongooseModule.forFeature([{ name: User.name, schema: UserSchema }])],
  controllers: [AvatarController],
  providers: [JSON, UserResolver, UserService],
  exports: [MongooseModule, UserResolver, UserService],
})
export class UserModule {}
