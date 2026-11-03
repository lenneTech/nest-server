import { InputType } from '@nestjs/graphql';

import { Restricted } from '../../../common/decorators/restricted.decorator.js';
import { UnifiedField } from '../../../common/decorators/unified-field.decorator.js';
import { RoleEnum } from '../../../common/enums/role.enum.js';

/**
 * Changes to the current user's own AI settings (12.3.0+). A field left out stays as it is.
 */
@InputType({ description: "Changes to the current user's AI settings" })
@Restricted(RoleEnum.S_USER)
export class CoreAiSettingsInput {
  /**
   * Whether MCP asks before a tool that needs confirmation. Refused with 403 while the server enforces the setting
   * (`ai.mcp.confirmation.enforced`).
   */
  @UnifiedField({
    description: 'Whether MCP asks before a tool that needs confirmation',
    isOptional: true,
    roles: RoleEnum.S_USER,
    type: () => Boolean,
  })
  mcpConfirmation?: boolean = undefined;
}
