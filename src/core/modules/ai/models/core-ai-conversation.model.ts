import { ObjectType } from '@nestjs/graphql';
import { Schema as MongooseSchema, SchemaFactory } from '@nestjs/mongoose';
import { Document, Schema } from 'mongoose';

import { Restricted } from '../../../common/decorators/restricted.decorator';
import { UnifiedField } from '../../../common/decorators/unified-field.decorator';
import { RoleEnum } from '../../../common/enums/role.enum';
import { CorePersistenceModel } from '../../../common/models/core-persistence.model';
import { JSON } from '../../../common/scalars/json.scalar';
import { CoreAiMessage } from './core-ai-message.model';

export type AiConversationDocument = CoreAiConversation & Document;

/**
 * A multi-turn AI conversation owned by a user.
 *
 * Messages are stored as a Mongoose Mixed subdocument array and only ever
 * appended via `$push` (never round-tripped through `update()` — see the
 * subdocument-array rule). Ownership is enforced by {@link securityCheck}:
 * only the creator (or an admin) may read a conversation.
 */
@MongooseSchema({ collection: 'aiConversations', timestamps: true })
@ObjectType({ description: 'A multi-turn AI conversation' })
@Restricted(RoleEnum.S_USER)
export class CoreAiConversation extends CorePersistenceModel {
  /**
   * Id of the AI connection used for this conversation.
   */
  @UnifiedField({
    description: 'Id of the AI connection used for this conversation',
    isOptional: true,
    mongoose: true,
    roles: RoleEnum.S_USER,
  })
  connectionId?: string = undefined;

  /**
   * Id of the user who created the conversation.
   */
  @UnifiedField({
    description: 'Id of the user who created the conversation',
    isOptional: true,
    mongoose: { index: true, ref: 'User', type: Schema.Types.ObjectId },
    roles: RoleEnum.S_USER,
    type: () => String,
  })
  createdBy?: string = undefined;

  /**
   * Resolved creator identity (`{ id, email, firstName, lastName, username }`),
   * attached at read time ONLY for an admin's cross-user list view (`all: true`)
   * so each conversation is attributable to a named user. Not persisted and left
   * unset on a normal own-only fetch, where the owner is the caller.
   */
  @UnifiedField({
    description:
      'Resolved creator identity (id, email, name) — set only in the admin cross-user list view, not persisted',
    gqlType: JSON,
    isOptional: true,
    roles: RoleEnum.S_USER,
    type: () => Object,
  })
  createdByUser?: Record<string, any> = undefined;

  /**
   * Conversation messages (appended via $push).
   */
  @UnifiedField({
    description: 'Conversation messages',
    isArray: true,
    isOptional: true,
    mongoose: { default: [], type: [Schema.Types.Mixed] },
    roles: RoleEnum.S_USER,
    type: () => CoreAiMessage,
  })
  messages?: CoreAiMessage[] = undefined;

  /**
   * Human-readable title.
   */
  @UnifiedField({
    description: 'Human-readable title',
    isOptional: true,
    mongoose: { trim: true },
    roles: RoleEnum.S_USER,
  })
  title?: string = undefined;

  /**
   * Ownership check: only the creator or an admin may read a conversation.
   */
  override securityCheck(user?: any, force?: boolean) {
    if (force) {
      return this;
    }
    if (user && (user.hasRole?.(RoleEnum.ADMIN) || (this.createdBy && String(this.createdBy) === String(user.id)))) {
      return this;
    }
    // Hide conversations owned by other users (filtered out of list responses).
    return undefined;
  }
}

export const AiConversationSchema = SchemaFactory.createForClass(CoreAiConversation);
