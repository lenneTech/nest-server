import { ExtractJwt, Strategy } from 'passport-jwt';
import { ConfigService } from '../../common/services/config.service';
import { AuthService } from './auth.service';
import { PassportStrategy } from '@nestjs/passport';
import { Injectable, UnauthorizedException } from '@nestjs/common';
import { JwtPayload } from './interfaces/jwt-payload.interface';

/**
 * Use JWT strategy for passport
 */
@Injectable()
export class JwtStrategy extends PassportStrategy(Strategy) {

  /**
   * Init JWT strategy
   */
  constructor(
    private readonly authService: AuthService,
    private readonly configService: ConfigService,
  ) {
    super({
      jwtFromRequest: ExtractJwt.fromAuthHeaderAsBearerToken(),
      secretOrKey: configService.get('jwt.secretOrPrivateKey'),
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
