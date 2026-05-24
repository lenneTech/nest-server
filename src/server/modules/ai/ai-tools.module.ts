import { Module } from '@nestjs/common';

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
 * AI tools from its own module.
 */
@Module({
  imports: [UserModule],
  providers: [DeleteUserAiTool, FindUsersAiTool, GetUserAiTool, UpdateUserJobTitleAiTool],
})
export class AiToolsModule {}
