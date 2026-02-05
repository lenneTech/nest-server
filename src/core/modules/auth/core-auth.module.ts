import { DynamicModule, ForwardReference, Module, Provider, Type } from '@nestjs/common';
import { APP_GUARD } from '@nestjs/core';
import { JwtModule, JwtModuleOptions } from '@nestjs/jwt';
import { PassportModule } from '@nestjs/passport';
import { PubSub } from 'graphql-subscriptions';

import { AuthGuardStrategy } from './auth-guard-strategy.enum';
import { LegacyAuthRateLimitGuard } from './guards/legacy-auth-rate-limit.guard';
import { RolesGuardRegistry } from './guards/roles-guard-registry';
import { RolesGuard } from './guards/roles.guard';
import { CoreAuthUserService } from './services/core-auth-user.service';
import { CoreAuthService } from './services/core-auth.service';
import { LegacyAuthRateLimiter } from './services/legacy-auth-rate-limiter.service';
import { JwtRefreshStrategy } from './strategies/jwt-refresh.strategy';
import { JwtStrategy } from './strategies/jwt.strategy';

/**
 * CoreAuthModule to handle user authentication and enables Roles
 */
@Module({})
export class CoreAuthModule {
  /**
   * Dynamic module
   * see https://docs.nestjs.com/modules#dynamic-modules
   */
  static forRoot(
    UserModule: Type<any>,
    UserService: Type<CoreAuthUserService>,
    options: JwtModuleOptions & {
      authService?: Type<CoreAuthService>;
      imports?: Array<DynamicModule | ForwardReference | Promise<DynamicModule> | Type<any>>;
      jwtRefreshStrategy?: Type<JwtRefreshStrategy>;
      jwtStrategy?: Type<JwtStrategy>;
      providers?: Provider[];
    },
  ): DynamicModule {
    // Process imports
    let imports: any[] = [
      UserModule,
      PassportModule.register({ defaultStrategy: [AuthGuardStrategy.JWT, AuthGuardStrategy.JWT_REFRESH] }),
      JwtModule.register(options),
    ];
    if (Array.isArray(options?.imports)) {
      imports = imports.concat(options.imports);
    }

    // Process providers
    // Only register RolesGuard if not already registered (prevents duplicate with CoreBetterAuthModule)
    const rolesGuardProvider = RolesGuardRegistry.isRegistered()
      ? []
      : (() => {
          RolesGuardRegistry.markRegistered('CoreAuthModule');
          return [{ provide: APP_GUARD, useClass: RolesGuard }];
        })();

    let providers: any[] = [
      // [Global] The GraphQLAuthGuard integrates the user into context
      ...rolesGuardProvider,
      {
        provide: CoreAuthUserService,
        useClass: UserService,
      },
      {
        provide: 'PUB_SUB',
        useValue: new PubSub(),
      },
      {
        provide: CoreAuthService,
        useClass: options.authService || CoreAuthService,
      },
      {
        provide: JwtStrategy,
        useClass: options.jwtStrategy || JwtStrategy,
      },
      {
        provide: JwtRefreshStrategy,
        useClass: options.jwtRefreshStrategy || JwtRefreshStrategy,
      },
      // Rate limiting for Legacy Auth endpoints (disabled by default, configure via auth.rateLimit)
      LegacyAuthRateLimiter,
      LegacyAuthRateLimitGuard,
    ];
    if (Array.isArray(options?.providers)) {
      providers = providers.concat(options.providers);
    }

    // Return CoreAuthModule
    return {
      exports: [
        CoreAuthService,
        JwtModule,
        JwtStrategy,
        JwtRefreshStrategy,
        LegacyAuthRateLimiter,
        LegacyAuthRateLimitGuard,
        PassportModule,
        UserModule,
      ],
      imports,
      module: CoreAuthModule,
      providers,
    };
  }
}
