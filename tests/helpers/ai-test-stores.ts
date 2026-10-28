import type { INestApplication } from '@nestjs/common';

import type { DataStore } from '../../src/core/common/persistence/data-store.interface';
import { getStoreToken } from '../../src/core/common/persistence/persistence.tokens';
import { RequestContext } from '../../src/core/common/services/request-context.service';

/**
 * The AI module's data as the application stores it — on MongoDB, or on the SQL source `database` routes the AI models
 * to (the `postgres` and `iam-sql-<engine>` projects). A suite reads, plants and removes records through these stores instead of a
 * MongoDB client of its own, so the same suite proves both databases.
 *
 * `system()` runs a callback as system work, outside every tenant scope: test fixtures span tenants, and the
 * interactions and slots are tenant-scoped.
 */
export function aiTestStores(app: INestApplication) {
  const store = (modelName: string) => app.get<DataStore<any>>(getStoreToken(modelName), { strict: false });
  return {
    budgetLimits: store('AiBudgetLimit'),
    connections: store('AiConnection'),
    conversations: store('AiConversation'),
    interactions: store('AiInteraction'),
    preferences: store('AiConnectionPreference'),
    promptHints: store('AiPromptHint'),
    prompts: store('AiPrompt'),
    slots: store('AiSlot'),
    system: <R>(fn: () => Promise<R>): Promise<R> => RequestContext.runWithBypassTenantGuard(fn),
  };
}
