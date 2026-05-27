import { ForbiddenException, Inject, Injectable, Logger } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { Model } from 'mongoose';

import { ServiceOptions } from '../../../common/interfaces/service-options.interface';
import { RoleEnum } from '../../../common/enums/role.enum';
import { CrudService } from '../../../common/services/crud.service';
import { CoreModelConstructor } from '../../../common/types/core-model-constructor.type';
import { CoreAiPromptSnippetCreateInput } from '../inputs/core-ai-prompt-snippet-create.input';
import { CoreAiPromptSnippetInput } from '../inputs/core-ai-prompt-snippet.input';
import { AiPromptSnippetDocument, CoreAiPromptSnippet } from '../models/core-ai-prompt-snippet.model';

export const AI_PROMPT_SNIPPET_MODEL = 'AiPromptSnippet';
export const AI_PROMPT_SNIPPET_CLASS = 'AI_PROMPT_SNIPPET_CLASS';

const VALID_SCOPES = new Set(['global', 'tenant', 'user']);

/**
 * User-facing prompt snippet store. End users can author snippets for themselves,
 * for their tenant, or globally (admin-only). See {@link CoreAiPromptSnippet}.
 *
 * `find()` returns only snippets the caller is allowed to see (owner / tenant
 * member / global). `create()` / `update()` / `delete()` enforce that only the
 * owner can mutate a snippet (admins still pass via the standard admin pipeline).
 */
@Injectable()
export class CoreAiPromptSnippetService extends CrudService<
  CoreAiPromptSnippet,
  CoreAiPromptSnippetCreateInput,
  CoreAiPromptSnippetInput
> {
  protected readonly logger = new Logger(CoreAiPromptSnippetService.name);

  constructor(
    @InjectModel(AI_PROMPT_SNIPPET_MODEL) protected override readonly mainDbModel: Model<AiPromptSnippetDocument>,
    @Inject(AI_PROMPT_SNIPPET_CLASS)
    protected override readonly mainModelConstructor: CoreModelConstructor<CoreAiPromptSnippet>,
  ) {
    super();
  }

  override async create(
    input: CoreAiPromptSnippetCreateInput,
    serviceOptions: ServiceOptions = {},
  ): Promise<CoreAiPromptSnippet> {
    const user = serviceOptions?.currentUser;
    if (!user?.id) {
      throw new ForbiddenException('Sign in to create a snippet.');
    }
    const scope = (input.scope || 'user').toLowerCase();
    if (!VALID_SCOPES.has(scope)) {
      throw new ForbiddenException(`Invalid snippet scope "${scope}".`);
    }
    if (scope === 'global' && !(user.roles || []).includes(RoleEnum.ADMIN)) {
      throw new ForbiddenException('Only admins can create global snippets.');
    }
    const userTenantId = (user as any).tenantId || (user as any).currentTenantId || ((user as any).tenantIds || [])[0];
    const tenantId = scope === 'tenant' ? (userTenantId ? String(userTenantId) : undefined) : undefined;
    if (scope === 'tenant' && !tenantId) {
      throw new ForbiddenException('Cannot share a snippet with a tenant when no tenant context exists.');
    }

    // Run the standard create pipeline first (validation + per-input whitelist).
    // The ownerId/scope/tenantId are SYSTEM-OWNED — the input DTO deliberately
    // doesn't expose them, so `prepareInput` would strip them if we passed them
    // through `super.create(...)`. Persist them via a direct update afterwards,
    // then reload the row through the full pipeline so the response carries
    // every field (and `securityCheck` returns it to the owner).
    const created = await super.create(input as any, serviceOptions);
    await this.mainDbModel
      .updateOne({ _id: created.id }, { $set: { ownerId: String(user.id), scope, tenantId } })
      .exec();
    return this.get(created.id, serviceOptions);
  }

  override async update(
    id: string,
    input: CoreAiPromptSnippetInput,
    serviceOptions: ServiceOptions = {},
  ): Promise<CoreAiPromptSnippet> {
    await this.assertOwner(id, serviceOptions);
    // Strip read-only fields the client should never overwrite.
    const sanitized: Record<string, unknown> = { ...input };
    delete sanitized.ownerId;
    delete sanitized.tenantId;
    let scopeChange: null | { scope: string; tenantId?: string } = null;
    if (sanitized.scope) {
      const scope = String(sanitized.scope).toLowerCase();
      if (!VALID_SCOPES.has(scope)) {
        throw new ForbiddenException(`Invalid snippet scope "${scope}".`);
      }
      const user = serviceOptions?.currentUser;
      if (scope === 'global' && !(user?.roles || []).includes(RoleEnum.ADMIN)) {
        throw new ForbiddenException('Only admins can create global snippets.');
      }
      sanitized.scope = scope;
      let nextTenantId: string | undefined;
      if (scope === 'tenant') {
        const userTenantId =
          (user as any)?.tenantId || (user as any)?.currentTenantId || ((user as any)?.tenantIds || [])[0];
        nextTenantId = userTenantId ? String(userTenantId) : undefined;
        if (!nextTenantId) {
          throw new ForbiddenException('Cannot share a snippet with a tenant when no tenant context exists.');
        }
      }
      scopeChange = { scope, tenantId: nextTenantId };
    }
    // Persist user-editable fields via the standard pipeline (whitelist /
    // validation), then write the system-owned `tenantId` directly when the
    // scope changed — the input DTO doesn't expose `tenantId`, so it would be
    // stripped by `prepareInput` if passed through `super.update`.
    const updated = await super.update(id, sanitized as any, serviceOptions);
    if (scopeChange) {
      await this.mainDbModel.updateOne({ _id: id }, { $set: { tenantId: scopeChange.tenantId } }).exec();
      return this.get(id, serviceOptions);
    }
    return updated;
  }

  override async delete(id: string, serviceOptions: ServiceOptions = {}): Promise<CoreAiPromptSnippet> {
    await this.assertOwner(id, serviceOptions);
    return super.delete(id, serviceOptions);
  }

  /**
   * List snippets visible to the current user: own (any scope) + tenant snippets
   * of the user's tenant + every global snippet. Ordered by `order` asc then name.
   */
  async listVisible(serviceOptions: ServiceOptions = {}): Promise<CoreAiPromptSnippet[]> {
    const user = serviceOptions?.currentUser;
    if (!user?.id) {
      return [];
    }
    const tenantId = (user as any).tenantId || (user as any).currentTenantId || ((user as any).tenantIds || [])[0];
    const or: Record<string, unknown>[] = [{ ownerId: user.id }, { scope: 'global' }];
    if (tenantId) {
      or.push({ scope: 'tenant', tenantId: String(tenantId) });
    }
    try {
      const rows = await this.mainDbModel
        .find({ $or: or, enabled: { $ne: false } })
        .sort({ order: 1, name: 1 })
        .lean<CoreAiPromptSnippet[]>()
        .exec();
      return rows || [];
    } catch (err) {
      this.logger.warn(`Failed to list snippets: ${(err as Error).message}`);
      return [];
    }
  }

  /** Ensure the snippet at `id` is owned by the current user (or is admin). */
  protected async assertOwner(id: string, serviceOptions: ServiceOptions): Promise<void> {
    const user = serviceOptions?.currentUser;
    if (!user?.id) {
      throw new ForbiddenException('Sign in to modify a snippet.');
    }
    if ((user.roles || []).includes(RoleEnum.ADMIN)) {
      return;
    }
    try {
      const row = await this.mainDbModel.findById(id).lean<CoreAiPromptSnippet>().exec();
      if (!row) {
        throw new ForbiddenException(`Snippet ${id} not found.`);
      }
      if (row.ownerId !== user.id) {
        throw new ForbiddenException('Only the owner can modify this snippet.');
      }
    } catch (err) {
      if (err instanceof ForbiddenException) {
        throw err;
      }
      throw new ForbiddenException(`Could not verify snippet ownership: ${(err as Error).message}`);
    }
  }
}
