import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { JSON } from '../../../core/common/scalars/json.scalar';
import { User } from './user.model';
import { UserResolver } from './user.resolver';
import { UserService } from './user.service';

/**
 * User module
 */
@Module({
  imports: [TypeOrmModule.forFeature([User])],
  providers: [JSON, UserResolver, UserService],
  exports: [JSON, TypeOrmModule, UserResolver, UserService],
})
export class UserModule {
}
