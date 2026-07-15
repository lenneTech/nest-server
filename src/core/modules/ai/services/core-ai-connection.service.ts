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
import { ErrorCode } from '../../error-code';
import { CoreAiConnectionCreateInput } from '../inputs/core-ai-connection-create.input';
import { CoreAiConnectionInput } from '../inputs/core-ai-connection.input';
import { ResolvedAiConnection } from '../interfaces/resolved-ai-connection.interface';
import { AiConnectionDocument, CoreAiConnection } from '../models/core-ai-connection.model';
import { LlmProviderFactory } from '../providers/llm-provider.factory';
import { AiCryptoService } from './ai-crypto.service';
import { CoreAiConnectionPreferenceService } from './core-ai-connection-preference.service';

import { AI_CONNECTION_CLASS, AI_CONNECTION_MODEL } from '../core-ai.constants';

/**
 * @deprecated Import from `../core-ai.constants` instead. Re-exported only so existing deep imports
 * keep working; the tokens are declared in an import-free leaf so no cycle can form around them
 * (SWC-safe — see core-ai.constants.ts).
 */
export { AI_CONNECTION_CLASS, AI_CONNECTION_MODEL } from '../core-ai.constants';

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
    // Optional: used to auto-detect capabilities (JSON / native tools) by probing the endpoint.
    @Optional() protected readonly providerFactory?: LlmProviderFactory,
  ) {
    super();
  }

  /**
   * One-time seeding: if no connections exist and `ai.defaultConnection` is
   * configured, create it as the default. Keeps the DB the source of truth while
   * offering a smooth bootstrap from config/env.
   */
  async onModuleInit(): Promise<void> {
    await this.seedDefaultConnection();
    await this.assertStoredKeysDecryptable();
  }

  /**
   * One-time seeding of `ai.defaultConnection`. Skips silently when no default
   * connection is configured, but warns when it is configured incompletely (so a
   * missing `AI_*` env var doesn't fail silently). No-op once any connection exists.
   */
  protected async seedDefaultConnection(): Promise<void> {
    const seed = ConfigService.get<Record<string, any>>('ai.defaultConnection');
    if (!seed) {
      return; // no default connection configured — normal
    }
    if (!seed.baseUrl || !seed.model || !seed.name) {
      this.logger.warn(
        `ai.defaultConnection seed skipped: incomplete config — need baseUrl, model and name ` +
          `(got baseUrl=${!!seed.baseUrl}, model=${!!seed.model}, name=${!!seed.name}). ` +
          `Set the missing AI_* env vars or create the connection via the admin UI.`,
      );
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
   * Best-effort boot self-check: detect connections whose stored API key can no
   * longer be decrypted (typically after the encryption secret was changed/rotated).
   * Logs a clear, actionable error per connection instead of letting prompts fail
   * deep inside the request later. Never throws — a check failure must not block boot.
   */
  protected async assertStoredKeysDecryptable(): Promise<void> {
    try {
      const docs = await this.mainDbModel
        .find({ apiKeyEncrypted: { $exists: true, $ne: '' } }, { apiKeyEncrypted: 1, name: 1 })
        .lean()
        .exec();
      const broken: string[] = [];
      for (const doc of docs as { _id: unknown; apiKeyEncrypted?: string; name?: string }[]) {
        try {
          this.aiCryptoService.decrypt(doc.apiKeyEncrypted ?? '');
        } catch {
          broken.push(doc.name || String(doc._id));
        }
      }
      if (broken.length) {
        this.logger.error(
          `AI connection API key(s) could not be decrypted (encryption secret changed or value corrupted): ` +
            `${broken.join(', ')}. Re-enter the API key for these connections — prompts using them will fail until fixed.`,
        );
      }
    } catch (err) {
      this.logger.warn(`AI key decryptability self-check skipped: ${(err as Error).message}`);
    }
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
    // Eager capability auto-detection (A): probe the endpoint when a capability flag
    // was left undefined. Best-effort — never fails the create (the lazy runtime path
    // re-tries on first prompt).
    if (this.providerFactory && (input.supportsJsonResponse === undefined || input.supportsNativeTools === undefined)) {
      await this.detectAndPersistCapabilities(created.id).catch(() => undefined);
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
   * Auto-detect capabilities (JSON / native tools) for flags the connection left
   * undefined, persist the detected booleans, and return the resolved connection
   * (with the decrypted key) reflecting them. Explicit flags are authoritative and
   * are never probed. Best effort: on a probe/transport failure nothing is persisted
   * (so it is retried later) and the connection is returned unchanged — undefined
   * flags then fall back to the safe emulated baseline for the current run.
   *
   * Used eagerly on create (A) and lazily by the orchestrator on first prompt (B);
   * also exposed for an explicit admin "detect" endpoint.
   */
  async detectAndPersistCapabilities(connectionId: string): Promise<ResolvedAiConnection> {
    const resolved = await this.resolve(connectionId);
    const needsCapabilities = resolved.supportsJsonResponse === undefined || resolved.supportsNativeTools === undefined;
    const needsContextWindow = resolved.contextWindow === undefined;
    if (!this.providerFactory || (!needsCapabilities && !needsContextWindow)) {
      return resolved;
    }

    let provider: {
      detectCapabilities?: () => Promise<{ jsonResponse?: boolean; nativeTools?: boolean }>;
      detectContextWindow?: () => Promise<number | undefined>;
    };
    try {
      provider = this.providerFactory.create(resolved);
    } catch (err) {
      this.logger.warn(`AI capability detection skipped for "${resolved.name}": ${(err as Error).message}`);
      return resolved;
    }

    const update: Record<string, boolean | number> = {};
    if (needsCapabilities && typeof provider.detectCapabilities === 'function') {
      try {
        const detected = await provider.detectCapabilities();
        if (resolved.supportsJsonResponse === undefined && typeof detected.jsonResponse === 'boolean') {
          update.supportsJsonResponse = detected.jsonResponse;
          resolved.supportsJsonResponse = detected.jsonResponse;
        }
        if (resolved.supportsNativeTools === undefined && typeof detected.nativeTools === 'boolean') {
          update.supportsNativeTools = detected.nativeTools;
          resolved.supportsNativeTools = detected.nativeTools;
        }
      } catch (err) {
        this.logger.warn(`AI capability detection failed for "${resolved.name}": ${(err as Error).message}`);
      }
    }
    if (needsContextWindow && typeof provider.detectContextWindow === 'function') {
      try {
        const window = await provider.detectContextWindow();
        if (typeof window === 'number' && window > 0) {
          update.contextWindow = window;
          resolved.contextWindow = window;
        }
      } catch (err) {
        this.logger.warn(`AI context-window detection failed for "${resolved.name}": ${(err as Error).message}`);
      }
    }
    if (Object.keys(update).length) {
      await this.mainDbModel.findByIdAndUpdate(connectionId, { $set: update }).exec();
      this.logger.log(`Auto-detected AI connection metadata for "${resolved.name}": ${JSON.stringify(update)}`);
    }
    return resolved;
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
      throw new NotFoundException(ErrorCode.AI_NO_CONNECTION);
    }
    if (doc.enabled === false) {
      throw new ServiceUnavailableException(ErrorCode.AI_CONNECTION_DISABLED);
    }

    return {
      apiKey: this.resolveApiKeyFromDoc(doc) ?? '',
      baseUrl: doc.baseUrl,
      contextWindow: doc.contextWindow,
      defaultMaxTokens: doc.defaultMaxTokens,
      defaultTemperature: doc.defaultTemperature,
      defaultUserMaxPeriod: doc.defaultUserMaxPeriod,
      defaultUserMaxTokens: doc.defaultUserMaxTokens,
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
