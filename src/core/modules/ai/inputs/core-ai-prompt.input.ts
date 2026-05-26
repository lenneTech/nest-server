import { InputType } from '@nestjs/graphql';
import { IsIn, IsString, MaxLength } from 'class-validator';

import { Restricted } from '../../../common/decorators/restricted.decorator';
import { UnifiedField } from '../../../common/decorators/unified-field.decorator';
import { RoleEnum } from '../../../common/enums/role.enum';
import { JSON } from '../../../common/scalars/json.scalar';

/**
 * Input for an AI prompt sent from the frontend.
 */
@InputType({ description: 'Input for an AI prompt', isAbstract: true })
@Restricted(RoleEnum.S_USER)
export class CoreAiPromptInput {
  /**
   * Optional id of the AI connection to use (defaults to the configured default).
   */
  @UnifiedField({
    description: 'Id of the AI connection to use (defaults to the configured default)',
    isOptional: true,
    roles: RoleEnum.S_USER,
  })
  connectionId?: string = undefined;

  /**
   * Confirm execution of destructive tool actions requested in a previous turn.
   */
  @UnifiedField({
    description: 'Confirm execution of destructive tool actions',
    isOptional: true,
    roles: RoleEnum.S_USER,
    type: () => Boolean,
  })
  confirm?: boolean = undefined;

  /**
   * Optional conversation id for multi-turn continuation.
   */
  @UnifiedField({
    description: 'Conversation id for multi-turn continuation',
    isOptional: true,
    roles: RoleEnum.S_USER,
  })
  conversationId?: string = undefined;

  /**
   * Optional structured context the frontend wants the assistant to consider.
   */
  @UnifiedField({
    description: 'Optional structured context for the assistant',
    isOptional: true,
    roles: RoleEnum.S_USER,
    type: () => JSON,
  })
  context?: Record<string, any> = undefined;

  /**
   * Optional client metadata giving the assistant more situational context, e.g.
   * current URL, previous navigation steps, console logs. Treated as UNTRUSTED
   * input (size-capped, clearly delimited) to limit prompt-injection risk.
   */
  @UnifiedField({
    description: 'Optional client metadata (current URL, navigation steps, console logs, …)',
    isOptional: true,
    roles: RoleEnum.S_USER,
    type: () => JSON,
  })
  metadata?: Record<string, any> = undefined;

  /**
   * Execution mode. `auto` (default) runs the reactive agent loop; `plan` first
   * produces a complete plan, validates ALL action permissions up front, and only
   * then executes (all-or-nothing).
   */
  @UnifiedField({
    description: "Execution mode: 'auto' (reactive loop) or 'plan' (validate all permissions, then execute atomically)",
    isOptional: true,
    roles: RoleEnum.S_USER,
    validator: () => [IsIn(['auto', 'plan'])],
  })
  mode?: string = undefined;

  /**
   * The user's prompt text.
   */
  @UnifiedField({
    description: 'The user prompt text',
    roles: RoleEnum.S_USER,
    // IsNotEmpty is auto-applied for required fields by @UnifiedField; only IsString
    // + MaxLength need to be declared here (the custom validator replaces built-ins).
    validator: () => [IsString(), MaxLength(50000)],
  })
  prompt: string = undefined;

  /**
   * Client override of the admin confirmation-for-mutating-actions default.
   * Ignored when the admin has enforced the policy.
   */
  @UnifiedField({
    description: 'Override the admin default for requiring confirmation of mutating actions (ignored when enforced)',
    isOptional: true,
    roles: RoleEnum.S_USER,
    type: () => Boolean,
  })
  requireConfirmation?: boolean = undefined;

  /**
   * When confirming a mutating action (`confirm: true`), persist the consent so the
   * user does not have to re-confirm the same tool next time. Scope: `'conversation'`
   * (this thread only), `'user'` (this user, all conversations), `'tenant'` (whole
   * tenant). Destructive tools are never grantable — they always confirm.
   */
  @UnifiedField({
    description: "Remember the confirmation as a grant: 'conversation', 'user' or 'tenant'",
    isOptional: true,
    roles: RoleEnum.S_USER,
  })
  rememberDecision?: string = undefined;

  /**
   * Named agent mode (admin-defined). Restricts the assistant to a curated tool set
   * and optional model/prompt override for this run (e.g. `'support'`, `'audit'`).
   * See {@link CoreAiMode}.
   */
  @UnifiedField({
    description: 'Named agent mode (admin-defined; restricts tools / prompts / model)',
    isOptional: true,
    roles: RoleEnum.S_USER,
  })
  agentMode?: string = undefined;
}
