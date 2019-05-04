import { Injectable, UnauthorizedException } from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import * as bcrypt from 'bcrypt';
import { JwtPayload } from '../interfaces/jwt-payload.interface';
import { ICoreAuthUser } from '../interfaces/core-auth-user.interface';
import { CoreAuthUserService } from './core-auth-user.service';

/**
 * CoreAuthService to handle user authentication
 */
@Injectable()
export class CoreAuthService {
  constructor(
    private readonly userService: CoreAuthUserService,
    private readonly jwtService: JwtService,
  ) {}

  /**
   * User sign in via email
   */
  async signIn(email: string, password: string): Promise<{ token: string, user: ICoreAuthUser }> {
    const user = await this.userService.getViaEmail(email);
    if (!await bcrypt.compare(password, user.password)) {
      throw new UnauthorizedException();
    }
    const payload: JwtPayload = { email: user.email };
    return {
      token: this.jwtService.sign(payload),
      user,
    };
  }

  /**
   * Validate user
   */
  async validateUser(payload: JwtPayload): Promise<any> {
    return await this.userService.getViaEmail(payload.email);
  }
}
