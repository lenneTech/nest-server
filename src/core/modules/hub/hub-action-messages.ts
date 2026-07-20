/**
 * Centralized admin-facing messages for the Hub's mutating actions.
 *
 * The Hub deliberately does NOT route these through the ErrorCode i18n catalog: that module is
 * OPTIONAL (a consumer project may not register it — e.g. `errorCode.autoRegister: false`), so the
 * Hub, which must stay self-contained, cannot hard-depend on it. It is also a single-admin operator
 * tool where a plain English message is the right level of detail — not something an end-user sees.
 *
 * Centralizing the strings here (instead of scattering literals across the action controller and
 * services) keeps the wording consistent and reusable, and gives a single place to review every
 * message the mutating-action surface can emit. See the Hub README ("Action errors").
 *
 * Pure, import-free data — safe to import from anywhere in the module.
 */
export const HubActionMessage = {
  /** Generic fallback when an action throws a non-Error value. */
  actionFailed: 'Action failed.',
  /** Delete file: the typed confirmation filename did not match the stored filename. */
  confirmationFilenameMismatch: 'Confirmation filename does not match.',
  /** Delete file: no confirmation filename was supplied. */
  confirmationFilenameRequired: 'Confirmation filename required.',
  /** Test mail: the EmailService is not wired into this app. */
  emailServiceUnavailable: 'EmailService is not available.',
  /** Delete file: no GridFS file with the given id. */
  fileNotFound: 'File not found.',
  /** Delete file: the id is not a valid ObjectId. */
  invalidFileId: 'Invalid file id.',
  /** Migrations action while the migrations panel is disabled. */
  migrationsDisabled: 'The migrations panel is disabled.',
  /** CSRF guard: the mutating request lacked the X-Hub-Request header. */
  missingHubRequestHeader: 'Missing X-Hub-Request header.',
  /** Any action that needs the Mongo connection while it is unavailable. */
  mongoUnavailable: 'No MongoDB connection is available.',
  /** Migrations action while no Mongo URI is configured. */
  mongoUriMissing: 'No MongoDB URI is configured.',
  /** Test mail: no recipient supplied. */
  recipientRequired: 'Recipient (to) required.',
  /** Clear-collector action with an unknown collector name. */
  unknownCollector: 'Unknown collector.',
  /** Cron action with an unknown sub-action (not start/stop/trigger). */
  unknownCronAction: 'Unknown cron action.',

  /** Confirm-guarded action: the typed keyword did not match the expected one. */
  confirmationKeywordMismatch: (expected: string): string => `Confirmation keyword mismatch (expected "${expected}").`,
  /** Test mail: the requested template is not in the inventory (allowlist). */
  unknownEmailTemplate: (name: string): string => `Unknown email template "${name}".`,
} as const;
