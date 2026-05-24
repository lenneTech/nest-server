import { Inject, Injectable } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { Model } from 'mongoose';

import { CrudService } from '../../../common/services/crud.service';
import { CoreModelConstructor } from '../../../common/types/core-model-constructor.type';
import { CoreAiConversationCreateInput } from '../inputs/core-ai-conversation-create.input';
import { CoreAiConversationInput } from '../inputs/core-ai-conversation.input';
import { AiConversationDocument, CoreAiConversation } from '../models/core-ai-conversation.model';

/**
 * Mongoose injection token for the AI conversation model.
 */
export const AI_CONVERSATION_MODEL = 'AiConversation';

/**
 * DI token for the AI conversation model constructor.
 */
export const AI_CONVERSATION_CLASS = 'AI_CONVERSATION_CLASS';

/**
 * CRUD service for multi-turn {@link CoreAiConversation}s.
 *
 * `appendMessage()` adds a turn via `$push` (never round-trips the subdocument
 * array through `update()`). Ownership is enforced by the model's `securityCheck`
 * and by the resolver/controller passing `S_CREATOR`/`S_SELF` roles.
 */
@Injectable()
export class CoreAiConversationService extends CrudService<
  CoreAiConversation,
  CoreAiConversationCreateInput,
  CoreAiConversationInput
> {
  constructor(
    @InjectModel(AI_CONVERSATION_MODEL) protected override readonly mainDbModel: Model<AiConversationDocument>,
    @Inject(AI_CONVERSATION_CLASS)
    protected override readonly mainModelConstructor: CoreModelConstructor<CoreAiConversation>,
  ) {
    super();
  }

  /**
   * Append a message to a conversation via `$push` (system-internal; the user
   * already authorized the prompt that produced it).
   */
  async appendMessage(id: string, message: { content: string; createdAt?: Date; role: string }): Promise<void> {
    await this.mainDbModel
      .findByIdAndUpdate(id, { $push: { messages: { ...message, createdAt: message.createdAt ?? new Date() } } })
      .exec();
  }
}
