import { Field, ObjectType } from '@nestjs/graphql';
import { Schema as MongooseSchema, SchemaFactory } from '@nestjs/mongoose';
import { Document } from 'mongoose';

import { Restricted } from '../../../common/decorators/restricted.decorator';
import { UnifiedField } from '../../../common/decorators/unified-field.decorator';
import { RoleEnum } from '../../../common/enums/role.enum';
import { CorePersistenceModel } from '../../../common/models/core-persistence.model';
import { JSON } from '../../../common/scalars/json.scalar';

export type AiToolPolicyDocument = CoreAiToolPolicy & Document;

/**
 * A fine-grained allow/deny/ask rule against a tool's arguments. See
 * {@link CoreAiToolPolicy}.
 */
@ObjectType({ description: 'A scoped allow/deny/ask rule for a tool call' })
export class CoreAiToolPolicyRule {
  /** 'allow' (run without gate), 'deny' (refuse), or 'ask' (route through the confirmation gate). */
  @Field(() => String, { description: "Decision: 'allow', 'deny' or 'ask'" })
  action: string;

  /** Which argument key the pattern matches against (e.g. `sql`, `collection`). */
  @Field(() => String, { description: 'Argument key the pattern matches against' })
  argument: string;

  /** RegExp source matched against `String(arguments[argument])`. */
  @Field(() => String, { description: 'RegExp source matched against the argument value' })
  pattern: string;

  /** Optional flags for the RegExp (e.g. 'i'). */
  @Field(() => String, { description: 'Optional RegExp flags', nullable: true })
  flags?: string;

  /** Optional human-readable reason — surfaced as the deny/ask message. */
  @Field(() => String, { description: 'Optional human-readable reason', nullable: true })
  reason?: string;
}

/**
 * Admin-editable, fine-grained allow/deny/ask rules against tool calls. The
 * confirmation/permission model stays as-is on top — this layer ADDS extra
 * gating against the arguments of an otherwise-permitted call, without forcing
 * a project to wrap their tools in custom logic.
 *
 * Evaluation order per matching policy: every `deny` rule wins (immediately),
 * then `ask`, then `allow`. No matching rule → default = behave as before
 * (tool's own `mutating`/`destructive` flags decide).
 *
 * Scope chain: `tool` (always) optionally narrowed by `role`, `tenant` or
 * `user`. A more specific scope wins over a more generic one. Hints only ever
 * tighten or relax the confirmation gate; the underlying permission model
 * (`@Restricted`, `@Roles`, `authorize()`) is enforced regardless.
 */
@MongooseSchema({ collection: 'aiToolPolicies', timestamps: true })
@ObjectType({ description: 'Admin-editable scoped policy for a tool call' })
@Restricted(RoleEnum.ADMIN)
export class CoreAiToolPolicy extends CorePersistenceModel {
  /** Whether the policy is active. */
  @UnifiedField({
    description: 'Whether the policy is active',
    isOptional: true,
    mongoose: { default: true },
    roles: RoleEnum.ADMIN,
    type: () => Boolean,
  })
  enabled?: boolean = undefined;

  /** Admin-facing label for the policy (just for UX, never read by code). */
  @UnifiedField({
    description: 'Admin-facing label',
    isOptional: true,
    mongoose: true,
    roles: RoleEnum.ADMIN,
  })
  label?: string = undefined;

  /** Reference id for the scope: empty when scope is 'global' or 'tool'. */
  @UnifiedField({
    description: 'Reference id for the scope (user/tenant id or role name)',
    isOptional: true,
    mongoose: { index: true },
    roles: RoleEnum.ADMIN,
  })
  refId?: string = undefined;

  /** The rule set evaluated against the call's arguments. */
  @UnifiedField({
    description: 'Rule set',
    isOptional: true,
    mongoose: { default: [] },
    roles: RoleEnum.ADMIN,
    type: () => JSON,
  })
  rules?: { action: string; argument: string; flags?: string; pattern: string; reason?: string }[] = undefined;

  /** Scope: 'tool' (any user), 'role', 'tenant' or 'user'. */
  @UnifiedField({
    description: "Scope: 'tool', 'role', 'tenant' or 'user'",
    mongoose: { index: true },
    roles: RoleEnum.ADMIN,
  })
  scope: string = undefined;

  /** The tool name this policy applies to. */
  @UnifiedField({
    description: 'Tool name the policy applies to',
    mongoose: { index: true },
    roles: RoleEnum.ADMIN,
  })
  tool: string = undefined;
}

export const AiToolPolicySchema = SchemaFactory.createForClass(CoreAiToolPolicy);
AiToolPolicySchema.index({ scope: 1, refId: 1, tool: 1 });
