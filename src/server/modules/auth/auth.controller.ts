import { Controller } from '@nestjs/common';

import { ConfigService } from '../../../core/common/services/config.service';
import { CoreAuthController } from '../../../core/modules/auth/core-auth.controller';
import { AuthService } from './auth.service';

@Controller('auth')
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
