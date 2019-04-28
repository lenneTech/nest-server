import { DynamicModule, Module, Type } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { IUserResolver } from './interfaces/user-resolver.interface';
import { IUserService } from './interfaces/user-service.interface';
import { IUser } from './interfaces/user.interface';
import { UserResolver } from './user.resolver';
import { UserService } from './user.service';
import { JSON } from '../../common/scalars/json.scalar';

/**
 * AuthModule to handle user authentication
 */
@Module({})
export class UserModule {

  /**
   * Dynamic module
   * see https://docs.nestjs.com/modules#dynamic-modules
   */
  static forRoot(
    userClass: Type<IUser>,
    options: {
      userResolverClass?: Type<IUserResolver>,
      userServiceClass?: Type<IUserService>,
    },
  ): DynamicModule {
    return {
      module: UserModule,
      imports: [TypeOrmModule.forFeature([userClass])],
      providers: [
        {
          provide: 'UserResolver',
          useClass: options.userResolverClass ? options.userResolverClass : UserResolver(userClass),
        },
        {
          provide: 'UserService',
          useClass: options.userServiceClass ? options.userServiceClass : UserService(userClass),
        },
        JSON,
      ],
      exports: ['UserService'],
    };
  }
}
