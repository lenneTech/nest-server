import type { IBetterAuth } from '../../common/interfaces/server-options.interface.js';

/**
 * Whether e-mail and password sign-in is on: everything but an explicit `emailAndPassword.enabled: false`, the default
 * Better-Auth receives in `better-auth.config.ts`.
 */
export function isEmailAndPasswordSignInEnabled(config: IBetterAuth | undefined): boolean {
  return config?.emailAndPassword?.enabled !== false;
}

/**
 * The sign-in routes the project's own Better-Auth plugins add (`betterAuth.plugins`, `betterAuth.options.plugins`):
 * `/sign-in/username`, `/sign-in/phone-number`, `/sign-in/magic-link`, `/sign-in/email-otp`, … — every endpoint path
 * under `/sign-in/` but the social one.
 */
export function projectSignInRoutes(config: IBetterAuth | undefined): string[] {
  const projectPlugins: unknown = config?.plugins;
  const optionPlugins: unknown = (config?.options as { plugins?: unknown } | undefined)?.plugins;
  const plugins: unknown[] = [
    ...(Array.isArray(projectPlugins) ? projectPlugins : []),
    ...(Array.isArray(optionPlugins) ? optionPlugins : []),
  ];
  const routes: string[] = [];
  for (const plugin of plugins) {
    const endpoints = (plugin as { endpoints?: Record<string, { path?: unknown }> } | null)?.endpoints;
    for (const endpoint of Object.values(endpoints ?? {})) {
      const path = endpoint?.path;
      if (typeof path === 'string' && path.startsWith('/sign-in/') && !path.startsWith('/sign-in/social')) {
        routes.push(path);
      }
    }
  }
  return routes;
}

/**
 * Whether sign-in runs through a single sign-on provider alone (12.11.0): e-mail and password sign-in is off AND no
 * plugin of the project adds a sign-in route of its own. A project with `emailAndPassword.enabled: false` that signs
 * in by username and password (`username()`) or by phone number is NOT one: there the two-factor plugin is what
 * enforces the second factor on `/sign-in/username` and `/sign-in/phone-number`.
 */
export function isProviderOnlySignIn(config: IBetterAuth | undefined): boolean {
  return !isEmailAndPasswordSignInEnabled(config) && projectSignInRoutes(config).length === 0;
}

/**
 * Whether a sign-in factor (Passkey, two-factor) is on, given its own switch (12.11.0).
 *
 * `false` or `{ enabled: false }` switches it off, as always. While the project signs in with a method of its own (e-mail
 * and password, or a plugin's sign-in route), every other value switches it on (unset included), as before 12.11.0.
 *
 * When sign-in runs through a provider alone ({@link isProviderOnlySignIn}) it is on only when switched on EXPLICITLY:
 * `true` or `{ enabled: true, … }`. Until 12.11.0 Passkey and two-factor stayed on there: whoever registered a passkey
 * after a Microsoft sign-in kept signing in with it after Entra withdrew the assignment, so the provider no longer
 * decided who gets in. An object without `enabled: true` (a `twoFactor: { appName }` kept from a password setup) does
 * not count as that decision.
 */
export function isSignInFactorEnabled(value: unknown, config: IBetterAuth | undefined): boolean {
  if (value === false) {
    return false;
  }
  const settings = typeof value === 'object' && value !== null ? (value as { enabled?: unknown }) : undefined;
  if (settings?.enabled === false) {
    return false;
  }
  if (!isProviderOnlySignIn(config)) {
    return true;
  }
  return value === true || settings?.enabled === true;
}

/** Whether the Passkey plugin is configured on (URL resolution can still turn it off, see `normalizePasskeyConfig`). */
export function isPasskeyConfigured(config: IBetterAuth | undefined): boolean {
  return isSignInFactorEnabled(config?.passkey, config);
}

/** Whether the two-factor plugin is configured on. */
export function isTwoFactorConfigured(config: IBetterAuth | undefined): boolean {
  return isSignInFactorEnabled(config?.twoFactor, config);
}

/**
 * The sign-in factors that are off only because sign-in runs through a provider alone — named once at boot, so a
 * project that relied on them sees why they are gone and how to switch them on again. `configured` marks a factor that
 * carried settings of its own (an object), which deserves a warning rather than a notice.
 */
export function signInFactorsOffWithoutPassword(
  config: IBetterAuth | undefined,
): { configured: boolean; name: 'passkey' | 'twoFactor' }[] {
  if (!isProviderOnlySignIn(config)) {
    return [];
  }
  const off: { configured: boolean; name: 'passkey' | 'twoFactor' }[] = [];
  for (const [name, value] of [
    ['passkey', config?.passkey],
    ['twoFactor', config?.twoFactor],
  ] as const) {
    const settings = typeof value === 'object' && value !== null ? (value as { enabled?: unknown }) : undefined;
    const explicitlyOff = value === false || settings?.enabled === false;
    if (!explicitlyOff && !isSignInFactorEnabled(value, config)) {
      off.push({ configured: !!settings, name });
    }
  }
  return off;
}
