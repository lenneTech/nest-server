import { Module } from '@nestjs/common';

import { ClaudeCliProvider } from '../../../core/modules/ai/providers/claude-cli.provider';
import { LlmProviderFactory } from '../../../core/modules/ai/providers/llm-provider.factory';
import { UserModule } from '../user/user.module';
import { DeleteUserAiTool } from './tools/delete-user.tool';
import { FindUsersAiTool } from './tools/find-users.tool';
import { GetUserAiTool } from './tools/get-user.tool';
import { UpdateUserJobTitleAiTool } from './tools/update-user-job-title.tool';

/**
 * Registers the example AI tools.
 *
 * Each tool extends `AiTool` and self-registers in the global `AiToolRegistry`
 * on module init. The registry is provided globally by `CoreAiModule` (auto-
 * registered by `CoreModule` when an `ai` config block is present), so no extra
 * import is needed for it here — only `UserModule` for `UserService`.
 *
 * This is the reference implementation showing how a project adds (or overrides)
 * AI tools from its own module. It also demonstrates the opt-in registration of
 * the Claude Code CLI provider on the global {@link LlmProviderFactory}, so a
 * connection with `providerType: 'claude-cli'` can be used.
 */
@Module({
  imports: [UserModule],
  providers: [DeleteUserAiTool, FindUsersAiTool, GetUserAiTool, UpdateUserJobTitleAiTool],
})
export class AiToolsModule {
  constructor(protected readonly providerFactory: LlmProviderFactory) {
    // Opt-in: enable connections with providerType 'claude-cli' (Claude Code CLI backend).
    this.providerFactory.registerBuilder('claude-cli', (connection) => new ClaudeCliProvider(connection));
  }
}
