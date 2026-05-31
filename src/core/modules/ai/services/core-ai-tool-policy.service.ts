import { Inject, Injectable, Logger } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { Model } from 'mongoose';

import { CrudService } from '../../../common/services/crud.service';
import { CoreModelConstructor } from '../../../common/types/core-model-constructor.type';
import { AiToolPolicyDocument, CoreAiToolPolicy } from '../models/core-ai-tool-policy.model';

/** Mongoose injection token. */
export const AI_TOOL_POLICY_MODEL = 'AiToolPolicy';
/** DI token for the model constructor. */
export const AI_TOOL_POLICY_CLASS = 'AI_TOOL_POLICY_CLASS';

export interface AiToolPolicyDecision {
  /** Final decision: 'allow', 'deny' or 'ask'. */
  decision: 'allow' | 'ask' | 'deny';
  /** Human-readable reason — surfaced to the LLM (and the user via the gate). */
  reason?: string;
}

export interface AiToolPolicyEvalContext {
  /** Role names the caller has. */
  roles: string[];
  /** Tenant id (optional). */
  tenantId?: string;
  /** User id. */
  userId?: string;
}

/**
 * Fine-grained scoped permission rules against tool calls. See
 * {@link CoreAiToolPolicy} for the schema. The orchestrator consults this service
 * for every tool call — `deny` aborts the call, `ask` routes it through the
 * confirmation gate, `allow` lets it run. No matching policy → fall through to
 * the existing behaviour (tool.mutating + admin defaults decide).
 *
 * Override via `CoreModule.forRoot(env, { ai: { toolPolicyService } })`.
 */
@Injectable()
export class CoreAiToolPolicyService extends CrudService<CoreAiToolPolicy, CoreAiToolPolicy, CoreAiToolPolicy> {
  protected readonly logger = new Logger(CoreAiToolPolicyService.name);

  constructor(
    @InjectModel(AI_TOOL_POLICY_MODEL) protected override readonly mainDbModel: Model<AiToolPolicyDocument>,
    @Inject(AI_TOOL_POLICY_CLASS)
    protected override readonly mainModelConstructor: CoreModelConstructor<CoreAiToolPolicy>,
  ) {
    super();
  }

  /**
   * Resolve the effective decision for a tool call. Returns the FIRST matching
   * decision in this precedence order across all matching policies:
   *   `deny`  >  `ask`  >  `allow`
   * (so a deny anywhere always wins; an ask wins over an allow). Returns
   * `undefined` when no policy applies — the caller then falls back to the
   * existing behaviour.
   */
  async evaluate(
    tool: string,
    args: Record<string, any>,
    ctx: AiToolPolicyEvalContext,
  ): Promise<AiToolPolicyDecision | undefined> {
    if (!tool) {
      return undefined;
    }
    const refCandidates: { refId?: string; scope: string }[] = [
      { scope: 'tool' },
      ...(ctx.userId ? [{ refId: ctx.userId, scope: 'user' }] : []),
      ...(ctx.tenantId ? [{ refId: ctx.tenantId, scope: 'tenant' }] : []),
      ...ctx.roles.map((r) => ({ refId: r, scope: 'role' })),
    ];

    let policies: CoreAiToolPolicy[] = [];
    try {
      policies = await this.mainDbModel
        .find({
          $or: refCandidates.map((c) => ({ refId: c.refId ?? null, scope: c.scope })),
          enabled: { $ne: false },
          tool,
        })
        .lean<CoreAiToolPolicy[]>()
        .exec();
    } catch {
      return undefined;
    }
    if (!policies.length) {
      return undefined;
    }

    let denyDecision: AiToolPolicyDecision | undefined;
    let askDecision: AiToolPolicyDecision | undefined;
    let allowDecision: AiToolPolicyDecision | undefined;

    for (const policy of policies) {
      for (const rule of policy.rules || []) {
        if (!rule?.argument || !rule?.pattern || !rule?.action) {
          continue;
        }
        const value = args?.[rule.argument];
        if (value === undefined || value === null) {
          continue;
        }
        let re: RegExp;
        try {
          re = new RegExp(rule.pattern, rule.flags || '');
        } catch {
          continue;
        }
        if (!re.test(String(value))) {
          continue;
        }
        if (rule.action === 'deny') {
          denyDecision = { decision: 'deny', reason: rule.reason };
        } else if (rule.action === 'ask') {
          askDecision ??= { decision: 'ask', reason: rule.reason };
        } else if (rule.action === 'allow') {
          allowDecision ??= { decision: 'allow', reason: rule.reason };
        }
      }
    }
    return denyDecision ?? askDecision ?? allowDecision;
  }
}
