import { HttpException, HttpStatus, Inject, Injectable } from '@nestjs/common';
import { InjectConnection, InjectModel } from '@nestjs/mongoose';
import { Connection, Model } from 'mongoose';

import { ConfigService } from '../../../common/services/config.service';
import { CrudService } from '../../../common/services/crud.service';
import { CoreModelConstructor } from '../../../common/types/core-model-constructor.type';
import { ErrorCode } from '../../error-code';
import { CoreAiBudgetLimitCreateInput } from '../inputs/core-ai-budget-limit-create.input';
import { CoreAiBudgetLimitInput } from '../inputs/core-ai-budget-limit.input';
import { AiBudgetLimitDocument, CoreAiBudgetLimit } from '../models/core-ai-budget-limit.model';
import { CoreAiBudgetSummary, CoreAiUsageInfo, CoreAiUsageScope } from '../models/core-ai-usage-info.model';

/** Mongoose injection token for the budget-limit model. */
export const AI_BUDGET_LIMIT_MODEL = 'AiBudgetLimit';
/** DI token for the budget-limit model constructor. */
export const AI_BUDGET_LIMIT_CLASS = 'AI_BUDGET_LIMIT_CLASS';

/** Resolved effective limit for a scope. */
export interface ResolvedAiBudgetLimit {
  maxPrompts?: number;
  maxTokens?: number;
  period: string;
}

/** Usage counters for a scope in the current period. */
export interface AiBudgetUsage {
  resetAt: Date | null;
  usedPrompts: number;
  usedTokens: number;
}

/**
 * Token/prompt budget service.
 *
 * - Admin CRUD of per-user / per-tenant limit overrides (`aiBudgetLimits`).
 * - {@link resolveLimit}: override → config default (`ai.budget.user|tenant`) → unlimited.
 * - {@link getUsage}: period usage via a read-only native count over `aiInteractions`.
 * - {@link assertWithinBudget}: blocks a run (HTTP 429) when a finite limit is hit.
 * - {@link getUsageInfo} / {@link buildSummary}: usage reporting for clients.
 *
 * All internal limits are optional — a missing/0 limit means unlimited (only the
 * LLM's own limit then applies).
 */
@Injectable()
export class CoreAiBudgetService extends CrudService<
  CoreAiBudgetLimit,
  CoreAiBudgetLimitCreateInput,
  CoreAiBudgetLimitInput
> {
  /** Collection holding per-run usage records (written by the audit service). */
  protected readonly interactionsCollection = 'aiInteractions';

  constructor(
    @InjectConnection() protected readonly connection: Connection,
    @InjectModel(AI_BUDGET_LIMIT_MODEL) protected override readonly mainDbModel: Model<AiBudgetLimitDocument>,
    @Inject(AI_BUDGET_LIMIT_CLASS)
    protected override readonly mainModelConstructor: CoreModelConstructor<CoreAiBudgetLimit>,
  ) {
    super();
  }

  /**
   * Resolve the effective limit for a scope: persisted override, else config default.
   */
  async resolveLimit(scope: 'tenant' | 'user', refId: string): Promise<ResolvedAiBudgetLimit> {
    const override = await this.mainDbModel.findOne({ refId, scope }).lean().exec();
    const cfg = ConfigService.get<{
      period?: string;
      tenant?: { maxPrompts?: number; maxTokens?: number };
      user?: { maxPrompts?: number; maxTokens?: number };
    }>('ai.budget');
    const defaults = scope === 'tenant' ? cfg?.tenant : cfg?.user;
    return {
      maxPrompts: override?.maxPrompts ?? defaults?.maxPrompts,
      maxTokens: override?.maxTokens ?? defaults?.maxTokens,
      period: override?.period || cfg?.period || 'day',
    };
  }

  /**
   * Count usage (prompts + tokens) for a scope in the current period.
   * Read-only native count over `aiInteractions` (allowed; bypasses tenant auto-scope
   * so explicit user/tenant filters are honored).
   */
  async getUsage(filter: { tenantId?: string; userId?: string }, period: string): Promise<AiBudgetUsage> {
    const periodStart = this.periodStart(period);
    const match: Record<string, any> = { createdAt: { $gte: periodStart } };
    if (filter.userId) {
      match.userId = filter.userId;
    }
    if (filter.tenantId) {
      match.tenantId = filter.tenantId;
    }
    const db = this.connection.db;
    if (!db) {
      return { resetAt: this.nextReset(period), usedPrompts: 0, usedTokens: 0 };
    }
    // Sum prompts + tokens server-side via aggregation so only the aggregate crosses
    // the wire (a per-prompt `.find().toArray()` would load every interaction doc into
    // the Node heap). Backed by the `{ userId|tenantId, createdAt }` compound indexes.
    const [agg] = await db
      .collection(this.interactionsCollection)
      .aggregate<{ usedPrompts: number; usedTokens: number }>([
        { $match: match },
        { $group: { _id: null, usedPrompts: { $sum: 1 }, usedTokens: { $sum: { $ifNull: ['$totalTokens', 0] } } } },
      ])
      .toArray();
    return { resetAt: this.nextReset(period), usedPrompts: agg?.usedPrompts ?? 0, usedTokens: agg?.usedTokens ?? 0 };
  }

  /**
   * Block the run with HTTP 429 if the user OR tenant has hit a finite limit.
   *
   * @param language Deprecated and unused — the error-code translation layer now
   *   localizes the 429 message. Kept for call-site backward compatibility.
   */
  async assertWithinBudget(userId?: string, tenantId?: string, language?: string): Promise<void> {
    for (const [scope, refId] of [
      ['user', userId],
      ['tenant', tenantId],
    ] as const) {
      if (!refId) {
        continue;
      }
      const limit = await this.resolveLimit(scope, refId);
      if (!this.finite(limit.maxTokens) && !this.finite(limit.maxPrompts)) {
        continue; // unlimited
      }
      const usage = await this.getUsage(scope === 'user' ? { userId: refId } : { tenantId: refId }, limit.period);
      if (this.exceeded(usage, limit)) {
        // Message is translated (de/en) by the error-code translation layer.
        void language;
        throw new HttpException(ErrorCode.AI_BUDGET_EXCEEDED, HttpStatus.TOO_MANY_REQUESTS);
      }
    }
  }

  /**
   * Full usage info for the current user (and tenant when present).
   */
  async getUsageInfo(userId?: string, tenantId?: string): Promise<CoreAiUsageInfo> {
    const info = new CoreAiUsageInfo();
    if (userId) {
      info.user = await this.buildScope('user', userId);
    }
    if (tenantId) {
      info.tenant = await this.buildScope('tenant', tenantId);
    }
    return info;
  }

  /**
   * Compact per-response summary for the user scope.
   */
  async buildSummary(
    userId: string | undefined,
    tenantId: string | undefined,
    promptTokens: number,
    llmContextWindow?: number,
  ): Promise<CoreAiBudgetSummary> {
    const summary = new CoreAiBudgetSummary();
    summary.promptTokens = promptTokens;
    if (!userId) {
      // Even with no user, expose the LLM context window so the frontend can render
      // a coarse usage bar.
      if (this.finite(llmContextWindow)) {
        summary.maxTokens = llmContextWindow;
        summary.scope = 'llm';
      }
      return summary;
    }
    const userLimit = await this.resolveLimit('user', userId);
    if (this.finite(userLimit.maxTokens) || this.finite(userLimit.maxPrompts)) {
      const usage = await this.getUsage({ userId }, userLimit.period);
      summary.usedTokens = usage.usedTokens;
      summary.remainingTokens = this.finite(userLimit.maxTokens)
        ? Math.max(0, (userLimit.maxTokens as number) - usage.usedTokens)
        : undefined;
      summary.resetAt = usage.resetAt ?? undefined;
      if (this.finite(userLimit.maxTokens)) {
        summary.maxTokens = userLimit.maxTokens;
        summary.scope = 'user';
      }
      return summary;
    }
    // Fall back to tenant limit.
    if (tenantId) {
      const tenantLimit = await this.resolveLimit('tenant', tenantId);
      if (this.finite(tenantLimit.maxTokens)) {
        const usage = await this.getUsage({ tenantId }, tenantLimit.period);
        summary.usedTokens = usage.usedTokens;
        summary.remainingTokens = Math.max(0, (tenantLimit.maxTokens as number) - usage.usedTokens);
        summary.resetAt = usage.resetAt ?? undefined;
        summary.maxTokens = tenantLimit.maxTokens;
        summary.scope = 'tenant';
        return summary;
      }
    }
    // Fall back to the LLM's context window (best coarse signal).
    if (this.finite(llmContextWindow)) {
      summary.maxTokens = llmContextWindow;
      summary.scope = 'llm';
    }
    return summary;
  }

  // ===================================================================================================================
  // Helpers
  // ===================================================================================================================

  protected async buildScope(scope: 'tenant' | 'user', refId: string): Promise<CoreAiUsageScope> {
    const limit = await this.resolveLimit(scope, refId);
    const usage = await this.getUsage(scope === 'user' ? { userId: refId } : { tenantId: refId }, limit.period);
    const result = new CoreAiUsageScope();
    result.maxPrompts = this.finite(limit.maxPrompts) ? limit.maxPrompts : undefined;
    result.maxTokens = this.finite(limit.maxTokens) ? limit.maxTokens : undefined;
    result.period = limit.period;
    result.refId = refId;
    result.remainingPrompts = this.finite(limit.maxPrompts)
      ? Math.max(0, (limit.maxPrompts as number) - usage.usedPrompts)
      : undefined;
    result.remainingTokens = this.finite(limit.maxTokens)
      ? Math.max(0, (limit.maxTokens as number) - usage.usedTokens)
      : undefined;
    result.resetAt = usage.resetAt ?? undefined;
    result.scope = scope;
    result.usedPrompts = usage.usedPrompts;
    result.usedTokens = usage.usedTokens;
    return result;
  }

  /** A limit value is "finite" (enforced) only when it is a positive number. */
  protected finite(value?: number): boolean {
    return typeof value === 'number' && value > 0;
  }

  protected exceeded(usage: AiBudgetUsage, limit: ResolvedAiBudgetLimit): boolean {
    return (
      (this.finite(limit.maxTokens) && usage.usedTokens >= (limit.maxTokens as number)) ||
      (this.finite(limit.maxPrompts) && usage.usedPrompts >= (limit.maxPrompts as number))
    );
  }

  /** Start of the current period. */
  protected periodStart(period: string): Date {
    const now = new Date();
    if (period === 'month') {
      return new Date(now.getFullYear(), now.getMonth(), 1, 0, 0, 0, 0);
    }
    if (period === 'none') {
      return new Date(0);
    }
    // 'day' (default)
    const start = new Date(now);
    start.setHours(0, 0, 0, 0);
    return start;
  }

  /** Next reset boundary (null for 'none'). */
  protected nextReset(period: string): Date | null {
    const now = new Date();
    if (period === 'month') {
      return new Date(now.getFullYear(), now.getMonth() + 1, 1, 0, 0, 0, 0);
    }
    if (period === 'none') {
      return null;
    }
    const next = new Date(now);
    next.setHours(0, 0, 0, 0);
    next.setDate(next.getDate() + 1);
    return next;
  }
}
