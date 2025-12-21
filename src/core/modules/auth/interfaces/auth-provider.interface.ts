import { JwtPayload } from './jwt-payload.interface';

/**
 * Auth Provider Interface
 *
 * This interface defines the contract for authentication providers.
 * Both Legacy Auth (CoreAuthService) and BetterAuth can implement this interface,
 * allowing CoreModule to work with either system transparently.
 *
 * @since 11.8.0
 * @see https://github.com/lenneTech/nest-server/blob/develop/src/core/modules/auth/interfaces/auth-provider.interface.ts
 *
 * ## Roadmap
 *
 * ### v11.x (Current)
 * - Interface introduced for future flexibility
 * - Legacy Auth (CoreAuthService) is the default implementation
 * - BetterAuth can be used alongside Legacy Auth
 *
 * ### Future Version (Planned)
 * - CoreModule.forRoot will use IAuthProvider instead of concrete AuthService
 * - Legacy Auth becomes optional (must be explicitly enabled)
 * - BetterAuth becomes the recommended default
 *
 * ## Implementation Example
 *
 * ```typescript
 * @Injectable()
 * export class BetterAuthProvider implements IAuthProvider {
 *   constructor(private readonly betterAuthService: BetterAuthService) {}
 *
 *   decodeJwt(token: string): JwtPayload {
 *     return this.betterAuthService.decodeJwt(token);
 *   }
 *
 *   async validateUser(payload: JwtPayload): Promise<any> {
 *     return this.betterAuthService.validateUser(payload);
 *   }
 *
 *   signToken(user: any, expiresIn?: string): string {
 *     return this.betterAuthService.signToken(user, expiresIn);
 *   }
 * }
 * ```
 */
export interface IAuthProvider {
  /**
   * Decode a JWT token without verification
   * Used for extracting payload information
   *
   * @param token - The JWT token to decode
   * @returns The decoded JWT payload
   */
  decodeJwt(token: string): JwtPayload;

  /**
   * Sign a new JWT token for a user
   *
   * @param user - The user to create a token for
   * @param expiresIn - Optional expiration time (e.g., '15m', '7d')
   * @returns The signed JWT token
   */
  signToken(user: any, expiresIn?: string): string;

  /**
   * Validate a user based on JWT payload
   * Called during authentication to verify the user exists and is valid
   *
   * @param payload - The JWT payload containing user information
   * @returns The validated user object, or null if invalid
   */
  validateUser(payload: JwtPayload): Promise<any>;
}

/**
 * Auth Provider Token for dependency injection
 *
 * Use this token to inject the auth provider in your services:
 *
 * ```typescript
 * constructor(
 *   @Inject(AUTH_PROVIDER) private readonly authProvider: IAuthProvider,
 * ) {}
 * ```
 */
export const AUTH_PROVIDER = 'AUTH_PROVIDER';
