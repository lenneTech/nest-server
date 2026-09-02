import * as dotenv from 'dotenv';
import _ = require('lodash');
import * as process from 'node:process';
import { join } from 'path';

/**
 * Helper class for configurations
 * @deprecated use functions directly
 */
export default class Config {
  /**
   * Special merge function (e.g. for configurations)
   *
   * It acts like the merge function of lodash:
   * - Source objects are merged into the destination object
   * - Source objects are applied from left to right
   * - Subsequent sources overwrite property assignments of previous sources
   *
   * except that arrays are not merged but overwrite arrays of previous sources.
   *
   * @param {any} obj destination object
   * @param {any[]} sources source objects
   * @returns {any}
   */
  public static merge(obj: Record<string, any>, ...sources: any[]): any {
    return merge(obj, sources);
  }
}

/**
 * Get environment configuration (deeply merged into config object set via options)
 *
 * The configuration is extended via deep merge in the following order:
 * 1. config[env] (if set)
 * 2.
 *
 * @param options options for processing
 * @param options.config config object with different environments as main keys (see config.env.ts) to merge environment configurations into (default: {})
 * @param options.defaultEnv default environment to use if no NODE_ENV is set (default: 'local')
 * @param options.envPath path to .env file (default: undefined => default of dotenv)
 */
export function getEnvironmentConfig(options: { config?: Record<string, any>; defaultEnv?: string; envPath?: string }) {
  const { config, defaultEnv, envPath } = {
    config: {},
    defaultEnv: 'local',
    ...options,
  };

  // `quiet: true` silences dotenv's startup banner ("◇ injected env (N) from .env // tip: …"),
  // which is purely cosmetic and carries promotional content. Warnings (`⚠`) for genuine
  // misconfiguration still surface.
  if (envPath) {
    dotenv.config({ path: envPath, quiet: true });
  } else {
    dotenv.config({ quiet: true });
  }

  const env = process.env['NODE_ENV'] || defaultEnv;
  const envConfig = config[env] || config.local || {};

  // Merge with localConfig (e.g. config.json)
  if (envConfig.loadLocalConfig) {
    let localConfig: Record<string, any>;
    if (typeof envConfig.loadLocalConfig === 'string') {
      import(envConfig.loadLocalConfig)
        .then((loadedConfig) => {
          localConfig = loadedConfig.default || loadedConfig;
          merge(envConfig, localConfig);
        })
        .catch(() => {
          console.info(`Configuration ${envConfig.loadLocalConfig} not found!`);
        });
    } else {
      // get config from src directory
      import(join(__dirname, 'config.json'))
        .then((loadedConfig) => {
          localConfig = loadedConfig.default || loadedConfig;
          merge(envConfig, localConfig);
        })
        .catch(() => {
          // if not found try to find in project directory
          import(join(__dirname, '..', 'config.json'))
            .then((loadedConfig) => {
              localConfig = loadedConfig.default || loadedConfig;
              merge(envConfig, localConfig);
            })
            .catch(() => {
              console.info('No local config.json found!');
            });
        });
    }
  }

  // .env handling via dotenv
  if (process.env['NEST_SERVER_CONFIG']) {
    try {
      const dotEnvConfig = JSON.parse(process.env['NEST_SERVER_CONFIG']);
      if (dotEnvConfig && Object.keys(dotEnvConfig).length > 0) {
        merge(envConfig, dotEnvConfig);
        console.info('NEST_SERVER_CONFIG used from .env');
      }
    } catch (e) {
      console.error('Error parsing NEST_SERVER_CONFIG from .env: ', e);
      console.error(
        'Maybe the JSON is invalid? Please check the value of NEST_SERVER_CONFIG in .env file (e.g. via https://jsonlint.com/)',
      );
    }
  }

  // Merge with environment variables
  const environmentObject = getEnvironmentObject();
  const environmentObjectKeyCount = Object.keys(environmentObject).length;
  if (environmentObjectKeyCount > 0) {
    merge(envConfig, environmentObject);
    console.info(
      `Environment object from the environment integrated into the configuration with ${environmentObjectKeyCount} keys`,
    );
  }

  console.info(`Configured for: ${envConfig.env}${env !== envConfig.env ? ` (requested: ${env})` : ''}`);
  return envConfig;
}

/**
 * Get environment object from environment variables
 */
export function getEnvironmentObject(options?: {
  prefix?: string;
  processEnv?: Record<string, boolean | number | string>;
}) {
  const config = {
    prefix: 'NSC__',
    processEnv: process.env,
    ...options,
  };
  const output = {};

  Object.entries(config.processEnv)
    .filter(([key]) => key.startsWith(config.prefix))
    .forEach(([key, value]) => {
      // Remove prefix from key
      const adjustedKey = key.slice(config.prefix?.length || 0);

      // Convert key to path
      const path = adjustedKey.split('__').map((part) =>
        part
          .split('_')
          .map((s, i) => (i === 0 ? s.toLowerCase() : s[0].toUpperCase() + s.slice(1).toLowerCase()))
          .join(''),
      );

      // Set value in output object
      let current = output;
      for (let i = 0; i < path.length; i++) {
        const segment = path[i];
        if (i === path.length - 1) {
          // value preparation
          if (value === 'true') {
            value = true;
          } else if (value === 'false') {
            value = false;
          } else if (!isNaN(Number(value))) {
            value = Number(value);
          }

          current[segment] = value;
        } else {
          current = current[segment] = current[segment] || {};
        }
      }
    });

  return output;
}

/**
 * Special merge function (e.g. for configurations)
 *
 * It acts like the merge function of lodash:
 * - Source objects are merged into the destination object
 * - Source objects are applied from left to right
 * - Subsequent sources overwrite property assignments of previous sources
 *
 * except that arrays are not merged but overwrite arrays of previous sources.
 *
 * @param {any} obj destination object
 * @param {any[]} sources source objects
 * @returns {any}
 */
export function merge(obj: Record<string, any>, ...sources: any[]): any {
  return _.mergeWith(obj, ...sources, (objValue: any, srcValue: any) => {
    if (Array.isArray(srcValue)) {
      return srcValue;
    }
  });
}

/**
 * Resolve nodemailer's `smtp.secure` flag, deriving it from the port when it was not set.
 *
 * ── The defect this exists for ─────────────────────────────────────────────────
 * `secure` does not mean "use encryption". It means "start the TLS handshake IMMEDIATELY, before
 * any SMTP conversation" — implicit TLS, which only port **465** speaks. Port 587 is the
 * submission port: the session opens in plaintext and is upgraded via STARTTLS, which nodemailer
 * does on its own with `secure: false`.
 *
 * Pairing the common default port 587 with `secure: true` therefore cannot work. Nodemailer sends
 * a TLS ClientHello, the server answers with an SMTP greeting, and OpenSSL reports
 * `wrong version number`. This framework's `production` profile shipped exactly that pairing —
 * port 587 by default, `secure` true unless explicitly disabled — so a deployment that configured
 * nothing beyond host and credentials could not send ANY mail.
 *
 * It stayed invisible because authentication mail is deliberately fire-and-forget: the send is not
 * awaited (it would leak whether an address exists), so the failure never reached a response. The
 * API answered 200, the operator saw success, and every password-reset mail died in transport with
 * only a log line. Found in production, not by a test.
 *
 * ── Why ONLY the two canonical values override ─────────────────────────────────
 * `secure` is not an independent setting. It is a CONSEQUENCE of the port: 465 negotiates TLS
 * immediately, everything else upgrades through STARTTLS. Letting the two be configured
 * independently is precisely what allowed the broken pairing to exist.
 *
 * Both obvious string rules have a silent wrong side:
 *
 *   `value !== 'false'`  — an unset or unknown value yields TRUE, paired with 587. The reported
 *                          outage.
 *   `value === 'true'`   — `1` or `yes` yields FALSE. On port 465 that is a plaintext handshake
 *                          against a TLS-only port: the same outage, mirrored.
 *
 * So only `'true'` and `'false'` override. Anything else — `1`, `yes`, a typo — falls back to the
 * port, which is the fact rather than a guess. No input value can produce a pair that cannot
 * connect, which is a stronger property than either rule had.
 *
 * The one behaviour change for a value that IS set: a non-canonical value on a non-465 port now
 * resolves to `false` where it used to be `true`. Every such combination was broken, so this fixes
 * rather than regresses — and `SMTP_SECURE=1` on 465, the case worth protecting, still resolves to
 * `true` via the port.
 *
 * An explicit `'true'` on 587 (or `'false'` on 465) is still honoured and still impossible; that is
 * deliberate, and `warnOnImpossibleSmtpTlsCombination()` reports it rather than overruling it.
 *
 * @param value - the raw `SMTP_SECURE` environment value, if any
 * @param port  - the resolved SMTP port
 * @returns whether nodemailer should open the connection with implicit TLS
 */
export function resolveSmtpSecure(value: string | undefined, port: number): boolean {
  const normalized = typeof value === 'string' ? value.trim().toLowerCase() : undefined;

  if (normalized === 'true') {
    return true;
  }
  if (normalized === 'false') {
    return false;
  }

  // Unset or non-canonical: 465 is the only port that speaks implicit TLS.
  return port === 465;
}

/**
 * Whether an SMTP port/TLS pair describes a connection that cannot succeed.
 *
 * `secure: true` off port 465 is the fatal one — a TLS handshake against a plaintext greeting.
 * `secure: false` ON 465 is its mirror and equally broken, just rarer.
 *
 * Reported rather than corrected: a deployment may legitimately run submission on a non-standard
 * port, and silently overriding an explicit setting is how the original defect became invisible in
 * the first place.
 */
export function isImpossibleSmtpTlsCombination(port: number, secure: boolean): boolean {
  if (!Number.isFinite(port)) {
    return false;
  }
  return secure ? port !== 465 : port === 465;
}
