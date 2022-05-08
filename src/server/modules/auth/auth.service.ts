import { Injectable, UnauthorizedException } from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import * as bcrypt from 'bcrypt';
import envConfig from '../../../config.env';
import { prepareServiceOptions } from '../../../core/common/helpers/service.helper';
import { ResolveSelector } from '../../../core/common/interfaces/resolve-selector.interface';
import { ServiceOptions } from '../../../core/common/interfaces/service-options.interface';
import { EmailService } from '../../../core/common/services/email.service';
import { JwtPayload } from '../../../core/modules/auth/interfaces/jwt-payload.interface';
import { UserService } from '../user/user.service';
import { Auth } from './auth.model';
import { AuthSignInInput } from './inputs/auth-sign-in.input';
import { AuthSignUpInput } from './inputs/auth-sign-up.input';

@Injectable()
export class AuthService {
  constructor(
    protected readonly jwtService: JwtService,
    protected readonly emailService: EmailService,
    protected readonly userService: UserService
  ) {}

  /**
   * Sign in for user
   */
  async signIn(input: AuthSignInInput, serviceOptions?: ServiceOptions): Promise<Auth> {
    // Prepare service options
    const serviceOptionsForUserService = prepareServiceOptions(serviceOptions, {
      // We need password, so we can't use prepare output handling and have to deactivate it
      prepareOutput: null,

      // Select user field for automatic populate handling via user service
      subFieldSelection: 'user',
    });

    // Get and check user
    const user = await this.userService.getViaEmail(input.email, serviceOptionsForUserService);
    if (!user) {
      throw new UnauthorizedException();
    }

    // Check password
    if (!(await bcrypt.compare(input.password, user.password))) {
      throw new UnauthorizedException();
    }

    // Create JWT and return sign-in data
    const payload: JwtPayload = { email: user.email };
    return Auth.map({
      token: this.jwtService.sign(payload),
      user,
    });
  }

  /**
   * Register a new user Account
   */
  async signUp(input: AuthSignUpInput, serviceOptions?: ServiceOptions): Promise<Auth> {
    // Prepare service options
    const serviceOptionsForUserService = prepareServiceOptions(serviceOptions, {
      // Select user field for automatic populate handling via user service
      subFieldSelection: 'user',
    });

    // Get and check user
    const user = await this.userService.create(input, serviceOptionsForUserService);
    if (!user) {
      throw Error('Email Address already in use');
    }

    // Send email
    await this.emailService.sendMail(user.email, 'Welcome', {
      htmlTemplate: 'welcome',
      templateData: { name: user.username, link: envConfig.email.verificationLink + '/' + user.verificationToken },
    });

    // Create JWT and return sign-in data
    const payload: JwtPayload = { email: user.email };
    return Auth.map({
      token: this.jwtService.sign(payload),
      user: user,
    });
  }
}
