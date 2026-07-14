import { Inject, Injectable, Logger } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { Model } from 'mongoose';

import { CrudService } from '../../../common/services/crud.service';
import { CoreModelConstructor } from '../../../common/types/core-model-constructor.type';
import { AiToolGrantDocument, CoreAiToolGrant } from '../models/core-ai-tool-grant.model';

import { AI_TOOL_GRANT_CLASS, AI_TOOL_GRANT_MODEL } from '../core-ai.constants';

/**
 * @deprecated Import from `../core-ai.constants` instead. Re-exported only so existing deep imports
 * keep working; the tokens are declared in an import-free leaf so no cycle can form around them
 * (SWC-safe — see core-ai.constants.ts).
 */
export { AI_TOOL_GRANT_CLASS, AI_TOOL_GRANT_MODEL } from '../core-ai.constants';

/** Scope of a persisted permission decision. */
export type AiToolGrantScope = 'conversation' | 'tenant' | 'user';

/**
 * Persistent permission decisions ("remember my choice") so end users do not have
 * to re-confirm the same mutating action repeatedly. See {@link CoreAiToolGrant}
 * for the schema and security model — grants only ever skip the confirmation gate,
 * they never relax the permission system itself.
 *
 * Override via `CoreModule.forRoot(env, { ai: { toolGrantService } })`.
 */
@Injectable()
export class CoreAiToolGrantService extends CrudService<CoreAiToolGrant, CoreAiToolGrant, CoreAiToolGrant> {
  protected readonly logger = new Logger(CoreAiToolGrantService.name);

  constructor(
    @InjectModel(AI_TOOL_GRANT_MODEL) protected override readonly mainDbModel: Model<AiToolGrantDocument>,
    @Inject(AI_TOOL_GRANT_CLASS)
    protected override readonly mainModelConstructor: CoreModelConstructor<CoreAiToolGrant>,
  ) {
    super();
  }

  /**
   * Whether any active, non-expired grant exists in the given scope chain that
   * allows the tool. Scope chain is evaluated in order: a hit at any level wins.
   * Returns the matched scope (for logging/UX), or `undefined` when no grant applies.
   */
  async findActiveGrant(
    tool: string,
    scopes: { conversationId?: string; tenantId?: string; userId?: string },
  ): Promise<AiToolGrantScope | undefined> {
    if (!tool) {
      return undefined;
    }
    const candidates: { refId: string; scope: AiToolGrantScope }[] = [];
    if (scopes.conversationId) candidates.push({ refId: scopes.conversationId, scope: 'conversation' });
    if (scopes.userId) candidates.push({ refId: scopes.userId, scope: 'user' });
    if (scopes.tenantId) candidates.push({ refId: scopes.tenantId, scope: 'tenant' });
    if (!candidates.length) {
      return undefined;
    }
    const now = new Date();
    for (const c of candidates) {
      try {
        const grant = await this.mainDbModel
          .findOne({
            $or: [{ expiresAt: { $exists: false } }, { expiresAt: null }, { expiresAt: { $gt: now } }],
            decision: { $ne: 'deny' },
            enabled: { $ne: false },
            refId: c.refId,
            scope: c.scope,
            tool,
          })
          .lean<CoreAiToolGrant>()
          .exec();
        if (grant) {
          return c.scope;
        }
      } catch {
        // best-effort
      }
    }
    return undefined;
  }

  /**
   * Persist (or refresh) a grant for the given scope. Idempotent — upserts on
   * the unique (scope, refId, tool) compound index.
   */
  async grant(tool: string, scope: AiToolGrantScope, refId: string, options?: { expiresAt?: Date }): Promise<void> {
    if (!tool || !refId) {
      return;
    }
    try {
      await this.mainDbModel
        .updateOne(
          { refId, scope, tool },
          {
            $set: {
              decision: 'allow',
              enabled: true,
              expiresAt: options?.expiresAt ?? null,
            },
            $setOnInsert: { refId, scope, tool },
          },
          { upsert: true },
        )
        .exec();
    } catch (err) {
      this.logger.warn(`Could not persist tool grant (${scope}:${refId}:${tool}): ${(err as Error).message}`);
    }
  }
}
