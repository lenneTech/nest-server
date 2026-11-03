import { ObjectType } from '@nestjs/graphql';
import { Schema as MongooseSchema, SchemaFactory } from '../../../common/persistence/mongo/mongoose-compat.js';
import type { Document } from 'mongoose';

import { Restricted } from '../../../common/decorators/restricted.decorator.js';
import { UnifiedField } from '../../../common/decorators/unified-field.decorator.js';
import { RoleEnum } from '../../../common/enums/role.enum.js';
import { CorePersistenceModel } from '../../../common/models/core-persistence.model.js';

export type AiUserSettingDocument = CoreAiUserSetting & Document;

/**
 * Personal AI settings of one user (12.3.0+), one record per user. Only what the user chose is stored; an unset
 * field follows the server configuration.
 *
 * Users read and change their own settings through `GET/PUT /ai/settings` and the `aiSettings` /
 * `updateAiSettings` operations, which answer with {@link CoreAiSettings} (the effective values), never with this
 * record — hence admin-only here.
 */
@MongooseSchema({ collection: 'aiUserSettings', timestamps: true })
@ObjectType({ description: 'Personal AI settings of one user' })
@Restricted(RoleEnum.ADMIN)
export class CoreAiUserSetting extends CorePersistenceModel {
  /**
   * Whether MCP asks this user before a tool that needs confirmation. Unset follows `ai.mcp.confirmation`; ignored
   * while that is `enforced`.
   */
  @UnifiedField({
    description: 'Whether MCP asks this user before a tool that needs confirmation (unset = server default)',
    isOptional: true,
    mongoose: true,
    roles: RoleEnum.ADMIN,
    type: () => Boolean,
  })
  mcpConfirmation?: boolean = undefined;

  /** The user the settings belong to. */
  @UnifiedField({
    description: 'The user the settings belong to',
    mongoose: { unique: true },
    roles: RoleEnum.ADMIN,
  })
  userId: string = undefined;
}

export const AiUserSettingSchema = SchemaFactory.createForClass(CoreAiUserSetting);
