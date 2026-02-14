import { DynamicModule, Module } from '@nestjs/common';
import { PATH_METADATA } from '@nestjs/common/constants';

import { RoleEnum } from '../../common/enums/role.enum';

import { CorePermissionsController } from './core-permissions.controller';
import { CorePermissionsService } from './core-permissions.service';
import type { IPermissions } from './interfaces/permissions.interface';

@Module({})
export class CorePermissionsModule {
  static forRoot(config: boolean | IPermissions): DynamicModule {
    const role = typeof config === 'object' && config.role !== undefined ? config.role : RoleEnum.ADMIN;

    const path = typeof config === 'object' && config.path ? config.path : 'permissions';

    // Apply role-based access control at the class level using Reflect.defineMetadata
    // instead of the @Roles() decorator because the role value is determined at runtime
    // from the configuration. RolesGuard reads this metadata to enforce access control.
    if (role !== false) {
      Reflect.defineMetadata('roles', [role], CorePermissionsController);
    }

    // Override the controller's @Controller() path with the configured path.
    // This allows users to serve the permissions report under a custom route (e.g. 'admin/permissions')
    // while keeping the default 'permissions' path when no custom path is specified.
    Reflect.defineMetadata(PATH_METADATA, path, CorePermissionsController);

    return {
      controllers: [CorePermissionsController],
      exports: [CorePermissionsService],
      module: CorePermissionsModule,
      providers: [{ provide: 'PERMISSIONS_PATH', useValue: path }, CorePermissionsService],
    };
  }
}
