import { Controller } from '@nestjs/common';

import { Roles } from '../../../core/common/decorators/roles.decorator.js';
import { RoleEnum } from '../../../core/common/enums/role.enum.js';
import { ConfigService } from '../../../core/common/services/config.service.js';
import { CoreAuthController } from '../../../core/modules/auth/core-auth.controller.js';
import { AuthService } from './auth.service.js';

@Controller('auth')
@Roles(RoleEnum.ADMIN)
export class AuthController extends CoreAuthController {
  /**
   * Import project services
   */
  constructor(
    protected override readonly authService: AuthService,
    protected override readonly configService: ConfigService,
  ) {
    super(authService, configService);
  }
}
