import { Injectable, UnauthorizedException } from '@nestjs/common';
import { PassportStrategy } from '@nestjs/passport';
import { ExtractJwt, Strategy } from 'passport-jwt';
import { ConfigService } from '../../common/services/config.service';
import { JwtPayload } from './interfaces/jwt-payload.interface';
import { CoreAuthService } from './services/core-auth.service';

/**
 * Use JWT strategy for passport
 */
@Injectable()
export class JwtStrategy extends PassportStrategy(Strategy) {
  /**
   * Init JWT strategy
   */
  constructor(protected readonly authService: CoreAuthService, protected readonly configService: ConfigService) {
    super({
      jwtFromRequest: ExtractJwt.fromAuthHeaderAsBearerToken(),
      privateKey: configService.get('jwt.privateKey'),
      publicKey: configService.get('jwt.publicKey'),
      secret: configService.get('jwt.secret') || configService.get('jwt.secretOrPrivateKey'),
      secretOrKey: configService.get('jwt.secretOrPrivateKey') || configService.get('jwt.secret'),
      secretOrKeyProvider: configService.get('jwt.secretOrKeyProvider'),
    });
  }

  /**
   * Validate user via JWT payload
   */
  async validate(payload: JwtPayload) {
    const user = await this.authService.validateUser(payload);
    if (!user) {
      throw new UnauthorizedException();
    }
    return user;
  }
}
