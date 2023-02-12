import { ForbiddenException, Injectable, UnauthorizedException } from '@nestjs/common';
import { PassportStrategy } from '@nestjs/passport';
import * as bcrypt from 'bcrypt';
import { Request } from 'express';
import { ExtractJwt, Strategy } from 'passport-jwt';
import { ConfigService } from '../../../common/services/config.service';
import { CoreAuthService } from '../services/core-auth.service';

@Injectable()
export class JwtRefreshStrategy extends PassportStrategy(Strategy, 'jwt-refresh') {
  constructor(protected readonly authService: CoreAuthService, protected readonly configService: ConfigService) {
    super({
      jwtFromRequest: ExtractJwt.fromAuthHeaderAsBearerToken(),
      privateKey: configService.get('jwt.refresh.privateKey'),
      publicKey: configService.get('jwt.refresh.publicKey'),
      secret: configService.get('jwt.refresh.secret') || configService.get('jwt.refresh.secretOrPrivateKey'),
      secretOrKey: configService.get('jwt.refresh.secretOrPrivateKey') || configService.get('jwt.refresh.secret'),
      secretOrKeyProvider: configService.get('jwt.refresh.secretOrKeyProvider'),
      passReqToCallback: true,
    });
  }

  /**
   * Validate user via JWT payload
   */
  async validate(req: Request, payload: any) {
    // Check user
    const user = await this.authService.validateUser(payload);
    if (!user) {
      throw new UnauthorizedException();
    }

    // Check refresh token
    const refreshToken = req
      .get('Authorization')
      .replace(/bearer/i, '')
      .trim();
    const refreshTokenMatches = await bcrypt.compare(refreshToken, user.refreshToken);
    if (!refreshTokenMatches) {
      throw new ForbiddenException('Access Denied');
    }

    // Return user
    return user;
  }
}
