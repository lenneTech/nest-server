import { Injectable, UnauthorizedException } from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import * as bcrypt from 'bcrypt';
import { sha256 } from 'js-sha256';
import { getStringIds } from '../../../common/helpers/db.helper';
import { prepareServiceOptions } from '../../../common/helpers/service.helper';
import { ServiceOptions } from '../../../common/interfaces/service-options.interface';
import { ConfigService } from '../../../common/services/config.service';
import { CoreAuthModel } from '../core-auth.model';
import { CoreAuthSignInInput } from '../inputs/core-auth-sign-in.input';
import { CoreAuthSignUpInput } from '../inputs/core-auth-sign-up.input';
import { ICoreAuthUser } from '../interfaces/core-auth-user.interface';
import { JwtPayload } from '../interfaces/jwt-payload.interface';
import { CoreAuthUserService } from './core-auth-user.service';

/**
 * CoreAuthService to handle user authentication
 */
@Injectable()
export class CoreAuthService {
  /**
   * Integrate services
   */
  constructor(
    protected readonly userService: CoreAuthUserService,
    protected readonly jwtService: JwtService,
    protected readonly configService: ConfigService
  ) {}

  /**
   * Decode JWT
   */
  decodeJwt(token: string): JwtPayload {
    return this.jwtService.decode(token) as JwtPayload;
  }

  /**
   * Logout user (from device)
   */
  async logout(serviceOptions: ServiceOptions & { deviceId?: string }): Promise<boolean> {
    const user = serviceOptions.currentUser;
    if (!serviceOptions.currentUser) {
      throw new UnauthorizedException();
    }
    const deviceId = serviceOptions.deviceId;
    if (deviceId) {
      if (!user.refreshTokens[deviceId]) {
        return false;
      }
      delete user.refreshTokens[deviceId];
      await this.userService.update(user.id, { refreshTokens: user.refreshTokens }, serviceOptions);
      return true;
    }
    user.refreshToken = null;
    user.refreshTokens = {};
    await this.userService.update(
      user.id,
      {
        refreshToken: user.refreshToken,
        refreshTokens: user.refreshTokens,
      },
      serviceOptions
    );
    return true;
  }

  /**
   * Refresh tokens
   */
  async refreshTokens(user: ICoreAuthUser, deviceId?: string) {
    // Create new tokens
    const tokens = await this.getTokens(user.id);
    await this.updateRefreshToken(user, tokens.refreshToken, { deviceId });

    // Return
    return CoreAuthModel.map({
      ...tokens,
      user: await this.userService.prepareOutput(user),
    });
  }

  /**
   * User sign in via email
   */
  async signIn(input: CoreAuthSignInInput, serviceOptions?: ServiceOptions): Promise<CoreAuthModel> {
    // Prepare service options
    const serviceOptionsForUserService = prepareServiceOptions(serviceOptions, {
      // We need password, so we can't use prepare output handling and have to deactivate it
      prepareOutput: null,

      // Select user field for automatic populate handling via user service
      subFieldSelection: 'user',
    });

    // Inputs
    const { email, password, deviceId } = input;

    // Get user
    const user = await this.userService.getViaEmail(email, serviceOptions);
    if (
      !user ||
      !((await bcrypt.compare(password, user.password)) || (await bcrypt.compare(sha256(password), user.password)))
    ) {
      throw new UnauthorizedException();
    }

    // Set device ID
    serviceOptionsForUserService.deviceId = input.deviceId;

    // Return tokens and user
    return this.getResult(user, serviceOptions);
  }

  /**
   * Register a new user account
   */
  async signUp(input: CoreAuthSignUpInput, serviceOptions?: ServiceOptions): Promise<CoreAuthModel> {
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

    // Set device ID
    serviceOptionsForUserService.deviceId = input.deviceId;

    // Return tokens and user
    return this.getResult(user, serviceOptionsForUserService);
  }

  /**
   * Validate user
   */
  async validateUser(payload: JwtPayload): Promise<any> {
    // Get user
    const user = await this.userService.get(payload.id);

    // Check if user exists and is logged in
    if (!user?.refreshToken) {
      return null;
    }

    // Return user
    return user;
  }

  // ===================================================================================================================
  // Helper
  // ===================================================================================================================

  /**
   * Rest result with user and tokens
   */
  protected async getResult(user: ICoreAuthUser, serviceOptions: ServiceOptions & { deviceId?: string }) {
    // Create new tokens
    const tokens = await this.getTokens(user.id);

    // Set refresh token
    await this.updateRefreshToken(user, tokens.refreshToken, serviceOptions);

    // Return tokens and user
    return CoreAuthModel.map({
      ...tokens,
      user: await this.userService.prepareOutput(user),
    });
  }

  /**
   * Get secret from JWT or refresh config
   */
  protected getSecretFromConfig(refresh?: boolean) {
    let path = 'jwt';
    if (refresh) {
      path += '.refresh';
    }
    return (
      this.configService.getFastButReadOnly(path + '.signInOptions.secret') ||
      this.configService.getFastButReadOnly(path + '.signInOptions.secretOrPrivateKey') ||
      this.configService.getFastButReadOnly(path + '.secret') ||
      this.configService.getFastButReadOnly(path + '.secretOrPrivateKey')
    );
  }

  /**
   * Get JWT and refresh token
   */
  protected async getTokens(userId: string) {
    const [token, refreshToken] = await Promise.all([
      this.jwtService.signAsync(
        { id: userId },
        {
          secret: this.getSecretFromConfig(false),
          ...this.configService.getFastButReadOnly('jwt.signInOptions', {}),
        }
      ),
      this.jwtService.signAsync(
        { id: userId },
        {
          secret: this.getSecretFromConfig(true),
          ...this.configService.getFastButReadOnly('jwt.refresh.signInOptions', {}),
        }
      ),
    ]);
    return {
      token,
      refreshToken,
    };
  }

  /**
   * Update refresh token(s)
   */
  protected async updateRefreshToken(
    user: ICoreAuthUser,
    refreshToken: string,
    serviceOptions: ServiceOptions & { deviceId?: string } = {}
  ) {
    const hashedRefreshToken = await bcrypt.hash(refreshToken, 10);
    const deviceId = serviceOptions?.deviceId;
    if (deviceId) {
      if (!user.refreshTokens) {
        user.refreshTokens = {};
      }
      user.refreshTokens[deviceId] = hashedRefreshToken;

      // Refresh token must be set even if only a specific device is logged in, because of the check in the validateUser method
      if (!user.refreshToken) {
        user.refreshToken = hashedRefreshToken;
      }

      return await this.userService.update(
        getStringIds(user),
        { refreshTokens: user.refreshTokens, refreshToken: user.refreshToken },
        {
          ...serviceOptions,
          force: true,
        }
      );
    }
    user.refreshToken = hashedRefreshToken;
    return await this.userService.update(
      getStringIds(user),
      { refreshToken: hashedRefreshToken },
      {
        ...serviceOptions,
        force: true,
      }
    );
  }
}
