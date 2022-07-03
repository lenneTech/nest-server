import { Injectable, UnauthorizedException } from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import * as bcrypt from 'bcrypt';
import { sha256 } from 'js-sha256';
import { merge } from '../../../common/helpers/config.helper';
import { ServiceOptions } from '../../../common/interfaces/service-options.interface';
import { ICoreAuthUser } from '../interfaces/core-auth-user.interface';
import { JwtPayload } from '../interfaces/jwt-payload.interface';
import { CoreAuthUserService } from './core-auth-user.service';

/**
 * CoreAuthService to handle user authentication
 */
@Injectable()
export class CoreAuthService {
  constructor(protected readonly userService: CoreAuthUserService, protected readonly jwtService: JwtService) {}

  /**
   * User sign in via email
   */
  async signIn(
    email: string,
    password: string,
    serviceOptions?: ServiceOptions
  ): Promise<{ token: string; user: ICoreAuthUser }> {
    serviceOptions = merge(serviceOptions || {}, { prepareOutput: null });

    // Get user
    const user = await this.userService.getViaEmail(email, serviceOptions);
    if (
      !user ||
      !((await bcrypt.compare(password, user.password)) || (await bcrypt.compare(sha256(password), user.password)))
    ) {
      throw new UnauthorizedException();
    }

    // Return JWT
    const payload: JwtPayload = { email: user.email };
    return {
      token: this.jwtService.sign(payload),
      user: await this.userService.prepareOutput(user),
    };
  }

  /**
   * Validate user
   */
  async validateUser(payload: JwtPayload): Promise<any> {
    return await this.userService.getViaEmail(payload.email);
  }

  /**
   * Decode JWT
   */
  decodeJwt(token: string): JwtPayload {
    return this.jwtService.decode(token) as JwtPayload;
  }
}
