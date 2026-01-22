import { Logger } from '@nestjs/common';

/**
 * Global registry to track RolesGuard registration across modules.
 *
 * This prevents duplicate registration when both CoreAuthModule (Legacy)
 * and CoreBetterAuthModule (IAM) are used in the same application.
 *
 * Multiple APP_GUARD registrations of the same guard would work but cause
 * unnecessary double validation on every request.
 */
export class RolesGuardRegistry {
  private static readonly logger = new Logger('RolesGuardRegistry');
  private static registered = false;
  private static registeredBy: null | string = null;

  /**
   * Check if RolesGuard has already been registered as a global guard.
   */
  static isRegistered(): boolean {
    return this.registered;
  }

  /**
   * Get which module registered the RolesGuard.
   */
  static getRegisteredBy(): null | string {
    return this.registeredBy;
  }

  /**
   * Mark RolesGuard as registered by a specific module.
   * Call this when adding RolesGuard as APP_GUARD.
   *
   * @param moduleName - Name of the module registering RolesGuard (for debugging)
   */
  static markRegistered(moduleName: string = 'Unknown'): void {
    if (this.registered) {
      this.logger.debug(
        `RolesGuard already registered by ${this.registeredBy}, skipping registration from ${moduleName}`,
      );
      return;
    }
    this.registered = true;
    this.registeredBy = moduleName;
    this.logger.debug(`RolesGuard registered globally by ${moduleName}`);
  }

  /**
   * Reset the registry state.
   * Used in tests to ensure clean state between test runs.
   */
  static reset(): void {
    this.registered = false;
    this.registeredBy = null;
  }
}
