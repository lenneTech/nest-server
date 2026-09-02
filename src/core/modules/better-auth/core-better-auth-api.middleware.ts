import { BadRequestException, Injectable, Logger, NestMiddleware, Optional } from '@nestjs/common';
import { Response as ExpressResponse, NextFunction, Request } from 'express';

import { isProduction } from '../../common/helpers/logging.helper';
import { ConfigService } from '../../common/services/config.service';
import { CoreBetterAuthChallengeService } from './core-better-auth-challenge.service';
import { BetterAuthCookieHelper, createCookieHelper } from './core-better-auth-cookie.helper';
import { wrapBetterAuthErrorResponse } from './core-better-auth-error-codes.helper';
import { runWithResetPassword } from './core-better-auth-password-reset.registry';
import { CoreBetterAuthUserMapper } from './core-better-auth-user.mapper';
import { extractSessionToken, sendWebResponse, signCookieValue, toWebRequest } from './core-better-auth-web.helper';
import { CoreBetterAuthService } from './core-better-auth.service';

/**
 * List of paths that are handled by CoreBetterAuthController
 * These should NOT be forwarded to Better Auth's native handler
 *
 * Only paths with nest-server-specific logic belong here:
 * - sign-in/email: Legacy user migration, password normalization
 * - sign-up/email: User linking to own DB, password sync
 * - sign-out: Custom cookie clearing
 * - session: Custom response format with mapped user
 *
 * All other paths (Passkey, 2FA, etc.) go directly to Better Auth's
 * native handler via this middleware for maximum compatibility.
 */
const CONTROLLER_HANDLED_PATHS = ['/features', '/sign-in/email', '/sign-up/email', '/sign-out', '/session'];

/**
 * Native Better-Auth routes that set a NEW password from a token or OTP, with the body
 * field each of them carries it in.
 *
 * These are forwarded (they are not in CONTROLLER_HANDLED_PATHS), so unlike sign-in and
 * sign-up nothing normalizes their password — Better-Auth hashes whatever arrives. That
 * is a problem, because the sign-in path DOES normalize: a plaintext reset would be
 * stored as `scrypt(plaintext)` while every later sign-in checks `scrypt(sha256(...))`,
 * and the account is locked out with the password its owner just chose. Normalizing
 * here puts every write of a credential on the same footing as every read of one.
 *
 * Matching is EXACT (after trimming a trailing slash and lower-casing), not prefix-based. So
 * `/reset-password/:token` — Better-Auth's GET redirect — never matches an entry at all and is
 * forwarded untouched. That is the intended outcome, but for this reason and not because "the
 * body has no password field": switching the matcher to `startsWith` would start rewriting that
 * redirect's body on the strength of a comment that was never true.
 */
export const PASSWORD_RESET_PATHS: { field: string; path: string }[] = [
  { field: 'newPassword', path: '/reset-password' },
  { field: 'password', path: '/email-otp/reset-password' },
  { field: 'newPassword', path: '/phone-number/reset-password' },
];

/**
 * Passkey paths that generate challenges
 */
const PASSKEY_GENERATE_PATHS = ['/passkey/generate-register-options', '/passkey/generate-authenticate-options'];

/**
 * Passkey paths that verify challenges
 */
const PASSKEY_VERIFY_PATHS = ['/passkey/verify-registration', '/passkey/verify-authentication'];

/**
 * Middleware that forwards Better Auth API requests to the native Better Auth handler.
 *
 * This middleware handles ALL Better Auth plugin functionality directly:
 * - Passkey/WebAuthn (registration, authentication, management)
 * - Two-Factor Authentication (TOTP enable, disable, verify)
 * - Social Login OAuth flows
 * - Magic link authentication
 * - Email verification
 *
 * For JWT mode (cookieless), this middleware provides an adapter for Passkey challenges:
 * 1. On generate: Extracts Better Auth's verificationToken from Set-Cookie and stores mapping
 * 2. On verify: Injects verificationToken as cookie so Better Auth can find the challenge
 *
 * This approach maintains full compatibility with Better Auth's internal mechanisms.
 */
@Injectable()
export class CoreBetterAuthApiMiddleware implements NestMiddleware {
  private readonly logger = new Logger(CoreBetterAuthApiMiddleware.name);
  private readonly isProd = isProduction();
  private loggedChallengeStorageMode = false;
  private cookieHelper?: BetterAuthCookieHelper;

  constructor(
    private readonly betterAuthService: CoreBetterAuthService,
    @Optional() private readonly challengeService?: CoreBetterAuthChallengeService,
    @Optional() private readonly userMapper?: CoreBetterAuthUserMapper,
  ) {}

  /**
   * Brings a native reset route's password to the same shape sign-in will present, and
   * returns that value so the legacy mirror can reuse it.
   *
   * Returns `undefined` when this is not a password-setting route or the body carries no
   * password — both mean "leave the request untouched".
   *
   * @throws BadRequestException when a plaintext password violates the configured length policy
   */
  protected normalizeResetPassword(req: Request, relativePath: string): string | undefined {
    // Trailing slashes and case are normalized before matching. Express does not collapse a
    // trailing slash on `originalUrl`, and Better-Auth's own router is more permissive than
    // `===` — so a variant it accepts but this table does not would silently skip BOTH the
    // normalization and the legacy mirror, i.e. reproduce the exact lockout this method exists
    // to prevent, through a URL shape rather than a code change.
    const normalizedPath = relativePath.replace(/\/+$/, '').toLowerCase();
    const route = PASSWORD_RESET_PATHS.find((entry) => normalizedPath === entry.path);
    if (!route) {
      return undefined;
    }

    if (!this.userMapper) {
      // Fail LOUD rather than open. Today every module variant that provides this middleware
      // also provides the mapper, so this is unreachable — but silently forwarding an
      // un-normalized password stores `scrypt(plaintext)` against a sign-in that checks
      // `scrypt(sha256(...))`, and the user is locked out with the password they just chose.
      // A guard on a correctness-critical step must not degrade quietly.
      this.logger.error(
        `No CoreBetterAuthUserMapper available — the password on ${relativePath} is NOT normalized. ` +
          'Better-Auth will store scrypt(plaintext) while sign-in checks scrypt(sha256(...)), ' +
          'locking the account out with its new password.',
      );
      return undefined;
    }

    const submitted = req.body?.[route.field];
    if (!submitted || typeof submitted !== 'string') {
      return undefined;
    }

    this.assertResetPasswordLength(submitted);

    const normalized = this.userMapper.normalizePasswordForIam(submitted);
    // `toWebRequest` serializes `req.body`, so writing it back here is what Better-Auth
    // actually hashes.
    req.body[route.field] = normalized;
    return normalized;
  }

  /**
   * Enforces the configured password length on the value the CLIENT actually sent.
   *
   * Better-Auth checks `minPasswordLength`/`maxPasswordLength` against the body it receives —
   * and by then this middleware has replaced it with a 64-character sha256, so both bounds
   * always pass. Without this check there would be no server-side minimum password length on
   * any reset path at all.
   *
   * An already-hashed value carries no length information, so it cannot be checked here. That
   * limit is real and belongs in the client; it is stated in the migration guide rather than
   * pretended away.
   */
  protected assertResetPasswordLength(submitted: string): void {
    if (/^[a-f0-9]{64}$/i.test(submitted)) {
      return;
    }

    // The bounds live on the Better-Auth passthrough (`betterAuth.options.emailAndPassword`),
    // not on the framework's own typed block — so they are read defensively. The fallbacks are
    // Better-Auth's own defaults, which is what applied before this check existed.
    const passthrough = (this.betterAuthService.getConfig()?.options as Record<string, any> | undefined)
      ?.emailAndPassword;
    const min = typeof passthrough?.minPasswordLength === 'number' ? passthrough.minPasswordLength : 8;
    const max = typeof passthrough?.maxPasswordLength === 'number' ? passthrough.maxPasswordLength : 128;

    if (submitted.length < min || submitted.length > max) {
      throw new BadRequestException(`Password must be between ${min} and ${max} characters`);
    }
  }

  /**
   * Gets or creates the cookie helper instance.
   * Lazy initialization because betterAuthService may not be fully initialized in constructor.
   *
   * Note: Legacy cookie is not enabled in middleware. The middleware only needs to set
   * the native Better-Auth cookie. Secret is required for cookie signing (Passkey/2FA).
   * `env` is read via the frozen ConfigService snapshot so the `secure` flag covers staging.
   */
  private getCookieHelper(): BetterAuthCookieHelper {
    if (!this.cookieHelper) {
      const config = this.betterAuthService.getConfig();
      const env = ConfigService.configFastButReadOnly?.env as string | undefined;
      this.cookieHelper = createCookieHelper(
        this.betterAuthService.getBasePath(),
        {
          domain: this.betterAuthService.getCookieDomain(),
          env,
          legacyCookieEnabled: false, // Middleware doesn't need legacy cookie
          secret: config?.secret, // Required for cookie signing
        },
        this.logger,
      );
    }
    return this.cookieHelper;
  }

  /**
   * Check if database challenge storage should be used.
   * This is checked dynamically because the ChallengeService initializes in onModuleInit.
   */
  private useDbChallengeStorage(): boolean {
    const enabled = this.challengeService?.isEnabled() ?? false;
    if (enabled && !this.loggedChallengeStorageMode) {
      this.logger.log('Passkey challenge storage: database (JWT mode compatible)');
      this.loggedChallengeStorageMode = true;
    }
    return enabled;
  }

  async use(req: Request, res: ExpressResponse, next: NextFunction) {
    // Skip if Better-Auth is not enabled
    if (!this.betterAuthService.isEnabled()) {
      return next();
    }

    const basePath = this.betterAuthService.getBasePath();
    // Use originalUrl to get full path for IAM endpoints, but fallback to req.path
    // The originalUrl contains the original request path as sent by client
    const requestPath = req.originalUrl?.split('?')[0] || req.path;

    // Only handle requests that start with the Better Auth base path
    if (!requestPath.startsWith(basePath)) {
      return next();
    }

    this.logger.debug(`API Middleware handling: ${req.method} ${requestPath}`);

    // Get the path relative to the base path
    const relativePath = requestPath.slice(basePath.length);

    // Skip paths that are handled by CoreBetterAuthController (nest-server-specific logic)
    if (CONTROLLER_HANDLED_PATHS.some((path) => relativePath === path || relativePath.startsWith(`${path}/`))) {
      return next();
    }

    // Get the Better Auth instance
    const authInstance = this.betterAuthService.getInstance();
    if (!authInstance) {
      this.logger.warn('Better Auth instance not available');
      return next();
    }

    this.logger.debug(`Forwarding to Better Auth handler: ${req.method} ${requestPath}`);

    try {
      // Check if this is a passkey request that needs DB challenge handling
      const useDbStorage = this.useDbChallengeStorage();
      const isPasskeyGenerate = useDbStorage && PASSKEY_GENERATE_PATHS.some((p) => relativePath === p);
      const isPasskeyVerify = useDbStorage && PASSKEY_VERIFY_PATHS.some((p) => relativePath === p);

      // Extract session token from cookies or Authorization header.
      // In JWT mode, extractSessionToken correctly returns null for JWTs.
      // Fall back to the session resolved by CoreBetterAuthMiddleware (which
      // resolves JWTs to DB sessions via getActiveSessionForUser).
      let sessionToken = extractSessionToken(req, basePath);
      if (!sessionToken) {
        const betterAuthReq = req as any;
        if (betterAuthReq.betterAuthSession?.session?.token) {
          sessionToken = betterAuthReq.betterAuthSession.session.token;
        }
      }

      // Get config for cookie signing
      const config = this.betterAuthService.getConfig();
      const cookieName = this.challengeService?.getCookieName() || 'better-auth.better-auth-passkey';

      // For passkey verify requests with DB storage, inject the verificationToken as a cookie
      let challengeIdToDelete: string | undefined;
      if (isPasskeyVerify && this.challengeService) {
        const challengeId = req.body?.challengeId;
        this.logger.debug(
          `Passkey verify: challengeId=${challengeId ? `${challengeId.substring(0, 8)}...` : 'MISSING'}, body keys=${Object.keys(req.body || {}).join(', ')}`,
        );
        if (challengeId) {
          const verificationToken = await this.challengeService.getVerificationToken(challengeId);
          if (verificationToken) {
            // Sign the verificationToken and inject it as a cookie
            const signedToken = signCookieValue(verificationToken, config.secret || '');

            // Add the challenge cookie to the request headers
            const existingCookies = req.headers.cookie || '';
            req.headers.cookie = existingCookies
              ? `${existingCookies}; ${cookieName}=${signedToken}`
              : `${cookieName}=${signedToken}`;

            challengeIdToDelete = challengeId;

            this.logger.debug(`Injected verificationToken for passkey verification`);
          } else {
            // Challenge mapping not found - let Better Auth handle the error
            this.logger.debug(`Challenge mapping not found: ${challengeId.substring(0, 8)}...`);
          }
        }
      }

      // Put a reset password into the shape sign-in expects BEFORE the body is
      // serialized, and keep the value for the legacy mirror below.
      const resetPassword = this.normalizeResetPassword(req, relativePath);

      // Convert Express request to Web Standard Request with proper cookie signing
      const webRequest = await toWebRequest(req, {
        basePath,
        baseUrl: this.betterAuthService.getBaseUrl(),
        logger: this.logger,
        secret: config.secret,
        sessionToken,
      });

      // Call Better Auth's native handler.
      //
      // For a reset, the call is wrapped so that `emailAndPassword.onPasswordReset` — which
      // Better-Auth invokes inside this call, and which is told WHICH user was reset but not
      // to WHAT — can read the new password and mirror it into the legacy store. The context
      // lives exactly as long as the handler call, so no other request can observe it.
      const rawResponse = resetPassword
        ? await runWithResetPassword(resetPassword, () => authInstance.handler(webRequest))
        : await authInstance.handler(webRequest);

      // The single choke point for every error exit below. Each later branch acts only on
      // `response.ok`, so rewriting failures HERE reaches all of them without touching any — and
      // without a second place that has to remember to do it. Successful responses are returned
      // by identity, so nothing on the happy path changes shape.
      const response = await wrapBetterAuthErrorResponse(rawResponse);

      this.logger.debug(`Better Auth handler response: ${response.status}`);

      // For passkey generate requests with DB storage, extract verificationToken and store mapping
      if (isPasskeyGenerate && response.ok && this.challengeService) {
        // Extract verificationToken from Set-Cookie header
        const setCookieHeaders = response.headers.getSetCookie?.() || [];
        let verificationToken: null | string = null;

        for (const cookieHeader of setCookieHeaders) {
          if (cookieHeader.startsWith(`${cookieName}=`)) {
            // Extract the cookie value (before the first semicolon and after the equals sign)
            const cookieValue = cookieHeader.split(';')[0].split('=')[1];
            // URL decode and extract the token part (before the signature dot)
            const decodedValue = decodeURIComponent(cookieValue);
            // The signed cookie format is: value.signature
            verificationToken = decodedValue.split('.')[0];
            break;
          }
        }

        if (verificationToken) {
          // Clone the response to read the body
          const responseClone = response.clone();
          const responseBody = await responseClone.json();

          // Get user ID from response or session
          const userId = responseBody?.user?.id || sessionToken || 'anonymous';
          const type = relativePath.includes('register') ? 'registration' : 'authentication';

          // Store the mapping: challengeId → verificationToken
          const challengeId = await this.challengeService.storeChallengeMapping(
            verificationToken,
            userId,
            type as 'authentication' | 'registration',
          );

          // Add challengeId to the response body
          const enhancedBody = {
            ...responseBody,
            challengeId,
          };

          // Create new headers WITHOUT the Set-Cookie for the passkey challenge
          // (we don't want cookies in JWT mode)
          const newHeaders = new Headers();
          response.headers.forEach((value, key) => {
            if (key.toLowerCase() !== 'set-cookie') {
              newHeaders.set(key, value);
            }
          });
          // Re-add non-passkey Set-Cookie headers
          for (const cookieHeader of setCookieHeaders) {
            if (!cookieHeader.startsWith(`${cookieName}=`)) {
              newHeaders.append('Set-Cookie', cookieHeader);
            }
          }

          // Create a new response with the enhanced body and filtered headers
          const enhancedResponse = new Response(JSON.stringify(enhancedBody), {
            headers: newHeaders,
            status: response.status,
            statusText: response.statusText,
          });

          this.logger.debug(`Stored challenge mapping with ID: ${challengeId.substring(0, 8)}...`);

          // Send the enhanced response
          await sendWebResponse(res, enhancedResponse);

          return;
        } else {
          this.logger.warn('Could not extract verificationToken from Set-Cookie header');
        }
      }

      // Clean up the used challenge mapping only after SUCCESSFUL verification
      // On failure, keep the challenge so the user can retry with a different passkey
      if (challengeIdToDelete && this.challengeService && response.ok) {
        await this.challengeService.deleteChallengeMapping(challengeIdToDelete);
      } else if (challengeIdToDelete && !response.ok) {
        this.logger.debug(`Keeping challenge mapping after failed verification (status=${response.status}) for retry`);
      }

      // For successful passkey verify-authentication:
      // 1. Set session cookie for consistent cookie handling
      // 2. Enrich response with user data (Better Auth's passkey plugin only returns { session })
      if (relativePath === '/passkey/verify-authentication' && response.ok) {
        this.getCookieHelper().setSessionCookiesFromWebResponse(res, response);

        // Better Auth's @better-auth/passkey plugin returns { session } without user data
        // (despite OpenAPI spec declaring both session and user in response).
        // Enrich the response with user data so the frontend can set auth state.
        try {
          const responseClone = response.clone();
          const responseBody = await responseClone.json();

          if (responseBody?.session?.userId && !responseBody.user) {
            const context = await authInstance.$context;
            const user = await context.internalAdapter.findUserById(responseBody.session.userId);

            if (user) {
              const enrichedBody = {
                ...responseBody,
                user: {
                  createdAt: user.createdAt,
                  email: user.email,
                  emailVerified: user.emailVerified,
                  id: user.id,
                  name: user.name,
                },
              };

              // Create enriched response preserving original headers
              const newHeaders = new Headers();
              response.headers.forEach((value, key) => {
                if (key.toLowerCase() !== 'content-encoding' && key.toLowerCase() !== 'transfer-encoding') {
                  newHeaders.set(key, value);
                }
              });
              newHeaders.set('content-type', 'application/json');

              const enrichedResponse = new Response(JSON.stringify(enrichedBody), {
                headers: newHeaders,
                status: response.status,
                statusText: response.statusText,
              });

              this.logger.debug('Enriched passkey verify response with user data');
              await sendWebResponse(res, enrichedResponse);
              return;
            }
          }
        } catch (enrichError) {
          this.logger.debug(
            `Could not enrich passkey response: ${enrichError instanceof Error ? enrichError.message : 'unknown'}`,
          );
          // Fall through to send original response
        }
      }

      // If Better Auth returned 404, the path is not handled by Better Auth.
      // Call next() to let NestJS controllers handle it (e.g., custom controller endpoints).
      if (response.status === 404) {
        return next();
      }

      // Convert Web Standard Response to Express response using shared helper
      await sendWebResponse(res, response);
    } catch (error) {
      // Log error with appropriate detail level
      if (this.isProd) {
        this.logger.error('Better Auth handler error');
      } else {
        this.logger.error(`Better Auth handler error: ${error instanceof Error ? error.message : 'Unknown error'}`);
      }

      // Send error response if headers not sent
      if (!res.headersSent) {
        const message = this.isProd ? 'Authentication error' : error instanceof Error ? error.message : 'Unknown error';
        res.status(500).json({
          error: 'Authentication handler error',
          message,
        });
      }
    }
  }
}
