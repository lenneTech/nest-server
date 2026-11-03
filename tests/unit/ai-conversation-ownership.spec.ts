import { describe, expect, it } from 'vitest';

import { RoleEnum } from '../../src/core/common/enums/role.enum';
import { ConfigService } from '../../src/core/common/services/config.service';
import { ILlmProvider, LlmMessage, LlmResponse } from '../../src/core/modules/ai/interfaces/llm-provider.interface';
import { LlmProviderFactory } from '../../src/core/modules/ai/providers/llm-provider.factory';
import { CoreAiConversationService } from '../../src/core/modules/ai/services/core-ai-conversation.service';
import { CoreAiPromptBuilderService } from '../../src/core/modules/ai/services/core-ai-prompt-builder.service';
import { CoreAiService } from '../../src/core/modules/ai/services/core-ai.service';
import { AiToolRegistry } from '../../src/core/modules/ai/tools/ai-tool.registry';

/**
 * A prompt names the conversation it continues by `conversationId`. Only the conversation's owner may continue it:
 * a run with somebody else's id must neither read that history, nor write into it, nor use or store the tool grants
 * scoped to it — otherwise one user plants turns (and "remember my decision" grants) into another user's assistant,
 * whose next runs execute tools with the victim's rights.
 *
 * Two layers, each pinned here: `CoreAiConversationService.appendMessage()` refuses a write for anyone but the owner,
 * and `CoreAiService.prompt()` drops an id the caller does not own before the run starts. REST, the SSE stream and
 * GraphQL all enter through `prompt()`; `tests/ai.e2e-spec.ts` drives the three over HTTP.
 */

const USER_A = { id: '64b000000000000000000a01', roles: [RoleEnum.S_USER] };
const USER_B = { id: '64b000000000000000000b02', roles: [RoleEnum.S_USER] };
const ADMIN = { id: '64b000000000000000000c03', roles: [RoleEnum.ADMIN] };
const CONVERSATION_A = '64c000000000000000000a11';
const UNKNOWN_CONVERSATION = '64c000000000000000000f99';

interface StoredConversation {
  createdBy: string;
  id: string;
  messages: { content: string; createdAt?: Date; role: string }[];
}

/** In-memory stand-in for the conversation model's data store: the two calls the ownership path makes, recorded. */
function conversationStore(conversations: StoredConversation[]) {
  const byId = new Map(conversations.map((conversation) => [conversation.id, conversation]));
  const pushes: string[] = [];
  return {
    byId,
    pushes,
    store: {
      capabilities: {},
      async findById(id: string) {
        return byId.get(id) ?? null;
      },
      async findOne(where: { createdBy?: string; id?: string }) {
        const found = byId.get(where.id as string);
        return found && String(found.createdBy) === String(where.createdBy) ? found : null;
      },
      modelName: 'AiConversation',
      async pushToArray(id: string, field: string, items: unknown[], options: { slice?: number } = {}) {
        pushes.push(id);
        const found = byId.get(id);
        if (!found) {
          return;
        }
        found[field] = [...found[field], ...items];
        if (options.slice !== undefined) {
          found[field] = found[field].slice(options.slice);
        }
      },
    },
  };
}

function conversationService(conversations: StoredConversation[]) {
  const memory = conversationStore(conversations);
  const service = new CoreAiConversationService({} as any, CoreAiConversationService as any, {} as any);
  (service as any).explicitDataStore = memory.store;
  return { memory, service };
}

/** A provider that answers every call and records the messages it was given. */
function recordingProvider(seen: LlmMessage[][]): ILlmProvider {
  return {
    capabilities: { jsonResponse: false, nativeTools: false, systemPrompt: true },
    async chat(messages: LlmMessage[]): Promise<LlmResponse> {
      seen.push(messages);
      return {
        text: JSON.stringify({ final: 'answer' }),
        usage: { completionTokens: 1, promptTokens: 1, totalTokens: 2 },
      };
    },
    name: 'fake',
  };
}

function aiService(options: {
  conversations: CoreAiConversationService;
  grants?: any;
  provider: ILlmProvider;
  registry?: AiToolRegistry;
}) {
  const factory = new LlmProviderFactory();
  factory.registerBuilder('fake', () => options.provider);
  const connectionService = {
    resolve: async () => ({
      apiKey: '',
      baseUrl: 'http://fake',
      id: 'c1',
      model: 'm',
      name: 'F',
      providerType: 'fake',
    }),
  } as any;
  return new CoreAiService(
    connectionService,
    factory,
    options.registry ?? new AiToolRegistry(),
    new CoreAiPromptBuilderService(),
    undefined,
    options.conversations,
    undefined,
    undefined,
    undefined,
    options.grants,
  );
}

function conversationOfA(): StoredConversation {
  return {
    createdBy: USER_A.id,
    id: CONVERSATION_A,
    messages: [
      { content: 'secret question of A', role: 'user' },
      { content: 'secret answer for A', role: 'assistant' },
    ],
  };
}

describe('CoreAiConversationService.appendMessage — the owner check sits in the write', () => {
  /**
   * @regression   DEV-3922 — appendMessage() pushed into any conversation it was given, so a prompt with somebody
   *   else's conversationId wrote its turns into that user's history.
   * @seen-failing Replace the ownership check in appendMessage() in
   *   src/core/modules/ai/services/core-ai-conversation.service.ts — registered as mutation
   *   `ai-conversation-append-skips-owner-check` in tests/regression-mutations.json.
   */
  it('refuses to write into a conversation owned by another user', async () => {
    const { memory, service } = conversationService([conversationOfA()]);
    await service.appendMessage(CONVERSATION_A, { content: 'planted by B', role: 'user' }, USER_B.id);
    expect(memory.pushes).toEqual([]);
    expect(memory.byId.get(CONVERSATION_A)?.messages).toHaveLength(2);
  });

  it('writes for the owner', async () => {
    const { memory, service } = conversationService([conversationOfA()]);
    await service.appendMessage(CONVERSATION_A, { content: 'next question', role: 'user' }, USER_A.id);
    expect(memory.pushes).toEqual([CONVERSATION_A]);
    expect(memory.byId.get(CONVERSATION_A)?.messages.map((message) => message.content)).toEqual([
      'secret question of A',
      'secret answer for A',
      'next question',
    ]);
  });

  it.each([
    ['no owner', undefined],
    ['an empty owner', ''],
    ['a malformed owner id', 'u1'],
  ])('refuses to write with %s', async (_label, owner) => {
    const { memory, service } = conversationService([conversationOfA()]);
    await service.appendMessage(CONVERSATION_A, { content: 'anonymous', role: 'user' }, owner);
    expect(memory.pushes).toEqual([]);
  });

  it('writes nothing for an unknown or malformed conversation id', async () => {
    const { memory, service } = conversationService([conversationOfA()]);
    await service.appendMessage(UNKNOWN_CONVERSATION, { content: 'x', role: 'user' }, USER_A.id);
    await service.appendMessage('null', { content: 'x', role: 'user' }, USER_A.id);
    expect(memory.pushes).toEqual([]);
  });

  it('answers ownership with a refusal for anyone but the creator, admins included', async () => {
    const { service } = conversationService([conversationOfA()]);
    expect(await service.isOwnedBy(CONVERSATION_A, USER_A.id)).toBe(true);
    expect(await service.isOwnedBy(CONVERSATION_A, USER_B.id)).toBe(false);
    expect(await service.isOwnedBy(CONVERSATION_A, ADMIN.id)).toBe(false);
    expect(await service.isOwnedBy(UNKNOWN_CONVERSATION, USER_A.id)).toBe(false);
    expect(await service.isOwnedBy('', USER_A.id)).toBe(false);
  });
});

describe('CoreAiService.prompt — a conversation id the caller does not own is no conversation at all', () => {
  /**
   * @regression   DEV-3922 — prompt() kept a foreign conversationId for the whole run: the history read was refused,
   *   but the turn was written into the other user's conversation and its conversation-scoped tool grants applied.
   * @seen-failing Make scopeConversation() in src/core/modules/ai/services/core-ai.service.ts return the input
   *   unchanged — registered as mutation `ai-prompt-keeps-foreign-conversation` in tests/regression-mutations.json.
   */
  it("leaves another user's conversation untouched, reads none of it and echoes no conversation id", async () => {
    ConfigService.setConfig({ ai: { maxIterations: 3 } } as any, { reInit: true, warn: false });
    const seen: LlmMessage[][] = [];
    const { memory, service: conversations } = conversationService([conversationOfA()]);
    const response = await aiService({ conversations, provider: recordingProvider(seen) }).prompt(
      { conversationId: CONVERSATION_A, prompt: 'question of B' } as any,
      { currentUser: USER_B },
    );

    expect(response.text).toBe('answer');
    expect(response.conversationId).toBeUndefined();
    expect(memory.pushes).toEqual([]);
    expect(memory.byId.get(CONVERSATION_A)?.messages).toHaveLength(2);
    expect(JSON.stringify(seen)).not.toContain('secret');
  });

  it('treats an unknown conversation id exactly like a foreign one', async () => {
    ConfigService.setConfig({ ai: { maxIterations: 3 } } as any, { reInit: true, warn: false });
    const { memory, service: conversations } = conversationService([conversationOfA()]);
    const response = await aiService({ conversations, provider: recordingProvider([]) }).prompt(
      { conversationId: UNKNOWN_CONVERSATION, prompt: 'question' } as any,
      { currentUser: USER_B },
    );
    expect(response.conversationId).toBeUndefined();
    expect(memory.pushes).toEqual([]);
  });

  it('lets the owner continue the conversation: history in, both turns out, id echoed', async () => {
    ConfigService.setConfig({ ai: { maxIterations: 3 } } as any, { reInit: true, warn: false });
    const seen: LlmMessage[][] = [];
    const { memory, service: conversations } = conversationService([conversationOfA()]);
    const response = await aiService({ conversations, provider: recordingProvider(seen) }).prompt(
      { conversationId: CONVERSATION_A, prompt: 'follow-up of A' } as any,
      { currentUser: USER_A },
    );

    expect(response.conversationId).toBe(CONVERSATION_A);
    expect(JSON.stringify(seen)).toContain('secret question of A');
    expect(memory.byId.get(CONVERSATION_A)?.messages.map((message) => message.content)).toEqual([
      'secret question of A',
      'secret answer for A',
      'follow-up of A',
      'answer',
    ]);
  });

  it("does not let an admin continue another user's conversation either", async () => {
    ConfigService.setConfig({ ai: { maxIterations: 3 } } as any, { reInit: true, warn: false });
    const seen: LlmMessage[][] = [];
    const { memory, service: conversations } = conversationService([conversationOfA()]);
    const response = await aiService({ conversations, provider: recordingProvider(seen) }).prompt(
      { conversationId: CONVERSATION_A, prompt: 'admin question' } as any,
      { currentUser: ADMIN },
    );
    expect(response.conversationId).toBeUndefined();
    expect(memory.pushes).toEqual([]);
    expect(JSON.stringify(seen)).not.toContain('secret');
  });

  it("neither uses nor stores the conversation-scoped tool grants of another user's conversation", async () => {
    ConfigService.setConfig({ ai: { confirmation: { mutating: { default: true } }, maxIterations: 3 } } as any, {
      reInit: true,
      warn: false,
    });
    const lookups: { conversationId?: string }[] = [];
    const persisted: { refId: string; scope: string }[] = [];
    const grants = {
      findActiveGrant: async (_tool: string, scopes: { conversationId?: string }) => {
        lookups.push(scopes);
        return scopes.conversationId === CONVERSATION_A ? 'conversation' : undefined;
      },
      grant: async (_tool: string, scope: string, refId: string) => {
        persisted.push({ refId, scope });
      },
    };
    const executed: string[] = [];
    const registry = new AiToolRegistry();
    registry.register({
      description: 'create a record',
      execute: async () => {
        executed.push('create_x');
        return { success: true };
      },
      mutating: true,
      name: 'create_x',
      parameters: { properties: {}, type: 'object' },
      roles: [RoleEnum.S_USER],
    });
    const scripted = [
      JSON.stringify({ tool_calls: [{ arguments: {}, name: 'create_x' }] }),
      JSON.stringify({ final: 'done' }),
    ];
    let call = 0;
    const provider: ILlmProvider = {
      capabilities: { jsonResponse: false, nativeTools: false, systemPrompt: true },
      async chat() {
        return {
          text: scripted[Math.min(call++, scripted.length - 1)],
          usage: { completionTokens: 1, promptTokens: 1, totalTokens: 2 },
        };
      },
      name: 'fake',
    };
    const { service: conversations } = conversationService([conversationOfA()]);
    const service = aiService({ conversations, grants, provider, registry });

    // B's run: A's conversation grant would have skipped the confirmation — it must not apply.
    const response = await service.prompt({ conversationId: CONVERSATION_A, prompt: 'create x' } as any, {
      currentUser: USER_B,
    });
    expect(response.requiresConfirmation).toBe(true);
    expect(executed).toEqual([]);
    expect(lookups.every((scopes) => scopes.conversationId === undefined)).toBe(true);

    // B confirms with "remember for this conversation": nothing may be stored on A's conversation.
    call = 0;
    await service.prompt(
      { confirm: true, conversationId: CONVERSATION_A, prompt: 'create x', rememberDecision: 'conversation' } as any,
      { currentUser: USER_B },
    );
    expect(persisted.filter((grant) => grant.refId === CONVERSATION_A)).toEqual([]);
  });
});
