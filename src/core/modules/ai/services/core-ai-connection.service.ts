import {
  Inject,
  Injectable,
  Logger,
  NotFoundException,
  OnModuleInit,
  Optional,
  ServiceUnavailableException,
} from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { Model } from 'mongoose';

import { ServiceOptions } from '../../../common/interfaces/service-options.interface';
import { CrudService } from '../../../common/services/crud.service';
import { ConfigService } from '../../../common/services/config.service';
import { CoreModelConstructor } from '../../../common/types/core-model-constructor.type';
import { CoreAiConnectionCreateInput } from '../inputs/core-ai-connection-create.input';
import { CoreAiConnectionInput } from '../inputs/core-ai-connection.input';
import { ResolvedAiConnection } from '../interfaces/resolved-ai-connection.interface';
import { AiConnectionDocument, CoreAiConnection } from '../models/core-ai-connection.model';
import { AiCryptoService } from './ai-crypto.service';
import { CoreAiConnectionPreferenceService } from './core-ai-connection-preference.service';

/**
 * Mongoose injection token for the AI connection model.
 */
export const AI_CONNECTION_MODEL = 'AiConnection';

/**
 * DI token for the AI connection model constructor (used by CrudService mapping).
 */
export const AI_CONNECTION_CLASS = 'AI_CONNECTION_CLASS';

/**
 * CRUD service for {@link CoreAiConnection} — the database-backed LLM
 * configuration. Admin-only (enforced by the model's `@Restricted(ADMIN)` plus
 * `@Roles(ADMIN)` on the resolver/controller).
 *
 * Responsibilities beyond plain CRUD:
 * - encrypts the plaintext `apiKey` on create/update and never returns it
 * - keeps the single `isDefault` connection unique
 * - {@link resolve} produces a runtime {@link ResolvedAiConnection} (with the
 *   decrypted key) for the orchestrator/provider factory
 * - optional one-time seeding of a default connection from config/env
 *
 * Extend this class in a project (and pass it via `CoreAiModule.forRoot({ connectionService })`)
 * to customize behaviour.
 */
@Injectable()
export class CoreAiConnectionService
  extends CrudService<CoreAiConnection, CoreAiConnectionCreateInput, CoreAiConnectionInput>
  implements OnModuleInit
{
  protected readonly logger = new Logger(CoreAiConnectionService.name);

  constructor(
    protected readonly aiCryptoService: AiCryptoService,
    @InjectModel(AI_CONNECTION_MODEL) protected override readonly mainDbModel: Model<AiConnectionDocument>,
    @Inject(AI_CONNECTION_CLASS)
    protected override readonly mainModelConstructor: CoreModelConstructor<CoreAiConnection>,
    // Optional: used only to clean up dangling preferences when a connection is deleted.
    @Optional() protected readonly preferenceService?: CoreAiConnectionPreferenceService,
  ) {
    super();
  }

  /**
   * One-time seeding: if no connections exist and `ai.defaultConnection` is
   * configured, create it as the default. Keeps the DB the source of truth while
   * offering a smooth bootstrap from config/env.
   */
  async onModuleInit(): Promise<void> {
    const seed = ConfigService.get<Record<string, any>>('ai.defaultConnection');
    if (!seed?.baseUrl || !seed?.model || !seed?.name) {
      return;
    }
    const count = await this.mainDbModel.countDocuments().exec();
    if (count > 0) {
      return;
    }
    const { apiKey, ...rest } = seed;
    // Direct model access: system-internal seeding without a user context, and we
    // must set the internal `apiKeyEncrypted` field which CrudService does not expose.
    await this.mainDbModel.create({
      ...rest,
      apiKeyEncrypted: apiKey ? this.aiCryptoService.encrypt(apiKey) : undefined,
      isDefault: true,
      providerType: rest.providerType || 'openai-compatible',
    });
    this.logger.log(`Seeded default AI connection "${seed.name}"`);
  }

  /**
   * Create a connection. Encrypts the optional plaintext `apiKey` and keeps the
   * default connection unique.
   */
  override async create(
    input: CoreAiConnectionCreateInput,
    serviceOptions?: ServiceOptions,
  ): Promise<CoreAiConnection> {
    const { apiKey, ...rest } = input;
    let created = await super.create(rest as CoreAiConnectionCreateInput, serviceOptions);
    if (input.isDefault) {
      await this.unsetOtherDefaults(created.id);
    }
    if (apiKey !== undefined) {
      await this.applyApiKey(created.id, apiKey);
      created = await this.get(created.id, serviceOptions);
    }
    return created;
  }

  /**
   * Update a connection. Patch semantics for `apiKey` (set/clear/leave) and keeps
   * the default connection unique.
   */
  override async update(
    id: string,
    input: CoreAiConnectionInput,
    serviceOptions?: ServiceOptions,
  ): Promise<CoreAiConnection> {
    const { apiKey, ...rest } = input;
    let updated = await super.update(id, rest as CoreAiConnectionInput, serviceOptions);
    if (input.isDefault) {
      await this.unsetOtherDefaults(id);
    }
    if (apiKey !== undefined) {
      await this.applyApiKey(id, apiKey);
      updated = await this.get(id, serviceOptions);
    }
    return updated;
  }

  /**
   * Delete a connection and clean up any tenant/user preferences that pointed to it
   * (avoids dangling preferences). The cleanup is best-effort and never fails the delete.
   */
  override async delete(id: string, serviceOptions?: ServiceOptions): Promise<CoreAiConnection> {
    const deleted = await super.delete(id, serviceOptions);
    if (this.preferenceService) {
      try {
        await this.preferenceService.deleteByConnectionId(id);
      } catch (err) {
        this.logger.warn(`Failed to clean up AI connection preferences for "${id}": ${(err as Error).message}`);
      }
    }
    return deleted;
  }

  /**
   * List all enabled connections with the fields the resolver needs (system-internal
   * lean read; never exposes the API key). Used for availability + default resolution.
   */
  async listUsable(): Promise<
    {
      enforced?: boolean;
      enforcedTenantIds?: string[];
      id: string;
      isDefault?: boolean;
      model?: string;
      name?: string;
      tenantIds?: string[];
    }[]
  > {
    const docs = await this.mainDbModel
      .find({ enabled: { $ne: false } })
      .select('enforced enforcedTenantIds isDefault model name tenantIds')
      .sort({ createdAt: 1 })
      .lean()
      .exec();
    return docs.map((doc) => ({
      enforced: doc.enforced,
      enforcedTenantIds: doc.enforcedTenantIds,
      id: String(doc._id),
      isDefault: doc.isDefault,
      model: doc.model,
      name: doc.name,
      tenantIds: doc.tenantIds,
    }));
  }

  /**
   * Resolve a connection to a runtime {@link ResolvedAiConnection} with the
   * decrypted API key. System-internal — never expose the result to clients.
   *
   * @param connectionId Specific connection, or undefined for the default / first enabled one.
   */
  async resolve(connectionId?: string): Promise<ResolvedAiConnection> {
    // Direct lean reads: system-internal resolution that must access the
    // encrypted key field, which CrudService strips from outputs.
    let doc = connectionId
      ? await this.mainDbModel.findById(connectionId).lean().exec()
      : await this.mainDbModel
          .findOne({ enabled: { $ne: false }, isDefault: true })
          .lean()
          .exec();

    if (!doc && !connectionId) {
      doc = await this.mainDbModel
        .findOne({ enabled: { $ne: false } })
        .sort({ createdAt: 1 })
        .lean()
        .exec();
    }

    if (!doc) {
      throw new NotFoundException('No usable AI connection configured');
    }
    if (doc.enabled === false) {
      throw new ServiceUnavailableException(`AI connection "${doc.name}" is disabled`);
    }

    return {
      apiKey: this.resolveApiKeyFromDoc(doc) ?? '',
      baseUrl: doc.baseUrl,
      defaultMaxTokens: doc.defaultMaxTokens,
      defaultTemperature: doc.defaultTemperature,
      id: String(doc._id),
      model: doc.model,
      name: doc.name,
      providerType: doc.providerType || 'openai-compatible',
      supportsJsonResponse: doc.supportsJsonResponse,
      supportsNativeTools: doc.supportsNativeTools,
    };
  }

  /**
   * Encrypt + store, clear, or leave the API key based on patch semantics.
   */
  protected async applyApiKey(id: string, apiKey: string): Promise<void> {
    if (apiKey === '') {
      await this.mainDbModel.findByIdAndUpdate(id, { $unset: { apiKeyEncrypted: 1 } }).exec();
    } else {
      await this.mainDbModel
        .findByIdAndUpdate(id, { $set: { apiKeyEncrypted: this.aiCryptoService.encrypt(apiKey) } })
        .exec();
    }
  }

  /**
   * Read the plaintext API key from an encrypted DB value, falling back to the
   * configured environment variable.
   */
  protected resolveApiKeyFromDoc(doc: Pick<CoreAiConnection, 'apiKeyEncrypted' | 'apiKeyEnv'>): string | undefined {
    if (doc?.apiKeyEncrypted) {
      return this.aiCryptoService.decrypt(doc.apiKeyEncrypted);
    }
    if (doc?.apiKeyEnv) {
      return process.env[doc.apiKeyEnv];
    }
    return undefined;
  }

  /**
   * Ensure only one connection is marked as default.
   */
  protected async unsetOtherDefaults(id: string): Promise<void> {
    await this.mainDbModel.updateMany({ _id: { $ne: id } }, { $set: { isDefault: false } }).exec();
  }
}
