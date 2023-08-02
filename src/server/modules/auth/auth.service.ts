import { Injectable } from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import { ServiceOptions } from '../../../core/common/interfaces/service-options.interface';
import { ConfigService } from '../../../core/common/services/config.service';
import { EmailService } from '../../../core/common/services/email.service';
import { CoreAuthService } from '../../../core/modules/auth/services/core-auth.service';
import { UserService } from '../user/user.service';
import { Auth } from './auth.model';
import { AuthSignInInput } from './inputs/auth-sign-in.input';
import { AuthSignUpInput } from './inputs/auth-sign-up.input';

@Injectable()
export class AuthService extends CoreAuthService {
  constructor(
    protected override readonly jwtService: JwtService,
    protected readonly emailService: EmailService,
    protected override readonly userService: UserService,
    protected override readonly configService: ConfigService,
  ) {
    super(userService, jwtService, configService);
  }

  /**
   * Sign in for user
   *
   * Overwrites the parent method for mapping
   */
  override async signIn(input: AuthSignInInput, serviceOptions?: ServiceOptions): Promise<Auth> {
    return Auth.map(await super.signIn(input, serviceOptions));
  }

  /**
   * Register a new user Account
   *
   * Overwrites the parent method for integrating email sending and mapping
   */
  override async signUp(input: AuthSignUpInput, serviceOptions?: ServiceOptions): Promise<Auth> {
    const result = await super.signUp(input, serviceOptions);
    const { user } = result;

    // Send email
    await this.emailService.sendMail(user.email, 'Welcome', {
      htmlTemplate: 'welcome',
      templateData: {
        name: user.username,
        link: `${this.configService.configFastButReadOnly.email.verificationLink}/${user.verificationToken}`,
      },
    });

    // Return mapped result
    return Auth.map(result);
  }
}
