import {
  BadRequestException,
  Injectable,
  Logger,
  NotFoundException,
  Optional,
  UnauthorizedException,
} from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import bcrypt = require('bcrypt');
import { randomUUID } from 'crypto';
import { sha256 } from 'js-sha256';

import { getStringIds } from '../../../common/helpers/db.helper';
import { prepareServiceOptions } from '../../../common/helpers/service.helper';
import { ServiceOptions } from '../../../common/interfaces/service-options.interface';
import { ConfigService } from '../../../common/services/config.service';
import { CoreBetterAuthUserMapper } from '../../better-auth/core-better-auth-user.mapper';
import { CoreBetterAuthService } from '../../better-auth/core-better-auth.service';
import { ErrorCode } from '../../error-code';
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
 *
 * When Better-Auth (IAM) is enabled, this service delegates authentication to IAM
 * while maintaining backwards compatibility by returning Legacy JWT format tokens.
 *
 * Migration strategy:
 * - New users: Created directly in IAM with scrypt password hash
 * - Existing Legacy users: Lazily migrated on first sign-in
 *   (Legacy bcrypt password verified, then IAM account created with scrypt hash)
 *
 * @deprecated The signIn and signUp methods are deprecated when IAM is enabled.
 * Use the IAM REST endpoints (/iam/sign-in/email, /iam/sign-up/email) directly
 * for new implementations. Legacy endpoints remain for backwards compatibility.
 */
@Injectable()
export class CoreAuthService {
  private readonly logger = new Logger(CoreAuthService.name);

  /**
   * Integrate services
   */
  constructor(
    protected readonly userService: CoreAuthUserService,
    protected readonly jwtService: JwtService,
    protected readonly configService: ConfigService,
    @Optional() protected readonly betterAuthService?: CoreBetterAuthService,
    @Optional() protected readonly betterAuthUserMapper?: CoreBetterAuthUserMapper,
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
      throw new UnauthorizedException(ErrorCode.INVALID_TOKEN);
    }

    // Check authorization
    const deviceId = this.decodeJwt(tokenOrRefreshToken)?.deviceId;
    if (!deviceId || !user.refreshTokens[deviceId]) {
      throw new UnauthorizedException(ErrorCode.INVALID_TOKEN);
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
   *
   * When IAM is enabled, this method:
   * 1. For migrated users (have iamId): Verifies password via IAM
   * 2. For non-migrated users: Verifies via Legacy, then migrates to IAM
   *
   * Always returns Legacy JWT format for backwards compatibility.
   *
   * @deprecated When IAM is enabled, prefer using /iam/sign-in/email REST endpoint directly.
   */
  async signIn(input: CoreAuthSignInInput, serviceOptions?: ServiceOptions): Promise<CoreAuthModel> {
    // Check input
    if (!input) {
      throw new BadRequestException('Missing input');
    }

    // Check if user enumeration prevention is enabled
    const preventUserEnumeration = this.configService.getFastButReadOnly('auth.preventUserEnumeration', false);

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
    let user: ICoreAuthUser;
    try {
      user = await this.userService.getViaEmail(email, serviceOptionsForUserService);
    } catch (error) {
      if (error instanceof NotFoundException) {
        throw new UnauthorizedException(preventUserEnumeration ? 'Invalid credentials' : 'Unknown email');
      }
      throw error;
    }
    if (!user) {
      throw new UnauthorizedException(preventUserEnumeration ? 'Invalid credentials' : 'Unknown email');
    }

    // Determine if IAM delegation is available
    const iamEnabled = this.isIamEnabled();

    if (iamEnabled && user.iamId) {
      // User is already migrated to IAM - verify via IAM
      const iamVerified = await this.verifyPasswordViaIam(email, password);
      if (!iamVerified) {
        throw new UnauthorizedException(preventUserEnumeration ? 'Invalid credentials' : 'Wrong password');
      }
      this.logger.debug(`User ${email} authenticated via IAM (already migrated)`);
    } else {
      // Verify via Legacy (bcrypt)
      // Check if user has a password (social login only users don't have one)
      if (!user.password) {
        throw new UnauthorizedException(
          preventUserEnumeration ? 'Invalid credentials' : 'No password set for this account',
        );
      }
      if (
        !((await bcrypt.compare(password, user.password)) || (await bcrypt.compare(sha256(password), user.password)))
      ) {
        throw new UnauthorizedException(preventUserEnumeration ? 'Invalid credentials' : 'Wrong password');
      }

      // If IAM is enabled but user not migrated, migrate them now
      if (iamEnabled && !user.iamId) {
        await this.migrateUserToIam(user, email, password);
      }
    }

    // Return tokens and user with currentUser set so securityCheck knows user is requesting own data
    return this.getResult(user, {
      data: { deviceDescription, deviceId },
      serviceOptions: { ...serviceOptions, currentUser: user },
    });
  }

  /**
   * Register a new user account
   *
   * When IAM is enabled, this method:
   * 1. Creates the user in IAM first (with scrypt password hash)
   * 2. Creates/links the Legacy user with iamId
   * 3. Returns Legacy JWT format for backwards compatibility
   *
   * @deprecated When IAM is enabled, prefer using /iam/sign-up/email REST endpoint directly.
   */
  async signUp(input: CoreAuthSignUpInput, serviceOptions?: ServiceOptions): Promise<CoreAuthModel> {
    // Prepare service options
    const serviceOptionsForUserService = prepareServiceOptions(serviceOptions, {
      // Select user field for automatic populate handling via user service
      subFieldSelection: 'user',
    });

    // Get and check user
    try {
      // Determine if IAM delegation is available
      const iamEnabled = this.isIamEnabled();

      let user: ICoreAuthUser;

      if (iamEnabled) {
        // Create via IAM first, then create/link Legacy user
        user = await this.createUserViaIam(input, serviceOptionsForUserService);
      } else {
        // Create via Legacy
        user = await this.userService.create(input, serviceOptionsForUserService);
      }

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
        throw new UnauthorizedException(ErrorCode.INVALID_TOKEN);
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
      throw new UnauthorizedException(ErrorCode.INVALID_TOKEN);
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

  // ===================================================================================================================
  // IAM Delegation Helper Methods
  // ===================================================================================================================

  /**
   * Checks if IAM (Better-Auth) delegation is available and enabled
   */
  protected isIamEnabled(): boolean {
    return !!(this.betterAuthService?.isEnabled() && this.betterAuthUserMapper);
  }

  /**
   * Verifies password via IAM for already-migrated users
   *
   * @param email - User email
   * @param password - Plain password to verify
   * @returns true if password is valid, false otherwise
   */
  protected async verifyPasswordViaIam(email: string, password: string): Promise<boolean> {
    if (!this.betterAuthService) {
      return false;
    }

    const api = this.betterAuthService.getApi();
    if (!api) {
      return false;
    }

    try {
      const response = await api.signInEmail({
        body: { email, password },
      });

      // Check if response indicates successful authentication
      return !!(response && 'user' in response && response.user);
    } catch (error) {
      this.logger.debug(
        `IAM password verification failed for ${email}: ${error instanceof Error ? error.message : 'Unknown error'}`,
      );
      return false;
    }
  }

  /**
   * Migrates a Legacy user to IAM
   *
   * This creates the IAM user and account with a scrypt password hash,
   * then links the Legacy user via iamId.
   *
   * @param user - The Legacy user to migrate
   * @param email - User email
   * @param plainPassword - Plain password (needed to create scrypt hash)
   */
  protected async migrateUserToIam(user: ICoreAuthUser, email: string, plainPassword: string): Promise<void> {
    if (!this.betterAuthUserMapper) {
      return;
    }

    try {
      // Create IAM account with the plain password (creates scrypt hash)
      const migrated = await this.betterAuthUserMapper.migrateAccountToIam(email, plainPassword);

      if (migrated) {
        this.logger.log(`Migrated Legacy user ${email} to IAM`);

        // Refresh user to get updated iamId
        const updatedUser = await this.userService.getViaEmail(email, { force: true });
        if (updatedUser?.iamId) {
          // Update the user object in place so subsequent operations see the iamId
          (user as any).iamId = updatedUser.iamId;
        }
      }
    } catch (error) {
      // Log but don't throw - migration failure shouldn't block login
      this.logger.warn(
        `Failed to migrate user ${email} to IAM: ${error instanceof Error ? error.message : 'Unknown error'}`,
      );
    }
  }

  /**
   * Creates a user via IAM and links to Legacy user
   *
   * @param input - Sign-up input data
   * @param serviceOptions - Service options for user service
   * @returns The created Legacy user (linked to IAM)
   */
  protected async createUserViaIam(input: CoreAuthSignUpInput, serviceOptions: ServiceOptions): Promise<ICoreAuthUser> {
    if (!this.betterAuthService || !this.betterAuthUserMapper) {
      throw new BadRequestException('IAM service not available');
    }

    const api = this.betterAuthService.getApi();
    if (!api) {
      throw new BadRequestException('IAM API not available');
    }

    try {
      // Create user in IAM first
      // Note: firstName and lastName are project-specific fields, may not exist on CoreAuthSignUpInput
      const inputAny = input as any;
      const name = [inputAny.firstName, inputAny.lastName].filter(Boolean).join(' ') || input.email.split('@')[0];
      const response = await api.signUpEmail({
        body: {
          email: input.email,
          name,
          password: input.password,
        },
      });

      if (!response || !('user' in response) || !response.user) {
        throw new BadRequestException('Email address already in use');
      }

      // Link or create Legacy user with iamId
      const iamUser = response.user as { email: string; id: string; name?: string };
      const syncedUser = await this.betterAuthUserMapper.linkOrCreateUser(iamUser as any, {
        firstName: inputAny.firstName,
        lastName: inputAny.lastName,
      });

      if (!syncedUser) {
        throw new BadRequestException('Failed to create user');
      }

      // Sync password to Legacy (enables backwards compatibility)
      // Pass plain password so bcrypt hash can be created for Legacy Auth
      await this.betterAuthUserMapper.syncPasswordToLegacy(iamUser.id, input.email, input.password);

      this.logger.log(`Created user ${input.email} via IAM`);

      // Get the full user from our database
      const user = await this.userService.getViaEmail(input.email, serviceOptions);
      if (!user) {
        throw new BadRequestException('Failed to retrieve created user');
      }

      return user;
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : 'Unknown error';
      this.logger.debug(`IAM sign-up error for ${input.email}: ${errorMessage}`);

      if (errorMessage.includes('already exists') || errorMessage.includes('already in use')) {
        throw new BadRequestException('Email address already in use');
      }
      throw error;
    }
  }
}
