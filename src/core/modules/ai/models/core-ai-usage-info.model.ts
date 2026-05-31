import { Field, Int, ObjectType } from '@nestjs/graphql';

import { Restricted } from '../../../common/decorators/restricted.decorator';
import { RoleEnum } from '../../../common/enums/role.enum';

/**
 * Compact token-budget summary attached to every prompt response.
 *
 * Kept small on purpose: this prompt's token cost plus the remaining/used totals
 * and the reset time for the binding (user) scope. The full breakdown (user +
 * tenant scopes, prompts + tokens) is available via the `aiUsage` query / `GET /ai/usage`.
 */
@ObjectType({ description: 'Compact token-budget summary for a prompt response' })
@Restricted(RoleEnum.S_EVERYONE)
export class CoreAiBudgetSummary {
  /**
   * Effective token limit for the binding scope (resolution: user → tenant → LLM
   * context window → null = no limit). Frontends use this to drive a usage progress
   * bar; null/undefined = no limit → hide the bar.
   */
  @Field(() => Int, { description: 'Effective token limit (null = no limit)', nullable: true })
  maxTokens?: number;

  /** Tokens this prompt consumed. */
  @Field(() => Int, { description: 'Tokens consumed by this prompt', nullable: true })
  promptTokens?: number;

  /** Remaining tokens in the current period (null = unlimited). */
  @Field(() => Int, { description: 'Remaining tokens in the current period (null = unlimited)', nullable: true })
  remainingTokens?: number;

  /** When the current period resets (null = never). */
  @Field(() => Date, { description: 'When the current budget period resets (null = never)', nullable: true })
  resetAt?: Date;

  /**
   * Which scope yielded {@link maxTokens} ('user', 'tenant' or 'llm').
   */
  @Field(() => String, { description: "Which scope yielded the limit ('user', 'tenant' or 'llm')", nullable: true })
  scope?: string;

  /** Tokens used so far in the current period (user scope). */
  @Field(() => Int, { description: 'Tokens used so far in the current period', nullable: true })
  usedTokens?: number;
}

/**
 * Token/prompt usage for a single scope (user or tenant).
 */
@ObjectType({ description: 'AI usage for a single scope (user or tenant)' })
@Restricted(RoleEnum.S_EVERYONE)
export class CoreAiUsageScope {
  /** Maximum prompts per period (null = unlimited). */
  @Field(() => Int, { description: 'Maximum prompts per period (null = unlimited)', nullable: true })
  maxPrompts?: number;

  /** Maximum tokens per period (null = unlimited). */
  @Field(() => Int, { description: 'Maximum tokens per period (null = unlimited)', nullable: true })
  maxTokens?: number;

  /** Reset period ('day', 'month' or 'none'). */
  @Field(() => String, { description: "Reset period ('day', 'month', 'none')" })
  period: string;

  /** Remaining prompts (null = unlimited). */
  @Field(() => Int, { description: 'Remaining prompts (null = unlimited)', nullable: true })
  remainingPrompts?: number;

  /** Remaining tokens (null = unlimited). */
  @Field(() => Int, { description: 'Remaining tokens (null = unlimited)', nullable: true })
  remainingTokens?: number;

  /** When the period resets (null = never). */
  @Field(() => Date, { description: 'When the period resets (null = never)', nullable: true })
  resetAt?: Date;

  /** Scope id (user id or tenant id). */
  @Field(() => String, { description: 'Scope reference id', nullable: true })
  refId?: string;

  /** Scope name ('user' or 'tenant'). */
  @Field(() => String, { description: "Scope: 'user' or 'tenant'" })
  scope: string;

  /** Prompts used in the current period. */
  @Field(() => Int, { description: 'Prompts used in the current period' })
  usedPrompts: number;

  /** Tokens used in the current period. */
  @Field(() => Int, { description: 'Tokens used in the current period' })
  usedTokens: number;
}

/**
 * Full AI usage info: user scope plus the tenant scope when a tenant context exists.
 */
@ObjectType({ description: 'Full AI token usage for the current user (and tenant)' })
@Restricted(RoleEnum.S_EVERYONE)
export class CoreAiUsageInfo {
  /** Tenant-scope usage (present when a tenant context exists). */
  @Field(() => CoreAiUsageScope, { description: 'Tenant-scope usage', nullable: true })
  tenant?: CoreAiUsageScope;

  /** User-scope usage. */
  @Field(() => CoreAiUsageScope, { description: 'User-scope usage', nullable: true })
  user?: CoreAiUsageScope;
}
