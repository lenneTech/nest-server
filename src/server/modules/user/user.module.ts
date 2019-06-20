import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { JSON } from '../../../core/common/scalars/json.scalar';
import { AvatarController } from './avatar.controller';
import { User } from './user.model';
import { UserResolver } from './user.resolver';
import { UserService } from './user.service';

/**
 * User module
 */
@Module({
  imports: [TypeOrmModule.forFeature([User])],
  controllers: [AvatarController],
  providers: [JSON, UserResolver, UserService],
  exports: [JSON, TypeOrmModule, UserResolver, UserService],
})
export class UserModule {
}
