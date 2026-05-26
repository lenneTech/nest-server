import { Injectable } from '@nestjs/common';

import { RoleEnum } from '../../../common/enums/role.enum';
import { AiToolContext, AiToolResult } from '../interfaces/ai-tool.interface';
import { AiTool } from './ai-tool.base';
import { AiToolRegistry } from './ai-tool.registry';

/**
 * Sentinel marker the orchestrator detects to short-circuit the loop with a
 * `pendingQuestion`. Tools never set this directly — only this built-in does.
 */
export const ASK_USER_QUESTION_SENTINEL = Symbol.for('@lenne.tech/nest-server/ai/ask-user-question');

/**
 * Built-in tool the model can call to pause the run and ask the end user for a
 * clarification (e.g. "did you mean A, B or C?") instead of guessing — important
 * because our target users are NOT prompt experts: a focused question often beats
 * a wrong action. The tool does not perform an action; the orchestrator detects the
 * sentinel return shape, breaks the loop, and surfaces the question on `CoreAiResponse.pendingQuestion`.
 *
 * After answering, the client sends the user's answer as the next prompt — no
 * special "answer" field is needed; the conversation continues naturally.
 *
 * Roles: `S_USER` (anyone can be asked). Not `mutating`/`destructive` (it is a
 * read-only interaction surface).
 */
@Injectable()
export class AskUserQuestionAiTool extends AiTool {
  readonly description =
    'Ask the end user a clarifying question before acting. Use ONLY when you genuinely cannot proceed without more information from the user; otherwise prefer using a tool to find the answer.';
  readonly name = 'ask_user_question';
  readonly parameters = {
    properties: {
      options: {
        description: 'Optional list of suggested answers ({label, value}) for a multiple-choice question.',
        items: {
          properties: {
            label: { type: 'string' },
            value: { type: 'string' },
          },
          required: ['label', 'value'],
          type: 'object',
        },
        type: 'array',
      },
      question: { description: 'The clarifying question to ask the user, in their language.', type: 'string' },
    },
    required: ['question'],
    type: 'object',
  };
  readonly roles = [RoleEnum.S_USER];

  constructor(registry: AiToolRegistry) {
    super(registry);
  }

  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  async execute(args: Record<string, any>, _context: AiToolContext): Promise<AiToolResult> {
    const question = typeof args?.question === 'string' ? args.question.trim() : '';
    if (!question) {
      return { message: 'question is required.', success: false };
    }
    const options = Array.isArray(args?.options)
      ? args.options
          .filter((o: any) => o && typeof o.value === 'string' && typeof o.label === 'string')
          .map((o: any) => ({ label: o.label, value: o.value }))
      : undefined;
    return {
      data: { [ASK_USER_QUESTION_SENTINEL as unknown as string]: true, options, question },
      success: true,
    };
  }
}
