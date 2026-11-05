/**
 * The Hub config viewer's masker — since 12.5.0 the framework-wide `redactSecrets()`
 * (`common/helpers/redact-secrets.helper.ts`), which `GET /config` and the `ConfigService` debug output use too.
 *
 * Kept under its old name so no import path broke.
 */
export { redactSecrets as maskConfigDeep } from '../../../common/helpers/redact-secrets.helper.js';
