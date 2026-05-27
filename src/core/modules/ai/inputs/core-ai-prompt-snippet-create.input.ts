import { InputType } from '@nestjs/graphql';

import { Restricted } from '../../../common/decorators/restricted.decorator';
import { UnifiedField } from '../../../common/decorators/unified-field.decorator';
import { CoreInput } from '../../../common/inputs/core-input.input';
import { RoleEnum } from '../../../common/enums/role.enum';

/**
 * Input for creating a {@link CoreAiPromptSnippet}. `ownerId`/`tenantId` are set
 * automatically by the service from the current user — never from the client.
 */
@InputType({ description: 'Input to create a user prompt snippet' })
@Restricted(RoleEnum.S_USER)
export class CoreAiPromptSnippetCreateInput extends CoreInput {
  @UnifiedField({ description: 'The snippet text', roles: RoleEnum.S_USER })
  content: string = undefined;

  @UnifiedField({ description: 'Description', isOptional: true, roles: RoleEnum.S_USER })
  description?: string = undefined;

  @UnifiedField({
    description: 'Whether the snippet is active',
    isOptional: true,
    roles: RoleEnum.S_USER,
    type: () => Boolean,
  })
  enabled?: boolean = undefined;

  @UnifiedField({ description: 'Icon hint', isOptional: true, roles: RoleEnum.S_USER })
  icon?: string = undefined;

  @UnifiedField({ description: 'Display label', roles: RoleEnum.S_USER })
  name: string = undefined;

  @UnifiedField({
    description: 'Sort order',
    isOptional: true,
    roles: RoleEnum.S_USER,
    type: () => Number,
  })
  order?: number = undefined;

  /** `'user'` (default) | `'tenant'` | `'global'`. `'global'` requires admin role. */
  @UnifiedField({
    description: "Visibility scope ('user', 'tenant' or 'global'; 'global' is admin-only)",
    isOptional: true,
    roles: RoleEnum.S_USER,
  })
  scope?: string = undefined;
}
