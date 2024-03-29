import { Injectable, UnauthorizedException } from '@nestjs/common';
import { PassportStrategy } from '@nestjs/passport';
import { Request, Request as RequestType } from 'express';
import { ExtractJwt, Strategy } from 'passport-jwt';

import { ConfigService } from '../../../common/services/config.service';
import { AuthGuardStrategy } from '../auth-guard-strategy.enum';
import { CoreAuthService } from '../services/core-auth.service';

@Injectable()
export class JwtRefreshStrategy extends PassportStrategy(Strategy, AuthGuardStrategy.JWT_REFRESH) {
  constructor(
    protected readonly authService: CoreAuthService,
    protected readonly configService: ConfigService,
  ) {
    super({
      jwtFromRequest: ExtractJwt.fromExtractors([
        JwtRefreshStrategy.extractJWTFromCookie,
        ExtractJwt.fromAuthHeaderAsBearerToken(),
      ]),
      passReqToCallback: true,
      privateKey: configService.get('jwt.refresh.privateKey'),
      publicKey: configService.get('jwt.refresh.publicKey'),
      secret: configService.get('jwt.refresh.secret') || configService.get('jwt.refresh.secretOrPrivateKey'),
      secretOrKey: configService.get('jwt.refresh.secretOrPrivateKey') || configService.get('jwt.refresh.secret'),
      secretOrKeyProvider: configService.get('jwt.refresh.secretOrKeyProvider'),
    });
  }

  /**
   * Extract JWT from cookie
   */
  private static extractJWTFromCookie(req: RequestType): null | string {
    return req?.cookies?.refreshToken || null;
  }

  /**
   * Validate user via JWT payload
   */
  async validate(req: Request, payload: any) {
    // Check user
    const user = await this.authService.validateUser(payload);
    if (!user) {
      throw new UnauthorizedException('Unknown user');
    }

    // Return user
    return user;
  }
}
