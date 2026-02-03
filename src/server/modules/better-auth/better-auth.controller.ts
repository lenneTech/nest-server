import { Controller, Optional } from '@nestjs/common';

import { Roles } from '../../../core/common/decorators/roles.decorator';
import { RoleEnum } from '../../../core/common/enums/role.enum';
import { ConfigService } from '../../../core/common/services/config.service';
import { CoreBetterAuthSignUpValidatorService } from '../../../core/modules/better-auth/core-better-auth-signup-validator.service';
import { CoreBetterAuthUserMapper } from '../../../core/modules/better-auth/core-better-auth-user.mapper';
import { CoreBetterAuthController } from '../../../core/modules/better-auth/core-better-auth.controller';
import { CoreBetterAuthService } from '../../../core/modules/better-auth/core-better-auth.service';

/**
 * Server BetterAuth REST Controller
 *
 * This controller extends CoreBetterAuthController and can be customized
 * for project-specific requirements (e.g., sending welcome emails,
 * custom validation, audit logging).
 *
 * @example
 * ```typescript
 * // Add custom behavior after sign-up
 * override async signUp(res: Response, input: BetterAuthSignUpInput) {
 *   const result = await super.signUp(res, input);
 *
 *   if (result.success && result.user) {
 *     await this.emailService.sendWelcomeEmail(result.user.email);
 *   }
 *
 *   return result;
 * }
 * ```
 */
@Controller('iam')
@Roles(RoleEnum.ADMIN)
export class BetterAuthController extends CoreBetterAuthController {
  constructor(
    protected override readonly betterAuthService: CoreBetterAuthService,
    protected override readonly userMapper: CoreBetterAuthUserMapper,
    protected override readonly configService: ConfigService,
    @Optional() signUpValidator?: CoreBetterAuthSignUpValidatorService,
  ) {
    super(betterAuthService, userMapper, configService, signUpValidator);
  }
}
