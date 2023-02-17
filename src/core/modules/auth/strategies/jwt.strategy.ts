import { Injectable, UnauthorizedException } from '@nestjs/common';
import { PassportStrategy } from '@nestjs/passport';
import { ExtractJwt, Strategy } from 'passport-jwt';
import { ConfigService } from '../../../common/services/config.service';
import { AuthGuardStrategy } from '../auth-guard-strategy.enum';
import { JwtPayload } from '../interfaces/jwt-payload.interface';
import { CoreAuthService } from '../services/core-auth.service';
import { Request as RequestType } from 'express';

/**
 * Use JWT strategy for passport
 */
@Injectable()
export class JwtStrategy extends PassportStrategy(Strategy, AuthGuardStrategy.JWT) {
  /**
   * Init JWT strategy
   */
  constructor(protected readonly authService: CoreAuthService, protected readonly configService: ConfigService) {
    super({
      jwtFromRequest: ExtractJwt.fromExtractors([
        JwtStrategy.extractJWTFromCookie,
        ExtractJwt.fromAuthHeaderAsBearerToken(),
      ]),
      privateKey: configService.get('jwt.privateKey'),
      publicKey: configService.get('jwt.publicKey'),
      secret: configService.get('jwt.secret') || configService.get('jwt.secretOrPrivateKey'),
      secretOrKey: configService.get('jwt.secretOrPrivateKey') || configService.get('jwt.secret'),
      secretOrKeyProvider: configService.get('jwt.secretOrKeyProvider'),
    });
  }

  /**
   * Extract JWT from cookie
   */
  private static extractJWTFromCookie(req: RequestType): string | null {
    return req?.cookies?.token || null;
  }

  /**
   * Validate user via JWT payload
   */
  async validate(payload: JwtPayload) {
    const user = await this.authService.validateUser(payload);
    if (!user) {
      throw new UnauthorizedException('Unknown user');
    }
    return user;
  }
}
