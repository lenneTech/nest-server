import { Inject, Injectable } from '@nestjs/common';
import { InjectConnection, InjectModel } from '@nestjs/mongoose';
import { Connection, Model, Types } from 'mongoose';

import { RoleEnum } from '../../../common/enums/role.enum';
import { ServiceOptions } from '../../../common/interfaces/service-options.interface';
import { CrudService } from '../../../common/services/crud.service';
import { CoreModelConstructor } from '../../../common/types/core-model-constructor.type';
import { CoreAiConversationCreateInput } from '../inputs/core-ai-conversation-create.input';
import { CoreAiConversationInput } from '../inputs/core-ai-conversation.input';
import { AiConversationDocument, CoreAiConversation } from '../models/core-ai-conversation.model';

import { AI_CONVERSATION_CLASS, AI_CONVERSATION_MODEL } from '../core-ai.constants';

/**
 * @deprecated Import from `../core-ai.constants` instead. Re-exported only so existing deep imports
 * keep working; the tokens are declared in an import-free leaf so no cycle can form around them
 * (SWC-safe — see core-ai.constants.ts).
 */
export { AI_CONVERSATION_CLASS, AI_CONVERSATION_MODEL } from '../core-ai.constants';

/**
 * CRUD service for multi-turn {@link CoreAiConversation}s.
 *
 * `appendMessage()` adds a turn via `$push` (never round-trips the subdocument
 * array through `update()`). `findForCurrentUser()` is the shared owner-scoped
 * list used by both the REST controller and the GraphQL resolver.
 *
 * Ownership is enforced differently per operation shape:
 * - single-object `get`/`delete`: the controller/resolver pass
 *   `S_CREATOR`/`S_SELF`, evaluated against the loaded `dbObject`.
 * - list (`findForCurrentUser`): a list has no single `dbObject`, so the gate
 *   uses `S_USER` and ownership is scoped by the server-computed `createdBy`
 *   filterQuery plus the model's `securityCheck`.
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
    @InjectConnection() protected readonly connection: Connection,
  ) {
    super();
  }

  /**
   * List the AI conversations visible to the current user. By default — for
   * every user, admins included — this returns only the caller's own
   * conversations, newest first. An admin may opt in to the cross-user view
   * (every user's conversations) by passing `{ all: true }`; the flag is
   * ignored for non-admins, so it can never widen a regular user's scope.
   *
   * Each result carries its `createdBy` owner id. In the admin cross-user view
   * (`all: true`) each result additionally carries a resolved `createdByUser`
   * (`{ id, email, firstName, lastName, username }`) so the list is attributable
   * to named users; on a normal own-only fetch that lookup is skipped, since the
   * owner is the caller. The heavy `messages` subdocument array is excluded from
   * the list payload — fetch a single conversation via `get()` for the full
   * message history.
   *
   * Shared by the REST controller (`GET /ai/conversations`) and the GraphQL
   * resolver (`findAiConversations`) so both API surfaces enforce ownership
   * identically and cannot drift apart.
   *
   * A LIST operation has no single `dbObject`, so the per-document roles
   * `S_CREATOR` / `S_SELF` can never be satisfied at the operation level —
   * passing them rejected every non-admin with a 403 before ownership scoping
   * ran. The operation gate therefore uses `[S_USER]`; the server-computed
   * `createdBy` filterQuery and the model `securityCheck` scope the result to
   * the owner.
   */
  async findForCurrentUser(
    serviceOptions?: ServiceOptions,
    options?: { all?: boolean },
  ): Promise<CoreAiConversation[]> {
    const currentUser = serviceOptions?.currentUser;
    const isAdmin = !!currentUser?.roles?.includes(RoleEnum.ADMIN);
    // Default is own-only for everyone; only an admin may opt in to all users' conversations.
    const seeAll = isAdmin && options?.all === true;
    const filterQuery = seeAll ? {} : { createdBy: currentUser?.id };
    const conversations = await this.find(
      { filterQuery, queryOptions: { sort: { createdAt: -1 } } },
      { ...serviceOptions, roles: [RoleEnum.S_USER], select: '-messages' },
    );
    // Resolve creators to named users ONLY for the admin cross-user view — a normal
    // fetch returns just the caller's own conversations, so the owner is already known.
    if (seeAll && conversations.length) {
      await this.attachCreators(conversations);
    }
    return conversations;
  }

  /**
   * Attach a lightweight resolved creator (`{ id, email, firstName, lastName,
   * username }`) as `createdByUser` to each conversation, so an admin's
   * cross-user list is attributable to named users. Read-only lookup of
   * non-sensitive identity fields via the shared `User` model on the same
   * connection; fails soft (leaves `createdByUser` unset) when no `User` model is
   * registered. Never called on a normal own-only fetch.
   */
  protected async attachCreators(conversations: CoreAiConversation[]): Promise<void> {
    const ids = [
      ...new Set(
        conversations
          .map((conversation) => conversation.createdBy)
          .filter(Boolean)
          .map(String),
      ),
    ];
    if (!ids.length) {
      return;
    }
    let userModel: Model<any>;
    try {
      userModel = this.connection.model('User');
    } catch {
      // No `User` model registered on this connection (exotic setup) — skip attribution.
      return;
    }
    const users = await userModel
      .find({ _id: { $in: ids } })
      .select('email firstName lastName username')
      .lean()
      .exec();
    const byId = new Map(
      (users as any[]).map((user) => [
        String(user._id),
        {
          email: user.email,
          firstName: user.firstName,
          id: String(user._id),
          lastName: user.lastName,
          username: user.username,
        },
      ]),
    );
    for (const conversation of conversations) {
      conversation.createdByUser = byId.get(String(conversation.createdBy));
    }
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
