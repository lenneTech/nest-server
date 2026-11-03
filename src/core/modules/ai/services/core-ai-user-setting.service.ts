import { ForbiddenException, Inject, Injectable, Logger } from '@nestjs/common';
import { InjectModel } from '../../../common/persistence/mongo/mongoose-compat.js';
import type { Model } from 'mongoose';

import { upsertRecord } from '../../../common/persistence/store-upsert.js';
import { CrudService } from '../../../common/services/crud.service.js';
import type { CoreModelConstructor } from '../../../common/types/core-model-constructor.type.js';
import { ErrorCode } from '../../error-code/index.js';
import { effectiveMcpConfirmation, mcpConfirmationPolicy } from '../helpers/ai-tool-authorization.helper.js';
import type { CoreAiSettingsInput } from '../inputs/core-ai-settings.input.js';
import { CoreAiSettings } from '../models/core-ai-settings.model.js';
import { AiUserSettingDocument, CoreAiUserSetting } from '../models/core-ai-user-setting.model.js';

import { AI_USER_SETTING_CLASS, AI_USER_SETTING_MODEL } from '../core-ai.constants.js';

/**
 * Personal AI settings (12.3.0+): what a user chose for themselves, combined with the server configuration into the
 * settings that take effect. Today that is whether MCP asks the user before a tool that needs confirmation
 * (`ai.mcp.confirmation`) — the user's own "bypass permissions" switch, unless the server enforces it.
 *
 * Reads and writes go through the routed store with the user id the caller passes; the endpoints pass the current
 * user's, so nobody reaches another user's settings.
 *
 * Override via `CoreModule.forRoot(env, { ai: { userSettingService } })`.
 */
@Injectable()
export class CoreAiUserSettingService extends CrudService<CoreAiUserSetting, CoreAiUserSetting, CoreAiUserSetting> {
  protected readonly logger = new Logger(CoreAiUserSettingService.name);

  constructor(
    @InjectModel(AI_USER_SETTING_MODEL) protected override readonly mainDbModel: Model<AiUserSettingDocument>,
    @Inject(AI_USER_SETTING_CLASS)
    protected override readonly mainModelConstructor: CoreModelConstructor<CoreAiUserSetting>,
  ) {
    super();
  }

  /**
   * The user's settings as they take effect.
   */
  async getSettings(userId: string | undefined): Promise<CoreAiSettings> {
    const policy = mcpConfirmationPolicy();
    const stored = userId ? await this.findForUser(userId) : undefined;
    const settings = new CoreAiSettings();
    settings.mcpConfirmation = effectiveMcpConfirmation(policy, stored?.mcpConfirmation);
    settings.mcpConfirmationEnforced = policy.enforced;
    return settings;
  }

  /**
   * Stores the user's choices and answers with the settings that take effect. A choice the server enforces is
   * refused with 403 (`AI_SETTING_ENFORCED`) rather than stored and ignored.
   */
  async updateSettings(userId: string, input: CoreAiSettingsInput): Promise<CoreAiSettings> {
    if (typeof input?.mcpConfirmation === 'boolean') {
      if (mcpConfirmationPolicy().enforced) {
        throw new ForbiddenException(ErrorCode.AI_SETTING_ENFORCED);
      }
      await upsertRecord(this.dataStore, { userId }, { mcpConfirmation: input.mcpConfirmation });
    }
    return this.getSettings(userId);
  }

  /**
   * Whether MCP asks this user before a tool that needs confirmation. When the stored choice cannot be read, it asks
   * — unless the policy is enforced, which needs no stored choice.
   */
  async mcpConfirmationFor(userId: string | undefined): Promise<boolean> {
    const policy = mcpConfirmationPolicy();
    if (policy.enforced || !userId) {
      return policy.default;
    }
    try {
      return effectiveMcpConfirmation(policy, (await this.findForUser(userId))?.mcpConfirmation);
    } catch (err) {
      this.logger.warn(`AI settings of user ${userId} could not be read, MCP asks: ${(err as Error).message}`);
      return true;
    }
  }

  /** The stored record of one user, if any. */
  protected async findForUser(userId: string): Promise<CoreAiUserSetting | undefined> {
    return ((await this.dataStore.findOne({ userId })) as CoreAiUserSetting | null) ?? undefined;
  }
}
