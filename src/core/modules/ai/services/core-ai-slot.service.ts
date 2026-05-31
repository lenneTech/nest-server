import { ForbiddenException, Inject, Injectable, Logger } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { Model } from 'mongoose';

import { RoleEnum } from '../../../common/enums/role.enum';
import { ServiceOptions } from '../../../common/interfaces/service-options.interface';
import { CrudService } from '../../../common/services/crud.service';
import { RequestContext } from '../../../common/services/request-context.service';
import { CoreModelConstructor } from '../../../common/types/core-model-constructor.type';
import { CoreAiSlotCreateInput } from '../inputs/core-ai-slot-create.input';
import { CoreAiSlotUpdateInput } from '../inputs/core-ai-slot-update.input';
import { AiSlotDocument, CoreAiSlot } from '../models/core-ai-slot.model';

/** Mongoose injection token for the slot model. */
export const AI_SLOT_MODEL = 'AiSlot';

/** DI token for the slot model constructor. */
export const AI_SLOT_CLASS = 'AI_SLOT_CLASS';

/** A resolved prompt fragment ready for placeholder rendering + assembly. */
export interface ResolvedPromptFragment {
  capability?: string;
  content: string;
  key: string;
  order: number;
  scope?: string;
}

/**
 * A slot row enriched with system/override metadata, returned by
 * {@link CoreAiSlotService.listEffective} for the admin UI:
 *
 * - `isSystem: true` rows are framework defaults (no DB row) — virtual entries
 *   that exist purely so the UI can render them and let admins override.
 * - `isSystem: false` + `isOverride: true` rows override a system default for
 *   the current tenant (admin edited an existing system slot).
 * - `isSystem: false` + `isOverride: false` rows are custom tenant-only slots
 *   (admin created a new key that isn't a system default).
 *
 * `id` is missing on virtual system rows; UI shows "Bearbeiten" → creates an
 * override; "Zurücksetzen" deletes the override row; "Löschen" on a system
 * row creates a disabled override (soft-delete for that tenant);
 * "Wiederherstellen" deletes the disabled override; "Löschen" on a custom
 * row is a real delete.
 */
export interface EffectiveSlot extends ResolvedPromptFragment {
  capability?: string;
  description?: string;
  enabled: boolean;
  id?: string;
  /** True when a tenant-specific row overrides a system default. */
  isOverride: boolean;
  /** True for built-in framework defaults (no DB row). */
  isSystem: boolean;
  locale?: string;
  /** Key matching a built-in system default — only set on override rows. */
  systemKey?: string;
  tenantId?: string;
}

/**
 * Built-in framework default slots. Returned by {@link getSystemDefaultSlots};
 * the prompt builder + slot service both consume them. Extracted to a module
 * function so neither service has to depend on the other.
 *
 * Override via `ai.systemPrompt` (replaces the `base` slot content) or by
 * subclassing {@link CoreAiPromptBuilderService}.
 */
export function getSystemDefaultSlots(baseSystemPrompt?: string): ResolvedPromptFragment[] {
  const base =
    baseSystemPrompt ||
    'You are a helpful assistant integrated into a business application. ' +
      'Answer concisely and only use information you can obtain through the provided tools. ' +
      'Never invent data. If a request cannot be fulfilled with the available tools, say so.';
  return [
    { content: base, key: 'base', order: 10 },
    { content: 'System documentation:\n{{documentation}}', key: 'documentation', order: 20 },
    {
      content:
        'Your permissions and capabilities:\n' +
        '- roles: {{roles}}\n' +
        '- available tools (you may ONLY use these): {{tools}}\n' +
        'Never claim to perform an action you have no tool for, and never assume rights you do not have. ' +
        'Tools are executed with the current user permissions; the backend rejects anything beyond them.',
      key: 'permissions',
      order: 30,
    },
    {
      content:
        'Accuracy rules — follow strictly:\n' +
        '- NEVER invent, guess or assume data (ids, names, emails, numbers, dates, statuses).\n' +
        '- Use a tool to obtain any fact you are unsure about.\n' +
        "- If no available tool can provide the needed information, tell the user you don't have it " +
        'instead of fabricating an answer.\n' +
        '- Only report a value you actually received from a tool result.',
      key: 'anti_hallucination',
      order: 40,
    },
    {
      capability: 'native',
      content:
        'You can call the provided tools (native function calling). Available tools:\n{{toolCatalog}}\n' +
        'Call a tool whenever it is needed to obtain data or perform an action.',
      key: 'tool_catalog',
      order: 50,
    },
    {
      capability: 'emulated',
      content:
        'You can call backend tools to fetch or modify data. Available tools:\n{{toolCatalog}}\n\n' +
        'To call tools, respond with ONLY a JSON object (no prose, no markdown code fences):\n' +
        '{"tool_calls":[{"name":"<tool_name>","arguments":{ ... }}]}\n' +
        'You may request multiple tools at once. After emitting tool_calls, STOP and output nothing ' +
        'else — do NOT write the results yourself. The system will send the real results back in a ' +
        'message starting with "TOOL_RESULTS:"; only then continue.\n\n' +
        'CRITICAL: To perform any action you MUST emit a tool_calls request and wait for its ' +
        'TOOL_RESULTS. Never state in a final answer that you executed, performed, deleted, updated, ' +
        'or created anything unless you actually called the matching tool and received its results. ' +
        'If you have not called the tool yet, call it — do not claim success.',
      key: 'tool_protocol_emulated',
      order: 50,
    },
    {
      content:
        'PLAN MODE: Do NOT execute anything. Available tools:\n{{toolCatalog}}\n\n' +
        'Respond with ONLY a JSON object describing the COMPLETE ordered plan of tool calls needed to ' +
        'fulfil the request:\n' +
        '{"plan":[{"name":"<tool_name>","arguments":{ ... }}],"summary":"<short summary>"}\n' +
        'List every required step in order. If no tools are needed, return an empty plan array. ' +
        'Reply with valid JSON only — no prose, no markdown code fences.',
      key: 'plan_protocol',
      order: 55,
    },
    {
      capability: 'emulated',
      content:
        'When you have the final answer for the user, respond with ONLY a JSON object:\n' +
        '{"final":"<your natural language answer>","data": <optional structured data or null>}\n' +
        'Never mix tool_calls and final in the same response. Always reply with valid JSON only.',
      key: 'output_contract',
      order: 60,
    },
    {
      content:
        'Tool error handling: a tool result with "success": false includes an "error" object ' +
        '({ code, message, hint }). When that happens, do NOT pretend it worked. Read the hint, ' +
        'correct your arguments and retry if it is sensible, otherwise clearly explain the problem to ' +
        'the user in plain language.',
      key: 'error_guidance',
      order: 70,
    },
    { content: 'Learned guidance (avoid past mistakes):\n{{learnedHints}}', key: 'learned_hints', order: 80 },
  ];
}

/**
 * Tenant-scoped store of system-prompt slots. Ships built-in defaults via
 * {@link getSystemDefaultSlots} so the prompt works with zero DB rows. An
 * admin-stored row OVERRIDES the framework default for the same `key` within
 * the admin's tenant; custom keys add additional slots for that tenant.
 *
 * Tenancy enforcement:
 * - Every CRUD operation auto-sets / filters by the admin's tenant (via
 *   `RequestContext.getTenantId()` or `serviceOptions.currentUser.tenantId`).
 * - When multi-tenancy is OFF, `tenantId` stays undefined and slots are
 *   effectively system-wide for that deployment.
 *
 * Override this class via `CoreModule.forRoot(env, { ai: { slotService } })`.
 */
@Injectable()
export class CoreAiSlotService extends CrudService<CoreAiSlot, CoreAiSlotCreateInput, CoreAiSlotUpdateInput> {
  protected readonly logger = new Logger(CoreAiSlotService.name);

  constructor(
    @InjectModel(AI_SLOT_MODEL) protected override readonly mainDbModel: Model<AiSlotDocument>,
    @Inject(AI_SLOT_CLASS)
    protected override readonly mainModelConstructor: CoreModelConstructor<CoreAiSlot>,
  ) {
    super();
  }

  /**
   * Create or replace a slot for the current tenant. `tenantId` is set
   * system-side from the calling admin — it's NEVER taken from the client
   * input. **Idempotent by `(tenantId, key)`:** if an existing row for the
   * same tenant + key is found, it's UPDATED in place instead of creating
   * a duplicate. This makes "Override anlegen" / "Deaktivieren" safely
   * repeatable in the admin UI without leaking orphan rows.
   */
  override async create(input: CoreAiSlotCreateInput, serviceOptions: ServiceOptions = {}): Promise<CoreAiSlot> {
    this.assertAdmin(serviceOptions);
    const tenantId = this.tenantOf(serviceOptions);
    if (input?.key) {
      const existing = await this.mainDbModel
        .findOne({ key: input.key, tenantId: tenantId ?? { $in: [null, undefined] } })
        .lean<CoreAiSlot>()
        .exec();
      if (existing?.id || (existing as any)?._id) {
        const existingId = String(existing?.id || (existing as any)?._id);
        const updated = await super.update(existingId, input as any, serviceOptions);
        return this.decorateWithSystemFlags(updated);
      }
    }
    const created = await super.create(input as any, serviceOptions);
    await this.mainDbModel.updateOne({ _id: created.id }, { $set: { tenantId } }).exec();
    const reloaded = await this.get(created.id, serviceOptions);
    return this.decorateWithSystemFlags(reloaded);
  }

  /**
   * Annotate a freshly persisted slot with `isSystem` / `isOverride` flags so
   * the admin UI gets the same shape from `create`/`update` as from
   * `listEffective`. The flags are computed against the built-in system-default
   * key set: a row whose key matches a system default is an override
   * (`isOverride: true`); anything else is a custom tenant-only slot
   * (`isOverride: false`). DB rows are never `isSystem: true` — system
   * defaults are virtual.
   */
  protected decorateWithSystemFlags(slot: CoreAiSlot): CoreAiSlot {
    const systemKeys = new Set(getSystemDefaultSlots().map((d) => d.key));
    return Object.assign(slot, {
      isOverride: systemKeys.has(slot.key),
      isSystem: false,
      systemKey: systemKeys.has(slot.key) ? slot.key : undefined,
    });
  }

  /**
   * Update a slot. The slot must belong to the calling admin's tenant.
   * `tenantId` is never overwritten from the client input.
   */
  override async update(
    id: string,
    input: CoreAiSlotUpdateInput,
    serviceOptions: ServiceOptions = {},
  ): Promise<CoreAiSlot> {
    this.assertAdmin(serviceOptions);
    await this.assertSameTenant(id, serviceOptions);
    const sanitized: Record<string, unknown> = { ...input };
    delete sanitized.tenantId;
    const updated = await super.update(id, sanitized as any, serviceOptions);
    return this.decorateWithSystemFlags(updated);
  }

  /**
   * Delete a slot. The slot must belong to the calling admin's tenant.
   */
  override async delete(id: string, serviceOptions: ServiceOptions = {}): Promise<CoreAiSlot> {
    this.assertAdmin(serviceOptions);
    await this.assertSameTenant(id, serviceOptions);
    return super.delete(id, serviceOptions);
  }

  /**
   * Effective slots for the admin UI: the framework defaults overlaid by the
   * tenant's stored overrides + custom rows. Each entry carries
   * `isSystem` / `isOverride` flags so the UI can render the right action
   * (Bearbeiten / Zurücksetzen / Löschen / Wiederherstellen).
   */
  async listEffective(serviceOptions: ServiceOptions = {}): Promise<EffectiveSlot[]> {
    this.assertAdmin(serviceOptions);
    const tenantId = this.tenantOf(serviceOptions);
    const defaults = getSystemDefaultSlots();
    const defaultKeys = new Set(defaults.map((d) => d.key));

    let rows: CoreAiSlot[] = [];
    try {
      rows = await this.mainDbModel
        .find(tenantId ? { tenantId } : { $or: [{ tenantId: { $exists: false } }, { tenantId: null }] })
        .lean<CoreAiSlot[]>()
        .exec();
    } catch (err) {
      this.logger.warn(`listEffective failed to load rows: ${(err as Error).message}`);
      rows = [];
    }
    // Tenant-row index by `key` for quick lookup (one override per key — multiple
    // rows with the same key just take the most-recent).
    const byKey = new Map<string, CoreAiSlot>();
    for (const row of rows) {
      if (!row?.key) continue;
      byKey.set(row.key, row);
    }

    const out: EffectiveSlot[] = [];
    // 1. System defaults (with optional override applied)
    for (const def of defaults) {
      const override = byKey.get(def.key);
      if (override) {
        out.push({
          capability: override.capability ?? def.capability,
          content: override.content ?? def.content,
          description: override.description,
          enabled: override.enabled !== false,
          id: override.id,
          isOverride: true,
          isSystem: false,
          key: override.key,
          locale: override.locale,
          order: typeof override.order === 'number' ? override.order : def.order,
          scope: override.scope ?? def.scope,
          systemKey: def.key,
          tenantId: override.tenantId,
        });
      } else {
        out.push({
          capability: def.capability,
          content: def.content,
          enabled: true,
          isOverride: false,
          isSystem: true,
          key: def.key,
          order: def.order,
          scope: def.scope,
        });
      }
    }
    // 2. Custom tenant slots (keys NOT in the framework defaults)
    for (const row of rows) {
      if (!row?.key || defaultKeys.has(row.key)) continue;
      out.push({
        capability: row.capability,
        content: row.content,
        description: row.description,
        enabled: row.enabled !== false,
        id: row.id,
        isOverride: false,
        isSystem: false,
        key: row.key,
        locale: row.locale,
        order: typeof row.order === 'number' ? row.order : 100,
        scope: row.scope,
        tenantId: row.tenantId,
      });
    }
    return out.sort((a, b) => a.order - b.order);
  }

  /**
   * Reset a tenant override: delete the row that overrides a system default,
   * restoring the framework value. The slot must (a) belong to the tenant
   * and (b) match a system-default `key` — calling this on a custom slot
   * is rejected (use {@link delete} for that).
   *
   * Returns the now-effective slot for that key (a synthetic
   * `isSystem: true, isOverride: false` shape) so the caller can refresh its
   * UI without a second list call. The slot has no `id` because system
   * defaults are virtual rows (they live in code, not in the DB).
   */
  async resetSystemSlot(id: string, serviceOptions: ServiceOptions = {}): Promise<EffectiveSlot> {
    this.assertAdmin(serviceOptions);
    await this.assertSameTenant(id, serviceOptions);
    const row = await this.mainDbModel.findById(id).lean<CoreAiSlot>().exec();
    if (!row) {
      throw new ForbiddenException(`Slot ${id} not found.`);
    }
    const defaults = getSystemDefaultSlots();
    const fallback = defaults.find((d) => d.key === row.key);
    if (!fallback) {
      throw new ForbiddenException('Only system-slot overrides can be reset. Use delete for custom slots.');
    }
    await this.mainDbModel.deleteOne({ _id: id }).exec();
    return {
      capability: fallback.capability,
      content: fallback.content,
      enabled: true,
      isOverride: false,
      isSystem: true,
      key: fallback.key,
      order: fallback.order ?? 100,
      scope: fallback.scope,
      systemKey: fallback.key,
    };
  }

  /**
   * Resolve the effective, ordered prompt fragments for a run: the built-in
   * defaults overlaid by the current tenant's DB rows (key match, honoring
   * locale + capability + `scope`). Placeholders are NOT yet rendered — the
   * prompt builder does that.
   *
   * Tenant: pulled from `RequestContext.getTenantId()`. When undefined (no
   * multi-tenancy active), only rows without `tenantId` apply.
   */
  async resolveFragments(
    defaults: ResolvedPromptFragment[],
    options?: { capability?: string; locale?: string; scopes?: string[] },
  ): Promise<ResolvedPromptFragment[]> {
    const capability = options?.capability ?? 'all';
    const locale = options?.locale;
    const scopes = options?.scopes ?? [];
    const tenantId = RequestContext.getTenantId();

    // Start from the built-in defaults keyed by their slot.
    const byKey = new Map<string, ResolvedPromptFragment>();
    for (const def of defaults) {
      if (this.fragmentApplies(def.capability, capability) && this.scopeApplies(def.scope, scopes)) {
        byKey.set(def.key, { ...def });
      }
    }

    // Overlay DB rows (enabled only, current tenant only).
    let rows: CoreAiSlot[] = [];
    try {
      const tenantFilter = tenantId
        ? { tenantId: String(tenantId) }
        : { $or: [{ tenantId: { $exists: false } }, { tenantId: null }] };
      rows = await this.mainDbModel
        .find({ enabled: { $ne: false }, ...tenantFilter })
        .lean<CoreAiSlot[]>()
        .exec();
    } catch {
      rows = [];
    }
    // Also consider disabled overrides of system keys: they HIDE the default
    // for this tenant ("soft delete" the system slot).
    let disabled: CoreAiSlot[] = [];
    try {
      const tenantFilter = tenantId
        ? { tenantId: String(tenantId) }
        : { $or: [{ tenantId: { $exists: false } }, { tenantId: null }] };
      disabled = await this.mainDbModel
        .find({ enabled: false, ...tenantFilter })
        .lean<CoreAiSlot[]>()
        .exec();
    } catch {
      disabled = [];
    }

    const rank = (row: CoreAiSlot): number =>
      (row.locale && row.locale === locale ? 2 : row.locale ? 0 : 1) + (row.scope ? 4 : 0);
    const chosen = new Map<string, { rank: number; row: CoreAiSlot }>();
    for (const row of rows) {
      if (!row?.key || !row?.content) {
        continue;
      }
      if (row.locale && locale && row.locale !== locale) {
        continue;
      }
      if (!this.fragmentApplies(row.capability, capability)) {
        continue;
      }
      if (!this.scopeApplies(row.scope, scopes)) {
        continue;
      }
      const r = rank(row);
      const current = chosen.get(row.key);
      if (!current || r > current.rank) {
        chosen.set(row.key, { rank: r, row });
      }
    }
    for (const [key, { row }] of chosen) {
      byKey.set(key, {
        capability: row.capability,
        content: row.content,
        key,
        order: typeof row.order === 'number' ? row.order : (byKey.get(key)?.order ?? 100),
        scope: row.scope,
      });
    }
    // Soft-deleted system slots: remove them from the result for this tenant.
    for (const row of disabled) {
      if (row?.key && byKey.has(row.key)) {
        byKey.delete(row.key);
      }
    }

    return [...byKey.values()].filter((f) => f.content?.trim()).sort((a, b) => a.order - b.order);
  }

  /**
   * Throws when the slot at `id` doesn't belong to the calling admin's tenant.
   * Projects to `tenantId` only — cheaper than loading the full document just
   * to compare tenant ownership.
   */
  protected async assertSameTenant(id: string, serviceOptions: ServiceOptions): Promise<void> {
    const tenantId = this.tenantOf(serviceOptions);
    const row = await this.mainDbModel.findById(id, { tenantId: 1 }).lean<{ tenantId?: string }>().exec();
    if (!row) {
      throw new ForbiddenException(`Slot ${id} not found.`);
    }
    const rowTenant = row.tenantId ? String(row.tenantId) : undefined;
    const callerTenant = tenantId ? String(tenantId) : undefined;
    if (rowTenant !== callerTenant) {
      throw new ForbiddenException('Slot belongs to a different tenant.');
    }
  }

  /** Throws when the caller is not an admin. */
  protected assertAdmin(serviceOptions: ServiceOptions): void {
    const roles = serviceOptions?.currentUser?.roles || [];
    if (!roles.includes(RoleEnum.ADMIN)) {
      throw new ForbiddenException('Slot management requires admin role.');
    }
  }

  /**
   * Whether a slot's capability scope applies to the run's capability.
   * `undefined`/`'all'` always applies; otherwise must match exactly.
   */
  protected fragmentApplies(fragmentCapability: string | undefined, runCapability: string): boolean {
    if (!fragmentCapability || fragmentCapability === 'all') {
      return true;
    }
    return fragmentCapability === runCapability;
  }

  /**
   * Whether a slot's `scope` filter applies to the run's active scopes.
   * Empty/undefined scope always applies; otherwise the slot scope must equal
   * one of the active run scopes (exact-match — no patterns).
   */
  protected scopeApplies(fragmentScope: string | undefined, runScopes: string[]): boolean {
    if (!fragmentScope) {
      return true;
    }
    return runScopes.includes(fragmentScope);
  }

  /** Tenant id of the calling user (request context or user object). */
  protected tenantOf(serviceOptions: ServiceOptions): string | undefined {
    const ctx = RequestContext.getTenantId();
    if (ctx) return String(ctx);
    const user = serviceOptions?.currentUser as any;
    return user?.tenantId || user?.currentTenantId || user?.tenantIds?.[0];
  }
}
