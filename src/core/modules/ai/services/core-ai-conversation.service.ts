import { Inject, Injectable } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { Model, Types } from 'mongoose';

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
  /** Maximum number of messages retained per conversation (capped on `$push`). */
  protected readonly maxRetainedMessages = 500;

  constructor(
    @InjectModel(AI_CONVERSATION_MODEL) protected override readonly mainDbModel: Model<AiConversationDocument>,
    @Inject(AI_CONVERSATION_CLASS)
    protected override readonly mainModelConstructor: CoreModelConstructor<CoreAiConversation>,
  ) {
    super();
  }

  /**
   * Append a message to a conversation via `$push` (system-internal; the user
   * already authorized the prompt that produced it). The array is capped at
   * {@link maxRetainedMessages} via `$slice` so a long-lived conversation cannot
   * grow unbounded.
   */
  async appendMessage(id: string, message: { content: string; createdAt?: Date; role: string }): Promise<void> {
    await this.mainDbModel
      .findByIdAndUpdate(id, {
        $push: {
          messages: {
            $each: [{ ...message, createdAt: message.createdAt ?? new Date() }],
            $slice: -this.maxRetainedMessages,
          },
        },
      })
      .exec();
  }

  /**
   * Load the most recent turns of a conversation as a lean, projected read for the
   * orchestrator's LLM context — avoids the full `process()` pipeline over the whole
   * subdocument array on every turn. Performs an explicit ownership check (creator or
   * admin) because the lean read bypasses the model's `securityCheck`.
   *
   * The `id` parameter is forwarded from `aiPrompt` input — a hostile or
   * misconfigured caller may pass an empty string, the literal strings `"null"`
   * / `"undefined"`, or anything that does not parse as a valid ObjectId. We
   * fail-soft to `[]` instead of letting Mongoose throw a BSON cast error; the
   * orchestrator then proceeds without prior history, which is the same
   * outcome as no conversationId at all. We deliberately do NOT 404 here
   * because this method is called from inside the prompt pipeline.
   *
   * @returns the last `limit` turns ({ content, role }), or `[]` if not found / not owned / invalid id.
   */
  async loadRecentMessages(
    id: string,
    currentUser: { id?: string; roles?: string[] } | undefined,
    limit = 20,
  ): Promise<{ content: string; role: string }[]> {
    if (!id || typeof id !== 'string' || !Types.ObjectId.isValid(id)) {
      return [];
    }
    const doc = await this.mainDbModel
      .findById(id, { createdBy: 1, messages: { $slice: -limit } })
      .lean()
      .exec();
    if (!doc) {
      return [];
    }
    const isOwner = currentUser?.id && String((doc as { createdBy?: unknown }).createdBy) === String(currentUser.id);
    const isAdmin = currentUser?.roles?.includes('admin');
    if (!isOwner && !isAdmin) {
      return [];
    }
    return ((doc as { messages?: { content: string; role: string }[] }).messages ?? []).map((m) => ({
      content: m.content,
      role: m.role,
    }));
  }
}
