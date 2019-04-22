import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { JSON } from '../../common/scalars/json.scalar';
import { User } from './user.model';
import { UserResolver } from './user.resolver';
import { UserService } from './user.service';

/**
 * User module
 */
@Module({
  imports: [TypeOrmModule.forFeature([User])],
  providers: [UserService, UserResolver, JSON],
  exports: [UserService],
})
export class UserModule {
}
