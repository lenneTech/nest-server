import { SetMetadata } from '@nestjs/common';

/**
 * Roles checked by the RolesGuard
 */
export const Roles = (...roles: string[]) => SetMetadata('roles', roles);
