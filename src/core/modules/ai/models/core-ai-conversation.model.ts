import { ObjectType } from '@nestjs/graphql';
import { Schema as MongooseSchema, SchemaFactory } from '@nestjs/mongoose';
import { Document, Schema } from 'mongoose';

import { Restricted } from '../../../common/decorators/restricted.decorator';
import { UnifiedField } from '../../../common/decorators/unified-field.decorator';
import { RoleEnum } from '../../../common/enums/role.enum';
import { CorePersistenceModel } from '../../../common/models/core-persistence.model';
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
    if (user && (user.hasRole?.(RoleEnum.ADMIN) || (this.createdBy && String(this.createdBy) === user.id))) {
      return this;
    }
    // Hide conversations owned by other users (filtered out of list responses).
    return undefined;
  }
}

export const AiConversationSchema = SchemaFactory.createForClass(CoreAiConversation);
