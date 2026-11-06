/**
 * The AI prompt list: chat vs. management (12.7.0, DEV-4126).
 *
 * `listVisible()` filtered `enabled: { $ne: false }` for every caller, so the management screen never saw a disabled
 * prompt: one saved with "enabled" switched off vanished and could no longer be edited or deleted. The chat keeps the
 * filter; the management list asks with `includeDisabled: true`. Visibility (own + the user's tenant) is the same.
 */
import { describe, expect, it, vi } from 'vitest';

import { CoreAiPromptService } from '../../src/core/modules/ai/services/core-ai-prompt.service';

function list(options?: { includeDisabled?: boolean }) {
  const find = vi.fn(async () => []);
  const service = { dataStore: { find }, logger: { warn: vi.fn() } };
  const user = { id: 'u1', roles: [], tenantId: 't1' };
  return {
    find,
    run: () => CoreAiPromptService.prototype.listVisible.call(service as any, { currentUser: user as any }, options),
  };
}

describe('CoreAiPromptService.listVisible()', () => {
  it('offers enabled prompts only by default — the chat selection', async () => {
    const { find, run } = list();
    await run();

    expect(find).toHaveBeenCalledWith(
      { $or: [{ ownerId: 'u1' }, { scope: 'tenant', tenantId: 't1' }], enabled: { $ne: false } },
      { sort: { name: 1, order: 1 } },
    );
  });

  /**
   * @regression   12.7.0 (DEV-4126) — the management list filtered disabled prompts like the chat, so a prompt saved
   *   with "enabled" off disappeared and could no longer be edited or deleted.
   * @seen-failing Ignore `includeDisabled` in listVisible() in src/core/modules/ai/services/core-ai-prompt.service.ts —
   *   registered as mutation `prompt-list-ignores-include-disabled` in tests/regression-mutations.json.
   */
  it('lists disabled prompts too with includeDisabled — the management screen, same visibility', async () => {
    const { find, run } = list({ includeDisabled: true });
    await run();

    expect(find).toHaveBeenCalledWith(
      { $or: [{ ownerId: 'u1' }, { scope: 'tenant', tenantId: 't1' }] },
      { sort: { name: 1, order: 1 } },
    );
  });
});
