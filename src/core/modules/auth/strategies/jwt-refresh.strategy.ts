import { ForbiddenException, Injectable, UnauthorizedException } from '@nestjs/common';
import { PassportStrategy } from '@nestjs/passport';
import * as bcrypt from 'bcrypt';
import { Request as RequestType, Request } from 'express';
import { ExtractJwt, Strategy } from 'passport-jwt';
import { ConfigService } from '../../../common/services/config.service';
import { CoreAuthService } from '../services/core-auth.service';

@Injectable()
export class JwtRefreshStrategy extends PassportStrategy(Strategy, 'jwt-refresh') {
  constructor(protected readonly authService: CoreAuthService, protected readonly configService: ConfigService) {
    super({
      jwtFromRequest: ExtractJwt.fromExtractors([
        JwtRefreshStrategy.extractJWTFromCookie,
        ExtractJwt.fromAuthHeaderAsBearerToken(),
      ]),
      privateKey: configService.get('jwt.refresh.privateKey'),
      publicKey: configService.get('jwt.refresh.publicKey'),
      secret: configService.get('jwt.refresh.secret') || configService.get('jwt.refresh.secretOrPrivateKey'),
      secretOrKey: configService.get('jwt.refresh.secretOrPrivateKey') || configService.get('jwt.refresh.secret'),
      secretOrKeyProvider: configService.get('jwt.refresh.secretOrKeyProvider'),
      passReqToCallback: true,
    });
  }

  /**
   * Extract JWT from cookie
   */
  private static extractJWTFromCookie(req: RequestType): string | null {
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
