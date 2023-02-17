import { BadRequestException, Injectable, UnauthorizedException } from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import * as bcrypt from 'bcrypt';
import { randomUUID } from 'crypto';
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
  async logout(
    tokenOrRefreshToken: string,
    serviceOptions: ServiceOptions & { allDevices?: boolean }
  ): Promise<boolean> {
    // Check authentication
    const user = serviceOptions.currentUser;
    if (!user || !tokenOrRefreshToken) {
      throw new UnauthorizedException('Invalid token');
    }

    // Check authorization
    const deviceId = this.decodeJwt(tokenOrRefreshToken)?.deviceId;
    if (!deviceId || !user.refreshTokens[deviceId]) {
      throw new UnauthorizedException('Invalid token');
    }

    // Logout from all devices
    if (serviceOptions.allDevices) {
      user.refreshTokens = {};
      await this.userService.update(user.id, { refreshTokens: {} }, serviceOptions);
      return true;
    }

    // Logout from specific devices
    delete user.refreshTokens[deviceId];
    await this.userService.update(user.id, { refreshTokens: user.refreshTokens }, serviceOptions);
    return true;
  }

  /**
   * Refresh tokens
   */
  async refreshTokens(user: ICoreAuthUser, currentRefreshToken: string) {
    // Create new tokens
    const { deviceId, deviceDescription } = this.decodeJwt(currentRefreshToken);
    const tokens = await this.createTokens(user.id, { deviceId, deviceDescription });
    tokens.refreshToken = await this.updateRefreshToken(user, currentRefreshToken, tokens.refreshToken);

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
    const { email, password, deviceId, deviceDescription } = input;

    // Get user
    const user = await this.userService.getViaEmail(email, serviceOptionsForUserService);
    if (!user) {
      throw new UnauthorizedException('Unknown email');
    }
    if (!((await bcrypt.compare(password, user.password)) || (await bcrypt.compare(sha256(password), user.password)))) {
      throw new UnauthorizedException('Wrong password');
    }

    // Return tokens and user
    return this.getResult(user, { deviceId, deviceDescription });
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
      throw new BadRequestException('Email address already in use');
    }

    // Set device ID
    const { deviceId, deviceDescription } = input;

    // Return tokens and user
    return this.getResult(user, { deviceId, deviceDescription });
  }

  /**
   * Validate user
   */
  async validateUser(payload: JwtPayload): Promise<any> {
    // Get user
    const user = await this.userService.get(payload.id);

    // Check if user exists and is logged in
    const device = user?.refreshTokens?.[payload.deviceId];
    if (!device || !payload.tokenId || device.tokenId !== payload.tokenId) {
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
  protected async getResult(
    user: ICoreAuthUser,
    data?: { [key: string]: any; deviceId?: string },
    currentRefreshToken?: string
  ) {
    // Create new tokens
    const tokens = await this.createTokens(user.id, data);

    // Set refresh token
    tokens.refreshToken = await this.updateRefreshToken(user, currentRefreshToken, tokens.refreshToken, data);

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
  protected async createTokens(userId: string, data?: { [key: string]: any; deviceId?: string }) {
    const payload: { [key: string]: any; id: string; deviceId: string } = {
      ...data,
      id: userId,
      deviceId: data?.deviceId || randomUUID(),
      tokenId: randomUUID(),
    };
    const [token, refreshToken] = await Promise.all([
      this.jwtService.signAsync(payload, {
        secret: this.getSecretFromConfig(false),
        ...this.configService.getFastButReadOnly('jwt.signInOptions', {}),
      }),
      this.jwtService.signAsync(payload, {
        secret: this.getSecretFromConfig(true),
        ...this.configService.getFastButReadOnly('jwt.refresh.signInOptions', {}),
      }),
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
    currentRefreshToken: string,
    newRefreshToken: string,
    data?: Record<string, any>
  ): Promise<string> {
    // Check if the update of the update token is allowed
    let deviceId: string;
    if (currentRefreshToken) {
      deviceId = this.decodeJwt(currentRefreshToken)?.deviceId;
      if (!deviceId || !user.refreshTokens?.[deviceId]) {
        throw new UnauthorizedException('Invalid token');
      }
      if (!this.configService.getFastButReadOnly('jwt.refresh.renewal')) {
        // Return currentToken
        return currentRefreshToken;
      }
    }

    // Prepare data
    data = data || {};
    if (!user.refreshTokens) {
      user.refreshTokens = {};
    }
    if (deviceId) {
      const oldData = user.refreshTokens[deviceId] || {};
      data = Object.assign(oldData, data);
    }

    // Set new token
    const payload = this.decodeJwt(newRefreshToken);
    if (!payload) {
      throw new UnauthorizedException('Invalid token');
    }
    if (!deviceId) {
      deviceId = payload.deviceId;
    }
    user.refreshTokens[deviceId] = { ...data, deviceId, tokenId: payload.tokenId };
    await this.userService.update(getStringIds(user), { refreshTokens: user.refreshTokens }, { force: true });

    // Return new token
    return newRefreshToken;
  }
}
