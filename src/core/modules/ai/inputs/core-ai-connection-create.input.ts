import { InputType } from '@nestjs/graphql';

import { Restricted } from '../../../common/decorators/restricted.decorator';
import { UnifiedField } from '../../../common/decorators/unified-field.decorator';
import { RoleEnum } from '../../../common/enums/role.enum';
import { CoreAiConnectionInput } from './core-ai-connection.input';

/**
 * Input to create a new AI connection. Makes `baseUrl`, `model` and `name`
 * required while inheriting the optional fields from {@link CoreAiConnectionInput}.
 */
@InputType({ description: 'Input to create a new AI connection', isAbstract: true })
@Restricted(RoleEnum.ADMIN)
export class CoreAiConnectionCreateInput extends CoreAiConnectionInput {
  @UnifiedField({
    description: 'Base URL of the OpenAI-compatible endpoint',
    roles: RoleEnum.ADMIN,
  })
  override baseUrl: string = undefined;

  @UnifiedField({
    description: 'Model id sent to the backend (e.g. gpt-oss-120b)',
    roles: RoleEnum.ADMIN,
  })
  override model: string = undefined;

  @UnifiedField({
    description: 'Human-readable connection name',
    roles: RoleEnum.ADMIN,
  })
  override name: string = undefined;
}
