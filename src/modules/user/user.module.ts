import { Module } from '@nestjs/common';
import { UserService } from './user.service';
import { UserResolver } from './user.resolver';
import { JSON } from '../../common/scalars/json.scalar';

@Module({
  providers: [UserService, UserResolver, JSON],
})
export class UserModule {}
