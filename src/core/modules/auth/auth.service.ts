import { Inject, Injectable, UnauthorizedException } from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import * as bcrypt from 'bcrypt';
import { IAuthUserService } from './interfaces/auth-user-service.interface';
import { IAuthUser } from './interfaces/auth-user.interface';
import { IJwtPayload } from './interfaces/jwt-payload.interface';

/**
 * AuthService to handle user authentication
 */
@Injectable()
export class AuthService {

  /**
   * Inject services
   */
  constructor(
    @Inject('UserService') private readonly userService: IAuthUserService,
    private readonly jwtService: JwtService,
  ) {}

  /**
   * User sign in via email
   */
  async signIn(email: string, password: string): Promise<{ token: string, user: IAuthUser }> {
    const user = await this.userService.getViaEmail(email);
    if (!await bcrypt.compare(password, user.password)) {
      throw new UnauthorizedException();
    }
    const payload: IJwtPayload = { email: user.email };
    return {
      token: this.jwtService.sign(payload),
      user,
    };
  }

  /**
   * Validate user
   */
  async validateUser(payload: IJwtPayload): Promise<any> {
    return await this.userService.getViaEmail(payload.email);
  }
}
