import { Field, ObjectType } from '@nestjs/graphql';

import { Restricted } from '../../../common/decorators/restricted.decorator.js';
import { RoleEnum } from '../../../common/enums/role.enum.js';

/**
 * The current user's AI settings as they take effect (12.3.0+): the user's own choice where the server allows one,
 * else the server configuration. Answer of `GET/PUT /ai/settings`, `aiSettings` and `updateAiSettings`.
 */
@ObjectType({ description: "The current user's effective AI settings" })
@Restricted(RoleEnum.S_EVERYONE)
export class CoreAiSettings {
  /**
   * Whether MCP asks this user before a tool that needs confirmation (`destructive`, or `mutating` under
   * `ai.confirmation.mutating`). `false` works like a "bypass permissions" mode for this user's MCP clients.
   */
  @Field(() => Boolean, { description: 'Whether MCP asks before a tool that needs confirmation' })
  mcpConfirmation: boolean;

  /** Whether the server fixed {@link mcpConfirmation} (`ai.mcp.confirmation.enforced`), so the user cannot change it. */
  @Field(() => Boolean, { description: 'Whether the server fixed mcpConfirmation, so it cannot be changed' })
  mcpConfirmationEnforced: boolean;
}
