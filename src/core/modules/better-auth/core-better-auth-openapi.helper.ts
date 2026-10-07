import type { IBetterAuth } from '../../common/interfaces/server-options.interface';

/**
 * What the Swagger document needs to know about the routes under the Better-Auth base path.
 *
 * Two kinds of route live there. The few with nest-server-specific logic are handled by
 * `CoreBetterAuthController` (`CONTROLLER_HANDLED_PATHS`); every other request is forwarded by
 * `CoreBetterAuthApiMiddleware` to Better-Auth's own handler, which serves whatever the configured
 * plugins add (two-factor, passkey, sessions, password change, …). Those forwarded routes have no
 * Nest handler, so `@nestjs/swagger` cannot see them; `setupSwagger()` documents them from Better-Auth's
 * OpenAPI generator instead (see `CoreBetterAuthService.getOpenApiSchema()`).
 *
 * This file imports types only, so the middleware, the plugin builder and the Swagger helper can all
 * read the same rules without importing each other.
 */

/**
 * Paths (relative to the base path) handled by `CoreBetterAuthController` rather than forwarded.
 *
 * Only paths with nest-server-specific logic belong here:
 * - sign-in/email: legacy user migration, password normalization
 * - sign-up/email: user linking to own DB, password sync
 * - sign-out: custom cookie clearing
 * - session: custom response format with mapped user
 * - features: nest-server's own feature report
 */
export const CONTROLLER_HANDLED_PATHS = ['/features', '/sign-in/email', '/sign-up/email', '/sign-out', '/session'];

/**
 * Routes Better-Auth guards with a session check in the HANDLER instead of a session middleware: the
 * social-account routes resolve their caller through `resolveUserId()` (better-auth `api/routes/account`),
 * which refuses an HTTP caller without a session. Every other route without a session middleware is
 * public. Pinned against better-auth's source by tests/unit/better-auth-openapi-availability.spec.ts.
 */
export const HANDLER_SESSION_PATHS = ['/account-info', '/get-access-token', '/refresh-token'];

/**
 * The plugins `buildPlugins()` registers itself. Their routes — like Better-Auth's core routes — are
 * classified by the session middleware they carry. Any other plugin's routes keep the global security
 * requirement: such a plugin may check the session in a middleware of its own (`admin()` does), which
 * nothing outside it can recognise, and a session route documented as public sends clients without one.
 */
export const BUILT_IN_BETTER_AUTH_PLUGIN_IDS = ['jwt', 'lt-ws-session-revocation', 'open-api', 'passkey', 'two-factor'];

/** Better-Auth's `:param` route syntax as OpenAPI's `{param}`, which its generator writes. */
export function toOpenApiPath(path: string): string {
  return path.replace(/:([^/]+)/g, '{$1}');
}

/** Base of the routes Better-Auth's `openAPI()` plugin adds (`/open-api/generate-schema`). */
export const BETTER_AUTH_OPEN_API_PATH = '/open-api';

/** Id of Better-Auth's `openAPI()` plugin */
export const BETTER_AUTH_OPEN_API_PLUGIN_ID = 'open-api';

/**
 * Minimal shape of the document Better-Auth's OpenAPI generator returns (OpenAPI 3.1, paths relative to
 * the base path).
 */
export interface IBetterAuthOpenApiDocument {
  components?: { schemas?: Record<string, unknown> };
  paths: Record<string, Record<string, unknown>>;
}

/** Whether a path relative to the base path is handled by `CoreBetterAuthController`. */
export function isControllerHandledPath(relativePath: string): boolean {
  return CONTROLLER_HANDLED_PATHS.some((path) => relativePath === path || relativePath.startsWith(`${path}/`));
}

/** Whether a path relative to the base path belongs to Better-Auth's `openAPI()` plugin. */
export function isBetterAuthOpenApiPath(relativePath: string): boolean {
  return relativePath === BETTER_AUTH_OPEN_API_PATH || relativePath.startsWith(`${BETTER_AUTH_OPEN_API_PATH}/`);
}

/**
 * Whether the project registered `openAPI()` itself in `betterAuth.plugins`. Then its routes are the
 * project's decision and stay reachable; otherwise nest-server registers the plugin only to feed the
 * Swagger document, with its endpoints kept off the router (`serverOnlyPlugin()` in better-auth.config.ts).
 */
export function projectProvidesOpenApiPlugin(config: IBetterAuth | null | undefined): boolean {
  return !!config?.plugins?.some(
    (plugin) => (plugin as { id?: unknown } | null)?.id === BETTER_AUTH_OPEN_API_PLUGIN_ID,
  );
}

/**
 * The parts of a running Better-Auth instance (`await auth.$context`) that decide whether a route it
 * serves can succeed. Typed loosely on purpose: these are Better-Auth's resolved options, including
 * whatever a project passed through `betterAuth.options` or added as a plugin.
 */
export interface IBetterAuthRuntime {
  options?: {
    account?: { accountLinking?: { allowUnlinkingAll?: boolean } };
    emailAndPassword?: { disableSignUp?: boolean; enabled?: boolean; sendResetPassword?: unknown };
    emailVerification?: { sendVerificationEmail?: unknown };
    plugins?: {
      id?: string;
      options?: Record<string, any>;
      schema?: { session?: { fields?: Record<string, { input?: boolean }> } };
    }[];
    session?: { additionalFields?: Record<string, { input?: boolean }>; deferSessionRefresh?: boolean };
    user?: { changeEmail?: { enabled?: boolean }; deleteUser?: { enabled?: boolean } };
  };
  socialProviders?: unknown[];
}

/**
 * Operations Better-Auth serves but answers with an error for EVERY caller under the running
 * configuration. Better-Auth's OpenAPI generator lists each registered endpoint regardless of the options
 * it checks at request time, so `CoreBetterAuthService` removes these from the description it hands to
 * `setupSwagger()`. Keys: `/path` (every method) or `<method> /path`.
 *
 * Each row mirrors a check in better-auth's own source (1.7.7, `dist/…`), pinned by
 * `tests/unit/better-auth-openapi-availability.spec.ts`:
 *
 * | Unavailable | Unless | Better-Auth answers |
 * |---|---|---|
 * | `post /get-session` | `session.deferSessionRefresh` | 405 `METHOD_NOT_ALLOWED_DEFER_SESSION_REQUIRED` (api/routes/session.mjs) |
 * | update-session | a session field accepts input (`session.additionalFields` or a plugin's session schema) | "No fields to update" (update-session.mjs) |
 * | social sign-in, callback, link, provider tokens | a social provider is configured | `PROVIDER_NOT_FOUND` / "Provider … is not supported" (sign-in, callback, account.mjs) |
 * | unlink-account | a social provider, or `account.accountLinking.allowUnlinkingAll` | `FAILED_TO_UNLINK_LAST_ACCOUNT` — without a provider a user has one account (account.mjs) |
 * | send-verification-email, verify-email | `emailVerification.sendVerificationEmail` | "Verification email isn't enabled" (email-verification.mjs) |
 * | request + reset password | `emailAndPassword.sendResetPassword` | `RESET_PASSWORD_DISABLED` (password.mjs) |
 * | sign-in + sign-up with email | `emailAndPassword.enabled` | `EMAIL_PASSWORD_DISABLED` (sign-in.mjs, sign-up.mjs). Not change/verify password: Better-Auth does not check `enabled` there |
 * | `/sign-up/email` | not `emailAndPassword.disableSignUp` | "Email and password sign up is not enabled" (sign-up.mjs) |
 * | delete-user (+ callback) | `user.deleteUser.enabled` | error (update-user.mjs) |
 * | change-email | `user.changeEmail.enabled` | `CHANGE_EMAIL_DISABLED` (update-user.mjs) |
 * | two-factor OTP send/verify | the two-factor plugin's `otpOptions.sendOTP` | `OTP_NOT_CONFIGURED` (plugins/two-factor) |
 * | two-factor TOTP uri/verify | not the two-factor plugin's `totpOptions.disable` | `TOTP_NOT_CONFIGURED` (plugins/two-factor) |
 *
 * Add a row when an upgrade of better-auth introduces a new option-dependent refusal.
 */
export function unavailableBetterAuthOperations(runtime: IBetterAuthRuntime | null | undefined): Set<string> {
  const options = runtime?.options ?? {};
  const unavailable = new Set<string>();
  const add = (...keys: string[]) => keys.forEach((key) => unavailable.add(key));

  if (!options.session?.deferSessionRefresh) {
    add('post /get-session');
  }
  const acceptsInput = (fields: Record<string, { input?: boolean }> | undefined) =>
    Object.values(fields ?? {}).some((field) => field?.input !== false);
  if (
    !acceptsInput(options.session?.additionalFields) &&
    !options.plugins?.some((plugin) => acceptsInput(plugin?.schema?.session?.fields))
  ) {
    add('/update-session');
  }
  if (!runtime?.socialProviders?.length) {
    add('/sign-in/social', '/callback/{id}', '/link-social', '/refresh-token', '/get-access-token', '/account-info');
    if (!options.account?.accountLinking?.allowUnlinkingAll) {
      add('/unlink-account');
    }
  }
  if (!options.emailVerification?.sendVerificationEmail) {
    add('/send-verification-email', '/verify-email');
  }
  if (!options.emailAndPassword?.sendResetPassword) {
    add('/request-password-reset', '/reset-password', '/reset-password/{token}');
  }
  if (!options.emailAndPassword?.enabled) {
    add('/sign-in/email', '/sign-up/email');
  }
  if (options.emailAndPassword?.disableSignUp) {
    add('/sign-up/email');
  }
  if (!options.user?.deleteUser?.enabled) {
    add('/delete-user', '/delete-user/callback');
  }
  if (!options.user?.changeEmail?.enabled) {
    add('/change-email');
  }
  const twoFactor = options.plugins?.find((plugin) => plugin?.id === 'two-factor');
  if (twoFactor) {
    if (!twoFactor.options?.otpOptions?.sendOTP) {
      add('/two-factor/send-otp', '/two-factor/verify-otp');
    }
    if (twoFactor.options?.totpOptions?.disable) {
      add('/two-factor/get-totp-uri', '/two-factor/verify-totp');
    }
  }
  return unavailable;
}

/** Whether an operation is listed by `unavailableBetterAuthOperations()` (or `switchedOffBetterAuthPaths()`). */
export function isUnavailableOperation(unavailable: Set<string>, method: string, relativePath: string): boolean {
  return unavailable.has(relativePath) || unavailable.has(`${method.toLowerCase()} ${relativePath}`);
}

/**
 * Paths (relative to the base path) the configuration switches off for every caller. Documented, they
 * could only ever answer an error, so the Swagger document leaves them out — explicit controller routes
 * and generated ones alike. Each rule mirrors the switch it reads:
 *
 * | Configuration | Paths | Why they cannot succeed |
 * |---|---|---|
 * | `emailAndPassword.enabled: false` | sign-in + sign-up with email | `EMAIL_PASSWORD_DISABLED` (the only routes Better-Auth checks it on) |
 * | `emailAndPassword.disableSignUp: true` | `/sign-up/email` | `SIGNUP_DISABLED` (`isSignUpEnabled()`) |
 * | `emailAndPassword.passwordReset: false` | request + reset | no reset hook, so no token can be minted |
 */
export function switchedOffBetterAuthPaths(config: IBetterAuth | null | undefined): Set<string> {
  const emailAndPassword = config?.emailAndPassword;
  const paths = new Set<string>();
  if (emailAndPassword?.enabled === false) {
    // Better-Auth checks `enabled` in sign-in and sign-up only; password change/verify/reset keep
    // working for accounts that have a password.
    paths.add('/sign-in/email');
    paths.add('/sign-up/email');
  }
  if (emailAndPassword?.disableSignUp === true) {
    paths.add('/sign-up/email');
  }
  if (emailAndPassword?.passwordReset === false) {
    for (const path of ['/request-password-reset', '/reset-password', '/reset-password/{token}']) {
      paths.add(path);
    }
  }
  return paths;
}
