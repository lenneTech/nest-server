import { BadRequestException, Injectable, UnauthorizedException } from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import bcrypt = require('bcrypt');
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
 * Options for getResult method
 */
export interface GetResultOptions {
  /** Current refresh token (for renewal) */
  currentRefreshToken?: string;
  /** Additional data (deviceId, deviceDescription, etc.) */
  data?: { [key: string]: any; deviceId?: string };
  /** Service options including currentUser for securityCheck */
  serviceOptions?: ServiceOptions;
}

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
    protected readonly configService: ConfigService,
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
    serviceOptions: ServiceOptions & { allDevices?: boolean },
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
  async refreshTokens(user: ICoreAuthUser, currentRefreshToken: string, serviceOptions?: ServiceOptions) {
    // Create new tokens
    const { deviceDescription, deviceId } = this.decodeJwt(currentRefreshToken);
    const tokens = await this.createTokens(user.id, { deviceDescription, deviceId });
    tokens.refreshToken = await this.updateRefreshToken(user, currentRefreshToken, tokens.refreshToken);

    // Return with currentUser set so securityCheck knows user is requesting own data
    return this.getResult(user, {
      currentRefreshToken,
      data: { deviceDescription, deviceId },
      serviceOptions: { ...serviceOptions, currentUser: user },
    });
  }

  /**
   * User sign in via email
   */
  async signIn(input: CoreAuthSignInInput, serviceOptions?: ServiceOptions): Promise<CoreAuthModel> {
    // Check input
    if (!input) {
      throw new BadRequestException('Missing input');
    }

    // Prepare service options
    const serviceOptionsForUserService = prepareServiceOptions(serviceOptions, {
      // We need password, so we can't use prepare output handling and have to deactivate it
      prepareOutput: null,

      // Select user field for automatic populate handling via user service
      subFieldSelection: 'user',
    });

    // Inputs
    const { deviceDescription, deviceId, email, password } = input;

    // Get user
    const user = await this.userService.getViaEmail(email, serviceOptionsForUserService);
    if (!user) {
      throw new UnauthorizedException('Unknown email');
    }
    if (!((await bcrypt.compare(password, user.password)) || (await bcrypt.compare(sha256(password), user.password)))) {
      throw new UnauthorizedException('Wrong password');
    }

    // Return tokens and user with currentUser set so securityCheck knows user is requesting own data
    return this.getResult(user, {
      data: { deviceDescription, deviceId },
      serviceOptions: { ...serviceOptions, currentUser: user },
    });
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
    try {
      const user = await this.userService.create(input, serviceOptionsForUserService);
      if (!user) {
        throw new BadRequestException('Email address already in use');
      }

      // Set device ID
      const { deviceDescription, deviceId } = input;

      // Return tokens and user with currentUser set so securityCheck knows user is requesting own data
      return this.getResult(user, {
        data: { deviceDescription, deviceId },
        serviceOptions: { ...serviceOptions, currentUser: user },
      });
    } catch (err) {
      if (err?.message === 'Unprocessable Entity') {
        throw new BadRequestException('Email address already in use');
      }
      throw err;
    }
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
   *
   * @param user - The authenticated user
   * @param options - Optional configuration for result generation
   * @param options.data - Additional data (deviceId, deviceDescription, etc.)
   * @param options.currentRefreshToken - Current refresh token (for renewal)
   * @param options.serviceOptions - Service options including currentUser for securityCheck
   */
  protected async getResult(user: ICoreAuthUser, options?: GetResultOptions) {
    const { currentRefreshToken, data, serviceOptions } = options || {};

    // Create new tokens
    const tokens = await this.createTokens(user.id, data);

    // Set refresh token
    tokens.refreshToken = await this.updateRefreshToken(user, currentRefreshToken, tokens.refreshToken, data);

    // Return tokens and user
    // Pass serviceOptions to prepareOutput so currentUser is available for securityCheck
    return CoreAuthModel.map({
      ...tokens,
      user: await this.userService.prepareOutput(user, serviceOptions),
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
      this.configService.getFastButReadOnly(`${path}.signInOptions.secret`) ||
      this.configService.getFastButReadOnly(`${path}.signInOptions.secretOrPrivateKey`) ||
      this.configService.getFastButReadOnly(`${path}.secret`) ||
      this.configService.getFastButReadOnly(`${path}.secretOrPrivateKey`)
    );
  }

  /**
   * Get JWT and refresh token
   */
  protected async createTokens(userId: string, data?: { [key: string]: any; deviceId?: string }) {
    // Initializations
    const sameTokenIdPeriod: number = this.configService.getFastButReadOnly('jwt.sameTokenIdPeriod', 0);
    const deviceId = data?.deviceId || randomUUID();

    // Use last token ID or a new one
    let tokenId: string = randomUUID();
    if (sameTokenIdPeriod) {
      const user: ICoreAuthUser = await this.userService.get(userId, { force: true });
      const tempToken = user?.tempTokens?.[deviceId];
      if (tempToken && tempToken.tokenId && tempToken.createdAt >= new Date().getTime() - sameTokenIdPeriod) {
        tokenId = tempToken.tokenId;
      }
    }

    const payload: { [key: string]: any; deviceId: string; id: string; tokenId: string } = {
      ...data,
      deviceId,
      id: userId,
      tokenId,
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
      refreshToken,
      token,
    };
  }

  /**
   * Update refresh token(s)
   */
  protected async updateRefreshToken(
    user: ICoreAuthUser,
    currentRefreshToken: string,
    newRefreshToken: string,
    data?: Record<string, any>,
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
    if (!user.tempTokens) {
      user.tempTokens = {};
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
    user.refreshTokens[deviceId] = {
      ...data,
      deviceDescription: payload.deviceDescription || data.deviceDescription,
      deviceId,
      tokenId: payload.tokenId,
    };
    user.tempTokens[deviceId] = { createdAt: new Date().getTime(), deviceId, tokenId: payload.tokenId };
    await this.userService.update(
      getStringIds(user),
      {
        refreshTokens: user.refreshTokens,
        tempTokens: user.tempTokens,
      },
      { force: true },
    );

    // Return new token
    return newRefreshToken;
  }
}
