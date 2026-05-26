import { InputType } from '@nestjs/graphql';
import { IsIn } from 'class-validator';

import { Restricted } from '../../../common/decorators/restricted.decorator';
import { UnifiedField } from '../../../common/decorators/unified-field.decorator';
import { RoleEnum } from '../../../common/enums/role.enum';

/**
 * Input to update an AI prompt template fragment (all fields optional).
 */
@InputType({ description: 'Input to update an AI prompt template fragment', isAbstract: true })
@Restricted(RoleEnum.ADMIN)
export class CoreAiPromptTemplateInput {
  @UnifiedField({
    description: "Capability scope: 'all', 'native' or 'emulated'",
    isOptional: true,
    roles: RoleEnum.ADMIN,
    validator: () => [IsIn(['all', 'emulated', 'native'])],
  })
  capability?: string = undefined;

  @UnifiedField({
    description: 'Fragment text (supports {{placeholders}})',
    isOptional: true,
    roles: RoleEnum.ADMIN,
  })
  content?: string = undefined;

  @UnifiedField({
    description: 'Admin-facing description of the fragment',
    isOptional: true,
    roles: RoleEnum.ADMIN,
  })
  description?: string = undefined;

  @UnifiedField({
    description: 'Whether the fragment is included in the prompt',
    isOptional: true,
    roles: RoleEnum.ADMIN,
    type: () => Boolean,
  })
  enabled?: boolean = undefined;

  @UnifiedField({
    description: "Logical prompt slot (e.g. 'base', 'permissions', 'anti_hallucination')",
    isOptional: true,
    roles: RoleEnum.ADMIN,
  })
  key?: string = undefined;

  @UnifiedField({
    description: "Locale (e.g. 'en', 'de'); empty = all languages",
    isOptional: true,
    roles: RoleEnum.ADMIN,
  })
  locale?: string = undefined;

  @UnifiedField({
    description: 'Assembly order (ascending)',
    isOptional: true,
    roles: RoleEnum.ADMIN,
    type: () => Number,
  })
  order?: number = undefined;
}
